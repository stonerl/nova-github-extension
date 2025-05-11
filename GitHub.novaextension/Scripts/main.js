// main.js

const CREDENTIALS_SERVICE = 'github-for-nova';

let isRateLimited = false;

function resetRateLimitFlag() {
  isRateLimited = false;
}

function getLastRefresh() {
  return nova.config.get('github.lastRefresh') || 0;
}

function setLastRefresh(ts) {
  try {
    nova.config.set('github.lastRefresh', ts);
  } catch (e) {
    console.warn('[Config] Failed to record last refresh:', e);
  }
}

function applyRateLimit(resetAt, label) {
  console.warn(
    `[GitHub] ${label} rate-limit; resets at ${new Date(resetAt * 1000).toLocaleTimeString()}`,
  );
  isRateLimited = true;
  const ms = resetAt * 1000 - Date.now();
  setTimeout(resetRateLimitFlag, Math.max(ms, 0));
}

const cacheDir = `${nova.extension.globalStoragePath}/cache`;

function ensureDirExists(dir) {
  try {
    nova.fs.mkdir(dir);
  } catch (err) {
    // if it already exists, mkdir will throw; ignore that
    // any other error you’d probably want to know about
  }
}

function cachePath(type, state) {
  const { owner, repo } = loadConfig();
  const repoDir = `${cacheDir}/${owner}-${repo}`;

  ensureDirExists(repoDir);

  return `${repoDir}/${type}-${state}.json`; // e.g. pull-open.json
}

function saveCache(type, state, data) {
  const path = cachePath(type, state);
  try {
    const file = nova.fs.open(path, 'w+t');
    file.write(JSON.stringify(data));
    file.close();
  } catch (e) {
    console.warn('[Cache] write failed:', e);
  }
}

