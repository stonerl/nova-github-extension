// lib/github.js
// GitHub REST access: list fetching with ETag revalidation,
// rate-limit tracking, and comment retrieval with disk caching.

const { loadConfig, isConfiguredRepo } = require("./config.js");
const {
  saveCache,
  loadCache,
  saveCommentCache,
  loadCommentCache,
  savePullDetails,
  loadPullDetails,
} = require("./cache.js");
const notify = require("./notify.js");

let isRateLimited = false;
const rateLimitLogged = new Set();

// Budget tracking from x-ratelimit headers: when the shared budget is
// nearly exhausted, auto-refresh steps aside until the reset so other
// tools using the same token keep theirs.
const BUDGET_SKIP_THRESHOLD = 100;
let budgetRemaining = null;
let budgetResetAt = 0;

function resetRateLimitFlag() {
  isRateLimited = false;
}

// True when list/hydration fetches should step aside: an active
// rate-limit hold, or the shared budget is nearly exhausted. Hydration
// (one request per PR) must honor the same gate as list fetches or a
// budget-low cycle would still burn N per-PR requests.
function shouldDeferNetwork() {
  if (isRateLimited) return true;
  return (
    budgetRemaining !== null &&
    budgetRemaining < BUDGET_SKIP_THRESHOLD &&
    budgetResetAt > Date.now()
  );
}

function applyRateLimit(resetAt, retryAfterSeconds, label, status = null) {
  isRateLimited = true;

  // Log once per label per limit window — hundreds of in-flight
  // requests can hit the limit simultaneously, and a console flood
  // can lock up Nova's UI bridge.
  if (!rateLimitLogged.has(label)) {
    rateLimitLogged.add(label);
    const statusDesc = status ? ` (HTTP ${status})` : "";
    let resetDesc;
    if (resetAt > 0) {
      const minutesLeft = Math.max(
        0,
        Math.round((resetAt * 1000 - Date.now()) / 60_000),
      );
      resetDesc = `resets at ${new Date(resetAt * 1000).toLocaleTimeString()} (~${minutesLeft >= 1 ? `${minutesLeft}m` : "<1m"} from now)`;
    } else {
      resetDesc = "pausing for at least 60s";
    }
    console.warn(`[GitHub] ${label} rate-limited${statusDesc}; ${resetDesc}`);
    notify.rateLimitError();
  }

  let ms;
  if (retryAfterSeconds > 0) {
    ms = retryAfterSeconds * 1000;
  } else if (resetAt > 0) {
    ms = resetAt * 1000 - Date.now();
  } else {
    ms = 0;
  }
  // Never release instantly: secondary-limit responses often lack
  // reset headers, and an instant release lets still-in-flight
  // requests re-trigger the limit in a loop.
  ms = Math.max(ms, 60_000);
  setTimeout(() => {
    isRateLimited = false;
    rateLimitLogged.delete(label);
    console.log(`[GitHub] ${label} rate limit released; resuming requests`);
  }, ms);
}

