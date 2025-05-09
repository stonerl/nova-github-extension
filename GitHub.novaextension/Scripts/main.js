// main.js
const cacheDir = nova.extension.globalStoragePath;

function cachePath(state) {
  const { owner, repo } = loadConfig();
  // build a per-repo subfolder under cacheDir
  const repoDir = `${cacheDir}/${owner}-${repo}`;
  try {
    // if it doesn’t throw, it already exists
    nova.fs.access(repoDir, nova.fs.F_OK);
  } catch {
    // only try to create if access() failed
    nova.fs.mkdir(repoDir);
  }
  return `${repoDir}/issues-${state}.json`;
}

function saveCache(state, data) {
  const path = cachePath(state);
  try {
    const file = nova.fs.open(path, 'w+t');
    file.write(JSON.stringify(data));
    file.close();
  } catch (e) {
    console.warn('[Cache] write failed:', e);
  }
}

function loadCache(state) {
  const path = cachePath(state);
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
  cache: { open: null, closed: null },
  etags: { open: null, closed: null },

  async fetchState(state, token, owner, repo) {
    // 1) If we have it in memory, return it immediately
    if (this.cache[state]) {
      return this.cache[state];
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=100`;
    const headers = {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
    };
    if (this.etags[state]) {
      headers['If-None-Match'] = this.etags[state];
    }

    try {
      // 2) Try the network
      const resp = await fetch(url, { headers });

      // 🚦 Rate-limit check
      const remaining = +resp.headers.get('x-ratelimit-remaining') || 0;
      const resetAt = +resp.headers.get('x-ratelimit-reset') || 0;
      if (remaining === 0) {
        // log exactly the warning you used to see
        console.warn(
          `[GitHub] Rate-limit hit; resets at ${new Date(resetAt * 1000).toLocaleTimeString()}`,
        );
        // fallback to disk if we have it
        const disk = loadCache(state);
        if (disk) {
          this.cache[state] = disk;
          return disk;
        }
        // otherwise we'll fall through to the error case below
      }

      if (resp.status === 304) {
        // Not changed — load from disk (or memory if it was there)
        const disk = loadCache(state);
        if (disk) {
          this.cache[state] = disk;
          return disk;
        }
        // if no disk snapshot, fall through to memory or empty
      }

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      // 3) Success: parse, cache in memory & on disk, stash ETag
      const data = await resp.json();
      this.etags[state] = resp.headers.get('etag');
      this.cache[state] = data;
      saveCache(state, data);
      return data;
    } catch (err) {
      // 4) Network failure or rate-limit: fall back to disk
      console.warn(`[dataStore] fetchState(${state}) failed:`, err);
      const disk = loadCache(state);
      if (disk) {
        this.cache[state] = disk;
        return disk;
      }
      // no disk to fall back on → rethrow
      throw err;
    }
  },
};

async function fetchCommentsForIssue(issueNumber) {
  const { token, owner, repo } = loadConfig();
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    const remaining = +resp.headers.get('x-ratelimit-remaining') || 0;
    const resetAt = +resp.headers.get('x-ratelimit-reset') || 0;
    if (remaining === 0) {
      console.warn(
        `[GitHub] Comments rate-limit; resets at ${new Date(resetAt * 1000).toLocaleTimeString()}`,
      );
      // optionally: return loadCacheComments(issueNumber) if you have one
      return [];
    }
    if (!resp.ok) {
      throw new Error(`Comments fetch HTTP ${resp.status}`);
    }
    return await resp.json();
  } catch (err) {
    console.warn(`[Comments] fetch failed for #${issueNumber}:`, err);
    // optionally: return loadCacheComments(issueNumber);
    return [];
  }
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
  // ensure your extension's global storage folder exists
  try {
    nova.fs.access(cacheDir, nova.fs.F_OK);
  } catch {
    nova.fs.mkdir(cacheDir);
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
    const headers = {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
    };

    let data;
    try {
      data = await dataStore.fetchState(this.state, token, owner, repo);
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
        if (!isClosed || !i.closed_at) {
          const createdAt = new IssueItem({
            title: 'Created',
            body: new Date(i.created_at).toLocaleString(),
            image: 'issue_created',
          });
          createdAt.parent = parent;
          parent.children.push(createdAt);
        }
        if (!isClosed && i.updated_at !== i.created_at) {
          const updatedAt = new IssueItem({
            title: 'Updated',
            body: new Date(i.updated_at).toLocaleString(),
            image: 'issue_updated',
          });
          updatedAt.parent = parent;
          parent.children.push(updatedAt);
        }

        // – closed / merged for issues & PRs
        if (this.type === 'issue' && isClosed) {
          const closedAt = new IssueItem({
            title: 'Closed',
            body: new Date(i.closed_at).toLocaleString(),
            image: 'issue_closed',
          });
          closedAt.parent = parent;
          parent.children.push(closedAt);
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
          i.comments > 0 ? await fetchCommentsForIssue(i.number) : [];

        const reviewComments =
          this.type === 'pull' && i.review_comments > 0
            ? await fetchReviewComments(i.number)
            : [];
        const allComments = [...comments, ...reviewComments];

        console.log(
          `[Comments] Issue #${i.number}: issueComments=`,
          comments.length,
          'reviewComments=',
          reviewComments.length,
        );
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