function loadCache(type, state) {
  const path = cachePath(type, state);
  try {
    const file = nova.fs.open(path, 'r');
    const text = file.read();
    file.close();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const dataStore = {
  cache: {},
  etags: {},

  async fetchState(type, state, token, owner, repo) {
    const key = `${type}-${state}`;
    if (this.cache[key]) return this.cache[key];
    if (isRateLimited) {
      console.warn(`[GitHub] Skipping fetchState(${state}) due to rate-limit`);
      const disk = loadCache(type, state);
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
        console.log(
          `[Fetch] Page ${page} — ${allItems.length}/${maxRecentItems} total so far`,
        );
        const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=${itemsPerPage}&page=${page}`;
        const headers = {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        };
        if (
          this.etags[key] &&
          !etagUsed &&
          maxRecentItems <= itemsPerPage // only safe when not paginating
        ) {
          headers['If-None-Match'] = this.etags[key];
          etagUsed = true;
        }

        resp = await fetch(url, { headers });

        const remaining = +resp.headers.get('x-ratelimit-remaining') || 0;
        const resetAt = +resp.headers.get('x-ratelimit-reset') || 0;
        if (remaining === 0) {
          applyRateLimit(resetAt, 'issues');
          const disk = loadCache(type, state);
          if (disk) {
            this.cache[key] = disk;
            return disk;
          }
          break;
        }

        if (resp.status === 304) {
          const disk = loadCache(type, state);
          if (disk) {
            this.cache[key] = disk;
            return disk;
          }
          break;
        }

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        console.log(
          `[Fetch] Page Limit ${itemsPerPage}, Max Recent Items ${maxRecentItems}`,
        );
        const data = await resp.json();
        allItems = allItems.concat(data);
        console.log(`[Fetch] Page ${page}, got ${data.length} items`);
        if (data.length < itemsPerPage || allItems.length >= maxRecentItems) {
          break;
        }

        page++;
      }

      allItems = allItems.slice(0, maxRecentItems);

      const etag = resp.headers.get('etag');
      // Only store ETag if present and no pagination was used
      if (
        resp.headers.has('etag') &&
        page === 1 &&
        allItems.length <= itemsPerPage
      ) {
        this.etags[key] = resp.headers.get('etag');
      } else {
        // Don't overwrite with null if we didn't get a usable one
        this.etags[key] = this.etags[key] ?? null;
      }

      this.cache[key] = allItems;
      saveCache(type, state, allItems);
      return allItems;
    } catch (err) {
      console.warn(`[dataStore] fetchState(${state}) failed:`, err);
      const disk = loadCache(type, state);
      if (disk) {
        this.cache[key] = disk;
        return disk;
      }
      this.cache[key] = []; // fallback to empty
      return []; // explicitly return empty data
    }
  },
};

function commentCachePath(type, number) {
  const { owner, repo } = loadConfig();
  const repoDir = `${cacheDir}/${owner}-${repo}`;
  ensureDirExists(repoDir);
  return `${repoDir}/comments-${type}-${number}.json`;
}

function saveCommentCache(type, number, etag, data) {
  const path = commentCachePath(type, number);
  const payload = { etag, data };
  try {
    // again, 'w+t' will create the file if it doesn't exist
    const file = nova.fs.open(path, 'w+t');
    file.write(JSON.stringify(payload));
    file.close();
  } catch (e) {
    console.warn(`[Cache] Failed to save ${type} #${number} comments:`, e);
  }
}

function loadCommentCache(type, number) {
  const path = commentCachePath(type, number);
  try {
    const file = nova.fs.open(path, 'r');
    const text = file.read();
    file.close();
    const { etag, data } = JSON.parse(text);
    return { etag, data, count: data.length };
  } catch {
    return { etag: null, data: [], count: 0 };
  }
}

async function fetchCommentsForIssue(issueNumber, expectedCount = 0) {
  const cache = loadCommentCache('issue', issueNumber);

  if (isRateLimited) {
    console.log(
      `[Comments] Issue #${issueNumber}: rate-limited, using cached comments (${cache?.data?.length || 0})`,
    );
    return cache?.data || [];
  }

  if (cache?.count === expectedCount) {
    console.log(
      `[Comments] Issue #${issueNumber}: using cached comments (expected ${expectedCount}, got ${cache.data.length})`,
    );
    return cache.data;
  }

  console.log(
    `[Comments] Issue #${issueNumber}: expected ${expectedCount}, cache has ${cache?.count ?? 'none'} → fetching from API`,
  );

  const { token, owner, repo } = loadConfig();
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
  };
  if (cache?.etag) headers['If-None-Match'] = cache.etag;

  try {
    const resp = await fetch(url, { headers });
    const remaining = +resp.headers.get('x-ratelimit-remaining') || 0;
    const resetAt = +resp.headers.get('x-ratelimit-reset') || 0;
    if (remaining === 0) {
      applyRateLimit(resetAt, 'comments');
      return cache?.data || [];
    }
    if (resp.status === 304) return cache?.data || [];
    if (!resp.ok) throw new Error(`Comments fetch HTTP ${resp.status}`);

    const data = await resp.json();
    const etag = resp.headers.get('etag');
    saveCommentCache('issue', issueNumber, etag, data);
    return data;
  } catch (err) {
    console.warn(`[Comments] Fetch failed for issue #${issueNumber}:`, err);
    return cache?.data || [];
  }
}

async function fetchReviewComments(pullNumber, expectedCount = 0) {
  const cache = loadCommentCache('pull', pullNumber);

  if (isRateLimited) {
    console.log(
      `[Comments] Issue #${pullNumber}: rate-limited, using cached comments (${cache?.data?.length || 0})`,
    );
    return cache?.data || [];
  }

  if (cache?.count === expectedCount) {
    console.log(
      `[Comments] Issue #${pullNumber}: using cached comments (expected ${expectedCount}, got ${cache.data.length})`,
    );
    return cache.data;
  }

  console.log(
    `[Comments] Issue #${pullNumber}: expected ${expectedCount}, cache has ${cache?.count ?? 'none'} → fetching from API`,
  );

  const { token, owner, repo } = loadConfig();
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/comments`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
  };
  if (cache?.etag) headers['If-None-Match'] = cache.etag;

  try {
    const resp = await fetch(url, { headers });
    const remaining = +resp.headers.get('x-ratelimit-remaining') || 0;
    const resetAt = +resp.headers.get('x-ratelimit-reset') || 0;
    if (remaining === 0) {
      applyRateLimit(resetAt, 'comments');
      return cache?.data || [];
    }
    if (resp.status === 304) return cache?.data || [];
    if (!resp.ok) throw new Error(`Review comments fetch HTTP ${resp.status}`);

    const data = await resp.json();
    const etag = resp.headers.get('etag');
    saveCommentCache('pull', pullNumber, etag, data);
    return data;
  } catch (err) {
    console.warn(`[ReviewComments] fetch failed for PR #${pullNumber}:`, err);
    return cache?.data || [];
  }
}

let openView, closedView;
let openProvider, closedProvider;
let openPRView, closedPRView;
let openPRProvider, closedPRProvider;

let selectedItems = {
  issues: null,
  'closed-issues': null,
  pulls: null,
  'closed-pulls': null,
};

function loadConfig() {
  // 1) Owner is now mandatory
  const owner = nova.config.get('github.owner');
  if (!owner) {
    console.error('[Config] github.owner must be set');
    return { token: null, owner: null, repo: null /*…*/ };
  }

  // 2) First try to load under the real owner
  let token = nova.credentials.getPassword(CREDENTIALS_SERVICE, owner);

  // 3) If this is the first time they've set an owner,
  //    migrate the old “default” token over
  if (!token) {
    const defaultToken = nova.credentials.getPassword(
      CREDENTIALS_SERVICE,
      'default',
    );
    if (defaultToken) {
      nova.credentials.setPassword(CREDENTIALS_SERVICE, owner, defaultToken);
      nova.credentials.removePassword(CREDENTIALS_SERVICE, 'default');
      token = defaultToken;
      console.log(`[Config] Migrated token from “default” → “${owner}”`);
    }
  }

  if (!token) {
    console.warn('[Config] No GitHub token in Keychain for owner:', owner);
  }

  return {
    token,
    owner,
    repo: nova.workspace.config.get('github.repo'),
    refreshInterval: nova.config.get('github.refreshInterval'),
    maxRecentItems: nova.config.get('github.maxRecentItems'),
    itemsPerPage: nova.config.get('github.itemsPerPage'),
  };
}

function isConfigReady() {
  const { token, owner, repo } = loadConfig();
  return !!(token && owner && repo);
}

function updateContextAvailability() {
  nova.workspace.context.set('github.ready', isConfigReady());
}

exports.activate = function () {
  resetRateLimitFlag();

  updateContextAvailability();

  // 6) Auto-refresh every 5 Minutes
  let refreshTimer = null;

  function setupAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);

    const { refreshInterval } = loadConfig();
    if (!isConfigReady()) {
      console.warn('[Auto-refresh] Skipped – config incomplete');
      return;
    }

    // The actual work, but guarded by lastRefresh
    const doRefresh = async () => {
      const now = Date.now();
      const last = getLastRefresh();
      if (now - last < refreshInterval * 60 * 1000) {
        console.log(
          `[Auto-refresh] Skipped; only ${Math.floor((now - last) / 1000)}s since last`,
        );
        return;
      }

      const { token, owner, repo } = loadConfig();
      const [openIssues, closedIssues, openPRs, closedPRs] = await Promise.all([
        dataStore.fetchState('issue', 'open', token, owner, repo),
        dataStore.fetchState('issue', 'closed', token, owner, repo),
        dataStore.fetchState('pull', 'open', token, owner, repo),
        dataStore.fetchState('pull', 'closed', token, owner, repo),
      ]);

      if (await openProvider.refreshWithData(openIssues)) openView.reload();
      if (await closedProvider.refreshWithData(closedIssues))
        closedView.reload();
      if (await openPRProvider.refreshWithData(openPRs)) openPRView.reload();
      if (await closedPRProvider.refreshWithData(closedPRs))
        closedPRView.reload();

      setLastRefresh(now);
      console.log('[Auto-refresh] Views updated');
    };

    // schedule it
    refreshTimer = setInterval(doRefresh, refreshInterval * 60 * 1000);

    // and kick it off once immediately
    doRefresh();
  }

  nova.config.observe('refreshInterval', setupAutoRefresh);
  setupAutoRefresh(); // run once immediately

  nova.config.observe('maxRecentItems', () => {
    if (!isConfigReady()) {
      console.warn('[maxRecentItems] Skipped – config incomplete');
      return;
    }
    if (
      !openProvider ||
      !closedProvider ||
      !openPRProvider ||
      !closedPRProvider
    )
      return;

    dataStore.cache.open = null;
    dataStore.cache.closed = null;
    dataStore.etags.open = null;
    dataStore.etags.closed = null;

    const { token, owner, repo } = loadConfig();
    Promise.all([
      dataStore.fetchState('issue', 'open', token, owner, repo),
      dataStore.fetchState('issue', 'closed', token, owner, repo),
      dataStore.fetchState('pull', 'open', token, owner, repo),
      dataStore.fetchState('pull', 'closed', token, owner, repo),
    ]).then(([openIssues, closedIssues, openPRs, closedPRs]) => {
      openProvider
        .refreshWithData(openIssues)
        .then((c) => c && openView.reload());
      closedProvider
        .refreshWithData(closedIssues)
        .then((c) => c && closedView.reload());
      openPRProvider
        .refreshWithData(openPRs)
        .then((c) => c && openPRView.reload());
      closedPRProvider
        .refreshWithData(closedPRs)
        .then((c) => c && closedPRView.reload());
    });
  });

  // ensure your extension's global storage folder exists
  ensureDirExists(cacheDir);

  // Instantiate providers
  openProvider = new GitHubIssuesProvider('open', 'issue');
  closedProvider = new GitHubIssuesProvider('closed', 'issue');
  openPRProvider = new GitHubIssuesProvider('open', 'pull');
  closedPRProvider = new GitHubIssuesProvider('closed', 'pull');

  // Wire each to its sidebar section
  openView = new TreeView('issues', { dataProvider: openProvider });
  closedView = new TreeView('closed-issues', { dataProvider: closedProvider });
  openPRView = new TreeView('pulls', { dataProvider: openPRProvider });
  closedPRView = new TreeView('closed-pulls', {
    dataProvider: closedPRProvider,
  });
  nova.subscriptions.add(openView, closedView, openPRView, closedPRView);

  let reposView;
  let reposProvider;
  reposProvider = new GitHubRepoProvider();
  reposView = new TreeView('repos', { dataProvider: reposProvider });
  nova.subscriptions.add(reposView);

  reposView.onDidChangeSelection((items) => {
    const selected = items[0];
    // 1) ignore if they clicked nothing—or the separator visual
    if (!selected || selected.contextValue === 'separator') {
      return;
    }

    const repos = nova.config.get('github.repos') || [];
    let newRepo = items[0]?.identifier;

    // if they didn’t actually pick one (or it’s no longer in the list),
    // default back to the very first repo
    if (!newRepo || !repos.includes(newRepo)) {
      if (repos.length === 0) {
        console.warn('[RepoSelect] No repos configured, nothing to do.');
        return;
      }
      newRepo = repos[0];
      nova.workspace.config.set('github.repo', newRepo);
      console.log(
        `[RepoSelect] No valid selection → defaulting to "${newRepo}"`,
      );
    }

    const currentRepo = nova.workspace.config.get('github.repo');
    if (newRepo === currentRepo) {
      console.log(`[RepoSelect] Repo "${newRepo}" is already selected.`);
      return;
    }

    console.log(`[RepoSelect] Switching repo to "${newRepo}"`);
    nova.workspace.config.set('github.repo', newRepo);

    // Clear selection
    Object.keys(selectedItems).forEach((k) => (selectedItems[k] = null));

    // Reset each provider’s internal state
    openProvider.rootItems = [];
    openProvider.itemsById.clear();
    closedProvider.rootItems = [];
    closedProvider.itemsById.clear();
    openPRProvider.rootItems = [];
    openPRProvider.itemsById.clear();
    closedPRProvider.rootItems = [];
    closedPRProvider.itemsById.clear();

    // Clear cache
    dataStore.cache = {};
    dataStore.etags = {};

    // Delay to let workspace config observers update
    setTimeout(() => {
      if (!isConfigReady()) {
        console.warn('[RepoSelect] Skipped fetch – config incomplete');
        return;
      }

      const { token, owner, repo } = loadConfig(); // repo is now up to date
      Promise.all([
        dataStore.fetchState('issue', 'open', token, owner, repo),
        dataStore.fetchState('issue', 'closed', token, owner, repo),
        dataStore.fetchState('pull', 'open', token, owner, repo),
        dataStore.fetchState('pull', 'closed', token, owner, repo),
      ]).then(([openIssues, closedIssues, openPRs, closedPRs]) => {
        openProvider
          .refreshWithData(openIssues)
          .then((c) => c && openView.reload());
        closedProvider
          .refreshWithData(closedIssues)
          .then((c) => c && closedView.reload());
        openPRProvider
          .refreshWithData(openPRs)
          .then((c) => c && openPRView.reload());
        closedPRProvider
          .refreshWithData(closedPRs)
          .then((c) => c && closedPRView.reload());
      });
    }, 50);
    reposProvider.updateRepoList(); // your method to update the internal list
    reposView.reload();
  });

  nova.config.observe('github.repos', () => {
    reposProvider.updateRepoList(); // your method to update the internal list
    reposView.reload(); // tell Nova to repaint the UI
  });

  // inside exports.activate(), before you call updateContextAvailability():
  nova.config.observe('github.token', (newValue) => {
    const owner = nova.config.get('github.owner') || 'default';
    if (newValue === '') {
      nova.credentials.removePassword(CREDENTIALS_SERVICE, owner);
      console.log('[Config] GitHub token removed from Keychain');
    } else if (newValue && newValue !== '***') {
      const owner = nova.config.get('github.owner') || 'default';
      try {
        nova.credentials.setPassword(CREDENTIALS_SERVICE, owner, newValue);
        // mask the setting so it never stays in cleartext
        nova.config.set('github.token', '***');
        console.log('[Config] GitHub token moved to Keychain');
      } catch (err) {
        console.error('[Config] Failed to save token to Keychain:', err);
      }
    }
  });

  function clearOtherSelections(currentKey) {
    for (const key of Object.keys(selectedItems)) {
      if (key !== currentKey) selectedItems[key] = null;
    }
  }

  openView.onDidChangeSelection((items) => {
    selectedItems['issues'] = items[0] || null;
    clearOtherSelections('issues');
  });
  closedView.onDidChangeSelection((items) => {
    selectedItems['closed-issues'] = items[0] || null;
    clearOtherSelections('closed-issues');
  });
  openPRView.onDidChangeSelection((items) => {
    selectedItems['pulls'] = items[0] || null;
    clearOtherSelections('pulls');
  });
  closedPRView.onDidChangeSelection((items) => {
    selectedItems['closed-pulls'] = items[0] || null;
    clearOtherSelections('closed-pulls');
  });

  // 3) Initial load (only if it’s been longer than a full interval)
  (async () => {
    const now = Date.now();
    const { refreshInterval } = loadConfig();

    if (now - getLastRefresh() < refreshInterval * 60_000) {
      console.log(
        `[Initial Load] Skipped; only ${Math.floor(
          (now - getLastRefresh()) / 1000,
        )}s since last — loading from cache instead`,
      );
      // load whatever’s on disk and populate the views
      const cachedOpenIssues = loadCache('issue', 'open') || [];
      const cachedClosedIssues = loadCache('issue', 'closed') || [];
      const cachedOpenPRs = loadCache('pull', 'open') || [];
      const cachedClosedPRs = loadCache('pull', 'closed') || [];

      await openProvider.refreshWithData(cachedOpenIssues);
      await closedProvider.refreshWithData(cachedClosedIssues);
      await openPRProvider.refreshWithData(cachedOpenPRs);
      await closedPRProvider.refreshWithData(cachedClosedPRs);

      openView.reload();
      closedView.reload();
      openPRView.reload();
      closedPRView.reload();
      return;
    }

    if (!isConfigReady()) {
      console.warn('[Initial Load] Skipped – config incomplete');
      return;
    }

    const { token, owner, repo } = loadConfig();
    const [openIssues, closedIssues, openPRs, closedPRs] = await Promise.all([
      dataStore.fetchState('issue', 'open', token, owner, repo),
      dataStore.fetchState('issue', 'closed', token, owner, repo),
      dataStore.fetchState('pull', 'open', token, owner, repo),
      dataStore.fetchState('pull', 'closed', token, owner, repo),
    ]);

    if (await openProvider.refreshWithData(openIssues)) openView.reload();
    if (await closedProvider.refreshWithData(closedIssues)) closedView.reload();
    if (await openPRProvider.refreshWithData(openPRs)) openPRView.reload();
    if (await closedPRProvider.refreshWithData(closedPRs))
      closedPRView.reload();

    // record that we just did our “initial” fetch
    setLastRefresh(now);
  })();

  // 4) “Refresh” runs both
  nova.commands.register('github-issues.refresh', async () => {
    if (!isConfigReady()) {
      console.warn('[Command: Refresh] Skipped – config incomplete');
      return;
    }
    const { token, owner, repo } = loadConfig();
    const [openIssues, closedIssues, openPRs, closedPRs] = await Promise.all([
      dataStore.fetchState('issue', 'open', token, owner, repo),
      dataStore.fetchState('issue', 'closed', token, owner, repo),
      dataStore.fetchState('pull', 'open', token, owner, repo),
      dataStore.fetchState('pull', 'closed', token, owner, repo),
    ]);

    if (await openProvider.refreshWithData(openIssues)) openView.reload();
    if (await closedProvider.refreshWithData(closedIssues)) closedView.reload();
    if (await openPRProvider.refreshWithData(openPRs)) openPRView.reload();
    if (await closedPRProvider.refreshWithData(closedPRs))
      closedPRView.reload();
  });

  nova.commands.register('github-issues.newIssue', () => {
    const { owner, repo } = loadConfig();
    if (!owner || !repo) {
      console.warn('[NewIssue] Missing owner/repo in config');
      return;
    }
    const url = `https://github.com/${owner}/${repo}/issues/new`;
    console.log('[NewIssue] Opening:', url);
    nova.openURL(url);
  });

  nova.commands.register('github-issues.newPullRequest', () => {
    const { owner, repo } = loadConfig();
    if (!owner || !repo) {
      console.warn('[NewPullRequest] Missing owner/repo in config');
      return;
    }
    const url = `https://github.com/${owner}/${repo}/compare`;
    console.log('[NewPullRequest] Opening:', url);
    nova.openURL(url);
  });

  nova.commands.register('github-issues.openInBrowser', () => {
    // 1) Try to open the selected issue or comment
    for (const item of Object.values(selectedItems)) {
      const url =
        item?.html_url ||
        item?.url ||
        item?.issue?.html_url ||
        item?.issue?.url;

      if (url) {
        console.log('[Command] Opening URL:', url);
        nova.openURL(url);
        return;
      }
    }

    // 2) If nothing selected, open the current repo instead
    const { owner, repo } = loadConfig();
    if (owner && repo) {
      const repoURL = `https://github.com/${owner}/${repo}`;
      console.log('[Command] Opening repository URL:', repoURL);
      nova.openURL(repoURL);
    } else {
      console.warn(
        '[Command] No valid issue/comment selected and no repo configured.',
      );
    }
  });

  nova.commands.register('github-issues.copyUrl', () => {
    // 1) Try to copy the selected issue’s URL
    for (const [section, item] of Object.entries(selectedItems)) {
      console.log(
        `[Command] [Copy URL] Section "${section}" selected item:`,
        item,
      );

      if (item?.issue?.html_url) {
        nova.clipboard.writeText(item.issue.html_url);
        console.log(
          '[Command] Issue URL copied to clipboard:',
          item.issue.html_url,
        );
        return;
      }
    }

    // 2) Fallback: copy the current repository’s URL
    const { owner, repo } = loadConfig();
    if (owner && repo) {
      const repoUrl = `https://github.com/${owner}/${repo}`;
      nova.clipboard.writeText(repoUrl);
      console.log('[Command] Repository URL copied to clipboard:', repoUrl);
      return;
    }

    // 3) Nothing to copy
    console.warn(
      '[Command] No issue selected and no repository configured; nothing to copy.',
    );
  });

  nova.commands.register('github-issues.closeIssue', async () => {
    await updateIssueState('closed', undefined);
  });

  nova.commands.register('github-issues.closeNotPlanned', async () => {
    await updateIssueState('closed', 'not_planned');
  });
  nova.commands.register('github-issues.closeDuplicate', async () => {
    await updateIssueState('closed', 'duplicate');
  });

  nova.commands.register('github-issues.reopenIssue', async () => {
    await updateIssueState('open');
  });

  // 5) When switching back to either view, re-fetch
  openView.onDidChangeVisibility((visible) => {
    if (visible) openView.reload();
  });
  closedView.onDidChangeVisibility((visible) => {
    if (visible) closedView.reload();
  });
  openPRView.onDidChangeVisibility((visible) => {
    if (visible) openPRView.reload();
  });
  closedPRView.onDidChangeVisibility((visible) => {
    if (visible) closedPRView.reload();
  });
};

