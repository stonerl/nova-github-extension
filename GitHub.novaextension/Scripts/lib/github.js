// lib/github.js
// GitHub REST access: list fetching with ETag revalidation,
// rate-limit tracking, and comment retrieval with disk caching.

const { loadConfig } = require("./config.js");
const {
  saveCache,
  loadCache,
  saveCommentCache,
  loadCommentCache,
} = require("./cache.js");

let isRateLimited = false;

function resetRateLimitFlag() {
  isRateLimited = false;
}

function applyRateLimit(resetAt, label) {
  console.warn(
    `[GitHub] ${label} rate-limit; resets at ${new Date(resetAt * 1000).toLocaleTimeString()}`,
  );
  isRateLimited = true;
  const ms = resetAt * 1000 - Date.now();
  setTimeout(
    () => {
      isRateLimited = false;
    },
    Math.max(ms, 0),
  );
}

const dataStore = {
  cache: {},
  etags: {},
  pullDetails: {},

  async fetchState(type, state, token, owner, repo) {
    const key = `${type}-${state}`;
    if (isRateLimited) {
      console.warn(`[GitHub] Skipping fetchState(${state}) due to rate-limit`);
      const disk = loadCache(type, state, owner, repo);
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

        const remaining = +resp.headers.get("x-ratelimit-remaining") || 0;
        const resetAt = +resp.headers.get("x-ratelimit-reset") || 0;
        if (remaining === 0) {
          applyRateLimit(resetAt, "issues");
          const disk = loadCache(type, state, owner, repo);
          if (disk) {
            this.cache[key] = disk;
            return disk;
          }
          break;
        }

        if (resp.status === 304) {
          const disk = loadCache(type, state, owner, repo);
          if (disk) {
            this.cache[key] = disk;
            return disk;
          }
          break;
        }

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
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
      saveCache(type, state, allItems, owner, repo);
      return allItems;
    } catch (err) {
      console.warn(`[dataStore] fetchState(${state}) failed:`, err);
      const disk = loadCache(type, state, owner, repo);
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
) {
  const cache = loadCommentCache("issue", issueNumber, owner, repo);

  if (isRateLimited) return cache?.data || [];
  if (cache?.count === expectedCount) return cache.data;

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
    if (remaining === 0) {
      applyRateLimit(resetAt, "comments");
      return cache?.data || [];
    }
    if (resp.status === 304) return cache?.data || [];
    if (!resp.ok) throw new Error(`Comments fetch HTTP ${resp.status}`);

    const data = await resp.json();
    const etag = resp.headers.get("etag");
    saveCommentCache("issue", issueNumber, etag, data, owner, repo);
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
) {
  const cache = loadCommentCache("pull", pullNumber, owner, repo);

  if (isRateLimited) return cache?.data || [];
  if (cache?.count === expectedCount) return cache.data;

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
    if (remaining === 0) {
      applyRateLimit(resetAt, "comments");
      return cache?.data || [];
    }
    if (resp.status === 304) return cache?.data || [];
    if (!resp.ok) throw new Error(`Review comments fetch HTTP ${resp.status}`);

    const data = await resp.json();
    const etag = resp.headers.get("etag");
    saveCommentCache("pull", pullNumber, etag, data, owner, repo);
    return data;
  } catch (err) {
    console.warn(`[ReviewComments] fetch failed for PR #${pullNumber}:`, err);
    return cache?.data || [];
  }
}

module.exports = {
  dataStore,
  fetchCommentsForIssue,
  fetchReviewComments,
  resetRateLimitFlag,
};