const dataStore = {
  cache: {},
  etags: {},
  pullDetails: {},
  _inFlight: {},
  // Whether the most recent fetchState(state) came from the network (or
  // a server-confirmed 304) — cache fallbacks (budget-low, rate-limit,
  // network error) record false so freshness marking can skip them.
  lastLive: {},

  // PR detail memos are per-process; the disk copy (per repo) is seeded
  // into `pullDetails` once per repo per process so a fresh session
  // doesn't re-fetch details for unchanged PRs.
  _pullDetailsSeeded: {},

  seedPullDetails(owner, repo) {
    const key = `${owner}/${repo}`;
    if (this._pullDetailsSeeded[key]) return;
    this._pullDetailsSeeded[key] = true;
    const disk = loadPullDetails(owner, repo);
    if (!disk) return;
    for (const [number, entry] of Object.entries(disk)) {
      this.pullDetails[`${key}#${number}`] = entry;
    }
  },

  persistPullDetails(owner, repo) {
    const prefix = `${owner}/${repo}#`;
    const subset = {};
    for (const [k, v] of Object.entries(this.pullDetails)) {
      if (k.startsWith(prefix)) subset[k.slice(prefix.length)] = v;
    }
    savePullDetails(subset, owner, repo);
  },

  // One fetch per STATE: the /issues endpoint returns issues AND pull
  // requests, and filtering happens in the providers — the issue and
  // pull providers share one request per state via the in-flight map.
  fetchState(state, token, owner, repo, options = {}) {
    const allowBudgetSkip = options.allowBudgetSkip !== false;
    if (
      allowBudgetSkip &&
      budgetRemaining !== null &&
      budgetRemaining < BUDGET_SKIP_THRESHOLD &&
      budgetResetAt > Date.now()
    ) {
      console.warn(
        `[GitHub] Budget low (${budgetRemaining} left) — skipping auto-fetch of ${state}`,
      );
      notify.budgetLow(budgetRemaining);
      this.lastLive[state] = false;
      const disk = loadCache(state, owner, repo);
      if (disk) {
        this.cache[state] = disk;
        return disk;
      }
      return [];
    }
    if (this._inFlight[state]) return this._inFlight[state];
    const pending = this._fetchState(state, token, owner, repo).finally(() => {
      delete this._inFlight[state];
    });
    this._inFlight[state] = pending;
    return pending;
  },

  async _fetchState(state, token, owner, repo) {
    const key = state;
    if (isRateLimited) {
      console.warn(`[GitHub] Skipping fetchState(${state}) due to rate-limit`);
      this.lastLive[state] = false;
      const disk = loadCache(state, owner, repo);
      if (disk) {
        this.cache[key] = disk;
        return disk;
      }
      this.cache[key] = []; // ← this ensures views get empty data
      return [];
    }

    const { itemsPerPage = 25, maxRecentItems = 50 } = loadConfig();
    let page = 1;
    let allItems = [];
    let etagUsed = false;
    let resp;

    try {
      while (true) {
        const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=${itemsPerPage}&page=${page}`;
        const headers = {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
        };
        if (
          this.etags[key] &&
          !etagUsed &&
          maxRecentItems <= itemsPerPage // only safe when not paginating
        ) {
          headers["If-None-Match"] = this.etags[key];
          etagUsed = true;
        }

        resp = await fetch(url, { headers });

        // track the shared budget for budget-aware auto-refresh
        const remRaw = resp.headers.get("x-ratelimit-remaining");
        if (remRaw !== null && remRaw !== undefined) {
          budgetRemaining = +remRaw;
          const resetRaw = resp.headers.get("x-ratelimit-reset");
          budgetResetAt = resetRaw ? +resetRaw * 1000 : 0;
        }

        // 304 responses may lack x-ratelimit headers entirely — check
        // the not-modified path BEFORE the remaining === 0 gate so a
        // header-less 304 is never misread as an exhausted budget.
        if (resp.status === 304) {
          // Server confirmed the list is unchanged — the cached data is
          // fresh even though it came from disk.
          this.lastLive[state] = true;
          const disk = loadCache(state, owner, repo);
          if (disk) {
            this.cache[key] = disk;
            return disk;
          }
          break;
        }

        const remaining = +resp.headers.get("x-ratelimit-remaining") || 0;
        const resetAt = +resp.headers.get("x-ratelimit-reset") || 0;
        // Primary-limit responses: 403/429 with the quota exhausted, or
        // a 200 that used the last request of the window. 401/404/etc.
        // carry no rate-limit headers at all — treating their missing
        // header as remaining === 0 would misread auth failures as a
        // limit, hold all fetching for 60s, and mask the real alert.
        const isLimitResponse =
          remaining === 0 &&
          (resp.ok || resp.status === 403 || resp.status === 429);
        if (isLimitResponse) {
          applyRateLimit(
            resetAt,
            +resp.headers.get("retry-after") || 0,
            "issues",
            resp.status,
          );
          this.lastLive[state] = false;
          const disk = loadCache(state, owner, repo);
          if (disk) {
            this.cache[key] = disk;
            return disk;
          }
          break;
        }

        if (!resp.ok) {
          const error = new Error(`HTTP ${resp.status}`);
          if (resp.status === 401) {
            notify.authError();
            error.handled = true;
          } else if (resp.status === 403) {
            notify.forbiddenError();
            error.handled = true;
          } else if (resp.status === 404) {
            if (isConfiguredRepo(owner, repo)) {
              notify.notFoundError();
            } else {
              // Fetch raced the detection flow (stale workspace repo
              // selection from another account, add-prompt pending) —
              // alerting here would contradict the "add this repo?"
              // prompt showing at the same moment.
              console.warn(
                `[GitHub] 404 for unconfigured repo ${owner}/${repo} — ignoring (detection pending or stale selection)`,
              );
            }
            error.handled = true;
          }
          throw error;
        }
        const data = await resp.json();
        allItems = allItems.concat(data);
        if (data.length < itemsPerPage || allItems.length >= maxRecentItems) {
          break;
        }

        page++;
      }

      allItems = allItems.slice(0, maxRecentItems);

      const etag = resp.headers.get("etag");
      // Only store ETag if present and no pagination was used
      if (
        resp.headers.has("etag") &&
        page === 1 &&
        allItems.length <= itemsPerPage
      ) {
        this.etags[key] = resp.headers.get("etag");
      } else {
        // Don't overwrite with null if we didn't get a usable one
        this.etags[key] = this.etags[key] ?? null;
      }

      this.cache[key] = allItems;
      saveCache(state, allItems, owner, repo);
      this.lastLive[state] = true;
      return allItems;
    } catch (err) {
      console.warn(`[dataStore] fetchState(${state}) failed:`, err);
      this.lastLive[state] = false;
      const disk = loadCache(state, owner, repo);
      if (disk) {
        this.cache[key] = disk;
        return disk;
      }
      this.cache[key] = []; // fallback to empty
      return []; // explicitly return empty data
    }
  },
};

async function fetchCommentsForIssue(
  issueNumber,
  expectedCount,
  { token, owner, repo },
  issueUpdatedAt = null,
) {
  const cache = loadCommentCache("issue", issueNumber, owner, repo);

  if (isRateLimited) return cache?.data || [];
  // Count alone can't detect a delete+add (same count, different
  // comments) — the parent item's updated_at bumps on either.
  if (
    cache?.count === expectedCount &&
    cache?.issueUpdatedAt === issueUpdatedAt
  ) {
    return cache.data;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };
  if (cache?.etag) headers["If-None-Match"] = cache.etag;

  try {
    const resp = await fetch(url, { headers });
    const remaining = +resp.headers.get("x-ratelimit-remaining") || 0;
    const resetAt = +resp.headers.get("x-ratelimit-reset") || 0;
    // Same guard as _fetchState: 401/404 responses lack rate-limit
    // headers and must not be misread as an exhausted quota.
    if (
      remaining === 0 &&
      (resp.ok || resp.status === 403 || resp.status === 429)
    ) {
      applyRateLimit(
        resetAt,
        +resp.headers.get("retry-after") || 0,
        "comments",
        resp.status,
      );
      return cache?.data || [];
    }
    if (resp.status === 304) return cache?.data || [];
    if (!resp.ok) {
      const error = new Error(`Comments fetch HTTP ${resp.status}`);
      if (resp.status === 401) {
        notify.authError();
        error.handled = true;
      } else if (resp.status === 403) {
        notify.forbiddenError();
        error.handled = true;
      } else if (resp.status === 404) {
        notify.notFoundError();
        error.handled = true;
      }
      throw error;
    }

    const data = await resp.json();
    const etag = resp.headers.get("etag");
    saveCommentCache(
      "issue",
      issueNumber,
      etag,
      data,
      issueUpdatedAt,
      owner,
      repo,
    );
    return data;
  } catch (err) {
    console.warn(`[Comments] Fetch failed for issue #${issueNumber}:`, err);
    return cache?.data || [];
  }
}

async function fetchReviewComments(
  pullNumber,
  expectedCount,
  { token, owner, repo },
  issueUpdatedAt = null,
) {
  const cache = loadCommentCache("pull", pullNumber, owner, repo);

  if (isRateLimited) return cache?.data || [];
  if (
    cache?.count === expectedCount &&
    cache?.issueUpdatedAt === issueUpdatedAt
  ) {
    return cache.data;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/comments`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };
  if (cache?.etag) headers["If-None-Match"] = cache.etag;

  try {
    const resp = await fetch(url, { headers });
    const remaining = +resp.headers.get("x-ratelimit-remaining") || 0;
    const resetAt = +resp.headers.get("x-ratelimit-reset") || 0;
    if (
      remaining === 0 &&
      (resp.ok || resp.status === 403 || resp.status === 429)
    ) {
      applyRateLimit(
        resetAt,
        +resp.headers.get("retry-after") || 0,
        "comments",
        resp.status,
      );
      return cache?.data || [];
    }
    if (resp.status === 304) return cache?.data || [];
    if (!resp.ok) {
      const error = new Error(`Review comments fetch HTTP ${resp.status}`);
      if (resp.status === 401) {
        notify.authError();
        error.handled = true;
      } else if (resp.status === 403) {
        notify.forbiddenError();
        error.handled = true;
      } else if (resp.status === 404) {
        notify.notFoundError();
        error.handled = true;
      }
      throw error;
    }

    const data = await resp.json();
    const etag = resp.headers.get("etag");
    saveCommentCache(
      "pull",
      pullNumber,
      etag,
      data,
      issueUpdatedAt,
      owner,
      repo,
    );
    return data;
  } catch (err) {
    console.warn(`[ReviewComments] fetch failed for PR #${pullNumber}:`, err);
    return cache?.data || [];
  }
}

// True when the most recent fetchState(state) came from the network or
// a server-confirmed 304 — i.e. the result is trustworthy "fresh" data.
// Cache fallbacks (budget-low, rate-limit, network error) return false.
function wasLiveFetch(state) {
  return dataStore.lastLive[state] === true;
}

module.exports = {
  dataStore,
  fetchCommentsForIssue,
  fetchReviewComments,
  resetRateLimitFlag,
  wasLiveFetch,
  shouldDeferNetwork,
};