exports.deactivate = function () {
  /* nothing */
};

function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const match = hex.match(/^#?([a-f\d]{6})$/i);
  if (!match) return null;
  const intVal = parseInt(match[1], 16);
  return {
    r: ((intVal >> 16) & 255) / 255,
    g: ((intVal >> 8) & 255) / 255,
    b: (intVal & 255) / 255,
  };
}

class IssueItem {
  constructor(issue) {
    this.issue = issue;
    this.children = [];
    this.parent = null;
  }
}

class GitHubRepoProvider {
  constructor() {
    this.rootItems = [];
    this.updateRepoList();
  }

  updateRepoList() {
    // 1) load all repos from config
    const repos = nova.config.get('github.repos') || [];

    // 2) figure out the “current” repo
    let currentRepo = nova.workspace.config.get('github.repo');

    // 3) if none is set or it’s not in the list, pick the first one
    if (!currentRepo || !repos.includes(currentRepo)) {
      if (repos.length > 0) {
        currentRepo = repos[0];
        nova.workspace.config.set('github.repo', currentRepo);
        console.log(
          `[RepoSelect] No valid current repo, defaulting to "${currentRepo}"`,
        );
      }
    }

    // 4) now build the TreeItems
    const items = [];

    if (currentRepo) {
      const current = new TreeItem(currentRepo, TreeItemCollapsibleState.None);
      current.identifier = currentRepo;
      current.contextValue = 'repo-item';
      current.image = 'sidebar-small';
      items.push(current);

      // Add separator
      const separator = new TreeItem('', TreeItemCollapsibleState.None);
      separator.contextValue = 'separator';
      (separator.image = '__builtin.remove'), items.push(separator);
    }

    // 5) Add all other repos except the current one
    const remaining = repos.filter((r) => r !== currentRepo);
    for (const name of remaining) {
      const item = new TreeItem(name, TreeItemCollapsibleState.None);
      item.identifier = name;
      item.contextValue = 'repo-item';
      item.image = 'code_branch';
      items.push(item);
    }

    this.rootItems = items;
  }

