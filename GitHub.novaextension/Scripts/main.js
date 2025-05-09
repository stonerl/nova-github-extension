// main.js

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
    for (const [section, item] of Object.entries(selectedItems)) {
      console.log(`[Command] Section "${section}" selected item:`, item);

      if (item?.issue?.html_url) {
        console.log('[Command] Opening URL:', item.issue.html_url);
        nova.openURL(item.issue.html_url);
        return;
      }
    }

    console.warn(
      '[Command] No selected node with valid issue URL in any view.',
    );
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
      this.lastItemIds = new Set();
      return false;
    }

    const url =
      this.type === 'pull'
        ? `https://api.github.com/repos/${owner}/${repo}/pulls?state=${this.state}&per_page=1000`
        : `https://api.github.com/repos/${owner}/${repo}/issues?state=${this.state}&per_page=100`;

    const resp = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!resp.ok) throw new Error(`GitHub API HTTP ${resp.status}`);
    const data = await resp.json();
    const issues =
      this.type === 'issue' ? data.filter((i) => !i.pull_request) : data;

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

    this.rootItems = issues.map((i) => {
      const parent = new IssueItem(i);
      this.itemsById.set(String(i.id), parent);
      if (i.state_reason === 'reopened') {
        const reasonItem = new IssueItem({
          title: 'Reopened',
        });
        reasonItem.parent = parent;
        parent.children.push(reasonItem);
      } else if (i.state === 'closed' && i.state_reason) {
        const reasonMap = {
          completed: {
            text: 'Completed',
            image: 'issue_completed',
          },
          not_planned: {
            text: 'Not Planned',
            image: 'issue_not_planned',
          },
          duplicate: {
            text: 'Duplicate',
            image: 'issue_not_planned',
          },
        };

        const reason = reasonMap[i.state_reason];

        const reasonItem = new IssueItem({
          title: reason ? reason.text : i.state_reason,
          image: reason?.image,
        });
        reasonItem.parent = parent;
        parent.children.push(reasonItem);
      }

      /* if (i.body && i.body.trim()) {
        const lines = i.body
          .trim()
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);

        const maxLines = 10;
        const truncated = lines.length > maxLines;

        const descriptionNode = new IssueItem({
          title: 'Description',
        });
        descriptionNode.parent = parent;

        for (const line of lines.slice(0, maxLines)) {
          const bodyLineItem = new IssueItem({
            title: line,
          });
          bodyLineItem.parent = descriptionNode;
          descriptionNode.children.push(bodyLineItem);
        }

        if (truncated) {
          const moreItem = new IssueItem({
            title: '…',
            tooltip: 'Truncated body',
          });
          moreItem.parent = descriptionNode;
          descriptionNode.children.push(moreItem);
        }

        parent.children.unshift(descriptionNode);
      }*/

      /*if (this.type === 'pull' && i.draft) {
        const draftItem = new IssueItem({
          title: 'Draft',
        });
        draftItem.parent = parent;
        parent.children.push(draftItem);
      }*/

      const isClosed = i.state === 'closed';

      if (!isClosed || !i.closed_at) {
        const createdAt = new IssueItem({
          title: 'Created:',
          body: new Date(i.created_at).toLocaleString(),
          image: 'issue_created',
        });
        createdAt.parent = parent;
        parent.children.push(createdAt);
      }

      if (!isClosed && i.updated_at && i.updated_at !== i.created_at) {
        const updatedAt = new IssueItem({
          title: 'Updated:',
          body: new Date(i.updated_at).toLocaleString(),
          image: 'issue_updated',
        });
        updatedAt.parent = parent;
        parent.children.push(updatedAt);
      }

      if (this.type === 'issue' && isClosed && i.closed_at) {
        const closedAt = new IssueItem({
          title: 'Closed:',
          body: new Date(i.closed_at).toLocaleString(),
          image:
            i.state_reason === 'not_planned' || i.state_reason === 'duplicate'
              ? 'pr_closed'
              : 'issue_closed',
        });
        closedAt.parent = parent;
        parent.children.push(closedAt);
      }

      if (this.type === 'pull') {
        if (i.merged_at) {
          const mergedItem = new IssueItem({
            title: 'Merged:',
            body: new Date(i.merged_at).toLocaleString(),
            image: 'issue_closed',
          });
          mergedItem.parent = parent;
          parent.children.push(mergedItem);
        } else if (i.state === 'closed' && i.closed_at) {
          const closedItem = new IssueItem({
            title: 'Closed:',
            body: new Date(i.closed_at).toLocaleString(),
            image: 'pr_closed',
          });
          closedItem.parent = parent;
          parent.children.push(closedItem);
        }
      }

      if (i.user && i.user.login) {
        const authorItem = new IssueItem({
          title: 'Author:',
          body: i.user.login,
          image: 'author',
        });
        authorItem.parent = parent;
        parent.children.push(authorItem);
      }

      if (Array.isArray(i.assignees) && i.assignees.length > 0) {
        for (const assignee of i.assignees) {
          const assigneeItem = new IssueItem({
            title: 'Assignee:',
            body: assignee.login,
            image: 'assignee',
            tooltip: assignee.name || undefined,
          });
          assigneeItem.parent = parent;
          parent.children.push(assigneeItem);
        }
      } else if (i.assignee && i.assignee.login) {
        const assigneeItem = new IssueItem({
          title: 'Assignee:',
          body: i.assignee.login,
          image: 'assignee',
          tooltip: i.assignee.name || undefined,
        });
        assigneeItem.parent = parent;
        parent.children.push(assigneeItem);
      }

      if (i.milestone && i.milestone.title) {
        const milestoneItem = new IssueItem({
          title: 'Milestone:',
          body: i.milestone.title,
          tooltip: i.milestone.description || undefined,
        });
        milestoneItem.parent = parent;
        parent.children.push(milestoneItem);

        if (i.milestone.due_on) {
          const dueDate = new Date(i.milestone.due_on).toLocaleDateString();
          const dueItem = new IssueItem({
            title: 'Due:',
            body: dueDate,
          });
          dueItem.parent = parent;
          parent.children.push(dueItem);
        }
      }

      if (typeof i.comments === 'number' && i.comments > 0) {
        const commentsItem = new IssueItem({
          title: 'Comments:',
          body: i.comments,
          image: 'comments',
        });
        commentsItem.parent = parent;
        parent.children.push(commentsItem);
      }

      if (Array.isArray(i.labels)) {
        for (const label of i.labels) {
          const rgb = hexToRgb(label.color);
          const labelItem = new IssueItem({
            title: label.name,
            color: rgb ? Color.rgb(rgb.r, rgb.g, rgb.b) : undefined,
            tooltip: label.description || undefined,
          });
          labelItem.parent = parent;
          parent.children.push(labelItem);
        }
      }

      return parent;
    });
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
      item.selectable = false;
      if (issue.image) item.image = issue.image;
      if (issue.body) item.descriptiveText = issue.body;
      if (issue.tooltip) item.tooltip = issue.tooltip;
      if (issue.color) item.color = issue.color;
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
