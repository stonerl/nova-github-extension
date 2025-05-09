// main.js

const etagCache = new Map();

async function fetchCommentsForIssue(issueNumber) {
  const { token, owner, repo } = loadConfig();
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!resp.ok) return [];
  return await resp.json();
}

async function fetchReviewComments(pullNumber) {
  const { token, owner, repo } = loadConfig();
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/comments`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!resp.ok) return [];
  return await resp.json();
}

const cacheDir = nova.extension.globalStoragePath;

function cacheDirFor(state, type) {
  const { owner, repo } = loadConfig();
  // or: const ws = nova.workspace.path.split('/').pop();
  return `${cacheDir}/${owner}-${repo}`;
}

function cachePath(state, type) {
  const dir = cacheDirFor(state, type);
  try {
    nova.fs.mkdir(dir);
  } catch {} // ensure subfolder
  return `${dir}/issues-${state}-${type}.json`;
}

function saveCache(state, type, rawData) {
  const path = cachePath(state, type);
  try {
    // Open for writing (text mode, truncate)
    const file = nova.fs.open(path, 'w+');
    file.write(JSON.stringify(rawData));
    file.close();
  } catch (e) {
    console.warn('[Cache] write failed:', e);
  }
}

function loadCache(state, type) {
  const path = cachePath(state, type);
  try {
    // Open for reading
    const file = nova.fs.open(path, 'r');
    const text = file.read();
    file.close();
    return JSON.parse(text);
  } catch (e) {
    // missing or malformed cache
    return null;
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
  const token = nova.config.get('token');
  const owner = nova.config.get('owner');
  const repo = nova.config.get('repo');
  return { token, owner, repo };
}

exports.activate = function () {
  try {
    nova.fs.mkdir(cacheDir);
  } catch (e) {
    console.warn('[Cache] could not create cache directory', e);
  }

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

  // 3) Initial load
  (async () => {
    if (await openProvider.refresh(true)) openView.reload();
    if (await closedProvider.refresh(true)) closedView.reload();
    if (await openPRProvider.refresh(true)) openPRView.reload();
    if (await closedPRProvider.refresh(true)) closedPRView.reload();
  })();

  // 4) “Refresh” runs both
  nova.commands.register('github-issues.refresh', async () => {
    if (await openProvider.refresh()) openView.reload();
    if (await closedProvider.refresh()) closedView.reload();
    if (await openPRProvider.refresh()) openPRView.reload();
    if (await closedPRProvider.refresh()) closedPRView.reload();
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

    console.warn('[Command] No valid issue or comment URL selected.');
  });

  nova.commands.register('github-issues.copyUrl', () => {
    for (const [section, item] of Object.entries(selectedItems)) {
      console.log(
        `[Command] [Copy URL] Section "${section}" selected item:`,
        item,
      );

      if (item?.issue?.html_url) {
        nova.clipboard.writeText(item.issue.html_url);
        console.log('[Command] URL copied to clipboard:', item.issue.html_url);
        return;
      }
    }

    console.warn('[Command] No selected node with valid issue URL to copy.');
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
    if (visible) openProvider.refresh().then((c) => c && openView.reload());
  });
  closedView.onDidChangeVisibility((visible) => {
    if (visible) closedProvider.refresh().then((c) => c && closedView.reload());
  });
  openPRView.onDidChangeVisibility((visible) => {
    if (visible) openPRProvider.refresh().then((c) => c && openPRView.reload());
  });
  closedPRView.onDidChangeVisibility((visible) => {
    if (visible)
      closedPRProvider.refresh().then((c) => c && closedPRView.reload());
  });

  // 6) Auto-refresh every 15 seconds
  setInterval(
    async () => {
      if (await openProvider.refresh()) openView.reload();
      if (await closedProvider.refresh()) closedView.reload();
      if (await openPRProvider.refresh()) openPRView.reload();
      if (await closedPRProvider.refresh()) closedPRView.reload();

      console.log('[Auto-refresh] Views updated');
    },
    10 * 60 * 1000,
  ); // 10 minutes
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

class GitHubIssuesProvider {
  constructor(state, type = 'issue') {
    this.state = state; // 'open' or 'closed'
    this.type = type; // 'issue' or 'pull'
    this.rootItems = [];
    this.itemsById = new Map();
    this.lastItemIds = new Set();
    this.initialized = false;

    // re-fetch if config changes
    nova.config.observe('token', () => this.refresh());
    nova.config.observe('owner', () => this.refresh());
    nova.config.observe('repo', () => this.refresh());
  }

  async refresh(force = false) {
    const { token, owner, repo } = loadConfig();
    if (!token || !owner || !repo) {
      this.rootItems = [];
      this.itemsById.clear();
      return false;
    }

    // 1) Build headers with ETag
    const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=${this.state}&per_page=100`;
    const headers = {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
    };
    if (etagCache.has(url)) headers['If-None-Match'] = etagCache.get(url);

    let data;
    try {
      const resp = await fetch(url, { headers });

      if (resp.status === 304) {
        console.log(`[GitHub] No changes for ${this.type}-${this.state}`);
        return false;
      }
      const remaining = +resp.headers.get('x-ratelimit-remaining') || 0;
      const resetAt = +resp.headers.get('x-ratelimit-reset') || 0;
      if (remaining === 0) {
        console.warn(
          `[GitHub] Rate-limit; resets at ${new Date(resetAt * 1000).toLocaleTimeString()}`,
        );
        return false;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      // grab & cache
      data = await resp.json();
      saveCache(this.state, this.type, data);
      // update ETag cache
      const newEtag = resp.headers.get('etag');
      if (newEtag) etagCache.set(url, newEtag);
    } catch (err) {
      console.warn('[GitHub] fetch failed, loading cache:', err);
      const fromDisk = loadCache(this.state, this.type);
      if (!fromDisk) throw err;
      data = fromDisk;
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
          }
          i.comments = originalComments;
        }

        // 6b) Create the node
        const parent = new IssueItem(i);
        this.itemsById.set(String(i.id), parent);

        // 6c) Standard children (author, dates, labels…) — unchanged

        // 6d) Comments & review‐comments
        const comments = await fetchCommentsForIssue(i.number);
        const reviewComments =
          this.type === 'pull' ? await fetchReviewComments(i.number) : [];
        const allComments = [...comments, ...reviewComments];

        if (allComments.length > 0) {
          const group = new IssueItem({
            title: 'Comments',
            body: `(${allComments.length})`,
            image: 'comments',
          });
          group.parent = parent;

          for (const c of allComments) {
            const item = new IssueItem({
              title: c.user?.login || 'unknown',
              tooltip: c.body,
              body: new Date(c.created_at).toLocaleString(),
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
    if (!item?.issue) continue;
    if (item.issue.state === newState) continue;

    const { token, owner, repo } = loadConfig();
    const issueNumber = item.issue.number;

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
      // Refresh
      if (await waitForIssueState(issueNumber, newState)) {
        if (section === 'issues' || section === 'closed-issues') {
          await openProvider.refresh(true);
          openView.reload();
          await closedProvider.refresh(true);
          closedView.reload();
        } else if (section === 'pulls' || section === 'closed-pulls') {
          await openPRProvider.refresh(true);
          openPRView.reload();
          await closedPRProvider.refresh(true);
          closedPRView.reload();
        }
      }
    } else {
      console.error(
        `[Update] Failed to update issue #${issueNumber}`,
        await resp.text(),
      );
    }

    break;
  }
}