  getChildren() {
    return this.rootItems;
  }

  getTreeItem(item) {
    return item;
  }

  getParent() {
    return null;
  }
}

class GitHubIssuesProvider {
  constructor(state, type = 'issue') {
    this.state = state; // 'open' or 'closed'
    this.type = type; // 'issue' or 'pull'
    this.rootItems = [];
    this.itemsById = new Map();
    this.lastItemIds = new Set();
    this.initialized = false;

    // re-fetch if config changes
    for (const key of ['github.token', 'github.owner']) {
      nova.config.observe(key, () => {
        updateContextAvailability();
        if (isConfigReady()) this.refresh(true);
      });
    }

    // Handle workspace config separately
    nova.workspace.config.observe('github.repo', () => {
      updateContextAvailability();
      if (isConfigReady()) this.refresh(true);
    });
  }

  async refresh(force = false) {
    return this._refreshInternal(force);
  }

  async refreshWithData(data) {
    if (!isConfigReady()) {
      console.warn(
        `[${this.type}-${this.state}] Missing config (token/owner/repo); skipping refresh`,
      );
      return false;
    }
    return this._refreshInternal(data, true);
  }

  async _refreshInternal(force = false) {
    const { token, owner, repo } = loadConfig();
    const headers = {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
    };

    let data;
    try {
      data = await dataStore.fetchState(
        this.type,
        this.state,
        token,
        owner,
        repo,
      );
    } catch (err) {
      console.error(`[${this.type}-${this.state}] cannot load data:`, err);
      return false;
    }

    // 4) Parse & filter
    const issues =
      this.type === 'issue'
        ? data.filter((i) => !i.pull_request)
        : data.filter((i) => !!i.pull_request);

    // 5) Change-detection
    const hasChanged =
      force ||
      !this.initialized ||
      issues.length !== this.rootItems.length ||
      issues.some((i) => {
        const prev = this.itemsById.get(String(i.id));
        return !prev || prev.issue.updated_at !== i.updated_at;
      });
    if (!hasChanged) {
      console.log(`[${this.type}-${this.state}] No updates; skipping`);
      return false;
    }

    this.initialized = true;
    this.itemsById.clear();

    // 6) Build tree
    this.rootItems = await Promise.all(
      issues.map(async (i) => {
        // 6a) Hydrate PR fields *before* creating the node
        if (this.type === 'pull') {
          const originalComments = i.comments;
          const pullResp = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${i.number}`,
            { headers },
          );
          if (pullResp.ok) {
            const pullData = await pullResp.json();
            // merge only the fields you need
            i.draft = pullData.draft;
            i.merged_at = pullData.merged_at;
            i.head = pullData.head;
            i.base = pullData.base;
            i.review_comments = pullData.review_comments;
          }
          i.comments = originalComments;
        }

        // 6b) Create the node
        const parent = new IssueItem(i);
        this.itemsById.set(String(i.id), parent);

        // 6c) Standard children (state, dates, author, assignees, milestone, labels)
        // – show reopen/close reason
        if (i.state_reason === 'reopened') {
          const reasonItem = new IssueItem({
            title: 'Reopened',
            image: 'issue_reopened',
          });
          reasonItem.parent = parent;
          parent.children.push(reasonItem);
        } else if (i.state === 'closed' && i.state_reason) {
          const map = {
            completed: { text: 'Completed', image: 'issue_completed' },
            not_planned: { text: 'Not Planned', image: 'issue_not_planned' },
            duplicate: { text: 'Duplicate', image: 'issue_not_planned' },
          };
          const r = map[i.state_reason] || { text: i.state_reason };
          const reasonItem = new IssueItem({ title: r.text, image: r.image });
          reasonItem.parent = parent;
          parent.children.push(reasonItem);
        }

        // – creation & update timestamps
        const isClosed = i.state === 'closed';

        if (isClosed && i.closed_at) {
          const closedAt = new IssueItem({
            title: 'Closed',
            body: new Date(i.closed_at).toLocaleString(),
            image: ['not_planned', 'duplicate'].includes(i.state_reason)
              ? 'pr_closed'
              : 'issue_closed',
          });
          closedAt.parent = parent;
          parent.children.push(closedAt);
        } else {
          const createdAt = new IssueItem({
            title: 'Created',
            body: new Date(i.created_at).toLocaleString(),
            image: 'issue_created',
          });
          createdAt.parent = parent;
          parent.children.push(createdAt);

          if (i.updated_at !== i.created_at) {
            const updatedAt = new IssueItem({
              title: 'Updated',
              body: new Date(i.updated_at).toLocaleString(),
              image: 'issue_updated',
            });
            updatedAt.parent = parent;
            parent.children.push(updatedAt);
          }
        }

        if (this.type === 'pull') {
          if (i.merged_at) {
            const merged = new IssueItem({
              title: 'Merged',
              body: new Date(i.merged_at).toLocaleString(),
              image: 'issue_closed',
            });
            merged.parent = parent;
            parent.children.push(merged);
          } else if (isClosed) {
            const prClosed = new IssueItem({
              title: 'Closed',
              body: new Date(i.closed_at).toLocaleString(),
              image: 'pr_closed',
            });
            prClosed.parent = parent;
            parent.children.push(prClosed);
          }
        }

        // – author
        if (i.user?.login) {
          const author = new IssueItem({
            title: 'Author',
            body: i.user.login,
            image: 'author',
          });
          author.parent = parent;
          parent.children.push(author);
        }

        // – assignees
        const assignees = i.assignees?.length
          ? i.assignees
          : i.assignee
            ? [i.assignee]
            : [];
        for (const a of assignees) {
          const asn = new IssueItem({
            title: 'Assignee',
            body: a.login,
            image: 'assignee',
          });
          asn.parent = parent;
          parent.children.push(asn);
        }

        // – milestone
        if (i.milestone?.title) {
          const ms = new IssueItem({
            title: 'Milestone',
            body: i.milestone.title,
          });
          ms.parent = parent;
          parent.children.push(ms);
        }

        // – labels
        for (const lbl of i.labels || []) {
          const rgb = hexToRgb(lbl.color);
          const li = new IssueItem({
            title: lbl.name,
            color: rgb && Color.rgb(rgb.r, rgb.g, rgb.b),
          });
          li.parent = parent;
          parent.children.push(li);
        }

        // 6d) Comments & review‐comments
        const comments =
          i.comments > 0
            ? await fetchCommentsForIssue(i.number, i.comments)
            : [];

        const reviewComments =
          this.type === 'pull' && i.review_comments > 0
            ? await fetchReviewComments(i.number, i.review_comments)
            : [];
        const allComments = [...comments, ...reviewComments];

        /*console.log(
          `[Comments] Issue #${i.number}: issueComments=`,
          comments.length,
          'reviewComments=',
          reviewComments.length,
        );*/
        if (allComments.length > 0) {
          const group = new IssueItem({
            title: 'Comments',
            body: `(${allComments.length})`,
            image: 'comments',
          });
          group.parent = parent;

          for (const c of allComments) {
            const commentDate = new Date(c.created_at).toLocaleString();

            const lines = c.body.split(/\r?\n/);
            const firstLine = lines.find((l) => l.trim() !== '') || '';

            // build a tooltip of up to 25 lines
            const allLines = c.body.split(/\r?\n/);
            const snippet = allLines.slice(0, 20);
            if (allLines.length > 20) snippet.push('…');

            // Trim leading/trailing empty lines
            while (snippet.length && snippet[0].trim() === '') snippet.shift();
            while (snippet.length && snippet[snippet.length - 1].trim() === '')
              snippet.pop();

            const tooltipBody = snippet.join('\n');
            const author = c.user?.login || 'unknown';
            const tooltip = `${author} on ${commentDate}:\n\n${tooltipBody}`;

            const date = new Date(c.created_at);
            const shortDate = date.toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            }); // “Apr 2”
            const title = `${author} on ${shortDate}`;

            const item = new IssueItem({
              title,
              body: firstLine,
              tooltip,
              image: 'comment',
              url: c.html_url,
            });
            item.contextValue = 'comment';
            item.parent = group;
            group.children.push(item);
          }

          parent.children.push(group);
        }

        return parent;
      }),
    );

    return true;
  }

  // ─── TreeDataProvider methods ────────────────────────────

  getChildren(element) {
    return element ? element.children : this.rootItems;
  }

  getParent(element) {
    return element.parent;
  }

  getTreeItem(element) {
    const issue = element.issue;
    const item = new TreeItem(
      issue.id ? `${issue.id}` : issue.title,
      element.children.length
        ? TreeItemCollapsibleState.Collapsed
        : TreeItemCollapsibleState.None,
    );
    if (issue.id) {
      const isDraft = this.type === 'pull' && issue.draft === true;

      item.identifier = issue.id;
      item.contextValue = 'issue-root';
      item.name = isDraft ? `#${issue.number} [DRAFT]` : `#${issue.number}`;
      item.descriptiveText = issue.title;

      if (issue.body && issue.body.trim()) {
        item.tooltip = issue.body;
      } else {
        item.tooltip = 'No description provided.';
      }

      const reason = issue.state_reason;
      if (isDraft) {
        item.color = Color.rgb(140 / 255, 140 / 255, 140 / 255); // muted gray
      } else if (this.state === 'open' || reason === 'reopened') {
        item.color = Color.rgb(45 / 255, 164 / 255, 78 / 255); // GitHub open green
      } else {
        // it's closed — check state_reason
        if (reason === 'not_planned' || reason === 'duplicate') {
          item.color = Color.rgb(110 / 255, 119 / 255, 129 / 255); // GitHub gray
        } else {
          item.color = Color.rgb(130 / 255, 80 / 255, 223 / 255); // GitHub purple
        }
      }
    } else {
      item.name = issue.title;
      if (issue.image) item.image = issue.image;
      if (issue.body) item.descriptiveText = issue.body;
      if (issue.tooltip) item.tooltip = issue.tooltip;
      if (issue.color) item.color = issue.color;
      if (element.contextValue) {
        item.contextValue = element.contextValue;
      }
    }
    return item;
  }

  getItemById(id) {
    return this.itemsById.get(String(id));
  }
}

async function waitForIssueState(issueNumber, desiredState, maxRetries = 10) {
  const { token, owner, repo } = loadConfig();
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
  for (let i = 0; i < maxRetries; i++) {
    console.log(
      `[Wait] Checking state for issue #${issueNumber} (try ${i + 1}/${maxRetries})...`,
    );
    const resp = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    if (!resp.ok) {
      console.warn(`[Wait] GitHub API returned ${resp.status}; stopping early`);
      break;
    }

    const issue = await resp.json();
    if (issue.state === desiredState) {
      console.log(
        `[Wait] Issue #${issueNumber} is now in state "${desiredState}"`,
      );
      return true;
    }

    await new Promise((r) => setTimeout(r, 1000)); // wait 1s
  }

  console.warn(
    `[Wait] Gave up waiting for issue #${issueNumber} to reach state "${desiredState}"`,
  );
  return false;
}

async function updateIssueState(newState, reason) {
  for (const [section, item] of Object.entries(selectedItems)) {
    if (!item) continue;

    // walk up until we find an item with a numeric issue.number
    let root = item;
    while (root && typeof root.issue?.number !== 'number') {
      root = root.parent;
    }
    if (!root) continue;
    if (root.issue.state === newState) continue;

    const { token, owner, repo } = loadConfig();
    const issueNumber = root.issue.number;

    if (newState === 'open') {
      reason = 'reopened';
    }

    if (newState === 'closed' && !reason) {
      reason = 'completed';
    }

    const body = { state: newState };
    if (reason) body.state_reason = reason;

    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (resp.ok) {
      console.log(
        `[Update] Issue #${issueNumber} set to ${newState}${reason ? ` (${reason})` : ''}`,
      );

      // Log before patch
      console.log(
        '[Patch] Before:',
        JSON.stringify(
          {
            number: root.issue.number,
            state: root.issue.state,
            state_reason: root.issue.state_reason,
            closed_at: root.issue.closed_at,
            updated_at: root.issue.updated_at,
          },
          null,
          2,
        ),
      );

      // Patch local model
      root.issue.state = newState;
      root.issue.state_reason = reason ?? null;
      root.issue.closed_at =
        newState === 'closed' ? new Date().toISOString() : null;
      root.issue.updated_at = new Date().toISOString();

      // Move in cache
      const type = 'issue';
      const keyFrom = `${type}-${newState === 'closed' ? 'open' : 'closed'}`;
      const keyTo = `${type}-${newState}`;

      dataStore.cache[keyFrom] = (dataStore.cache[keyFrom] || []).filter(
        (i) => i.id !== root.issue.id,
      );
      dataStore.cache[keyTo] = [root.issue, ...(dataStore.cache[keyTo] || [])];

      const fromProvider =
        newState === 'closed' ? openProvider : closedProvider;
      const toProvider = newState === 'closed' ? closedProvider : openProvider;

      // Remove from old provider's list
      fromProvider.rootItems = fromProvider.rootItems.filter(
        (item) => item.issue.id !== root.issue.id,
      );
      fromProvider.itemsById.delete(String(root.issue.id));

      // Add to new provider
      toProvider.rootItems.unshift(root);
      toProvider.itemsById.set(String(root.issue.id), root);

      // Log after patch
      console.log(
        '[Patch] After:',
        JSON.stringify(
          {
            number: root.issue.number,
            state: root.issue.state,
            state_reason: root.issue.state_reason,
            closed_at: root.issue.closed_at,
            updated_at: root.issue.updated_at,
          },
          null,
          2,
        ),
      );

      // Clear children to force re-render
      // Reload both views to reflect state change
      await openProvider.refreshWithData(dataStore.cache['issue-open'] || []);
      await closedProvider.refreshWithData(
        dataStore.cache['issue-closed'] || [],
      );
      openView.reload();
      closedView.reload();
    } else {
      const errorMessage = await resp.text();
      console.error(
        `[Update] Failed to update issue #${issueNumber}`,
        errorMessage,
      );

      const request = new NotificationRequest(`update-failed-${issueNumber}`);
      request.title = `Failed to Update Issue #${issueNumber}`;
      request.body = `GitHub returned an error while trying to set state to "${newState}":\n${errorMessage}`;

      nova.notifications.add(request).catch((err) => {
        console.error(
          `[Notify] Failed to display update failure notification`,
          err,
        );
      });
    }

    break;
  }
}
