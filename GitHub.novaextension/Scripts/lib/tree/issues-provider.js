// lib/tree/issues-provider.js
// TreeDataProvider for issue/PR sidebar sections: builds the tree
// from dataStore results, hydrates PR details, tracks selection.

const {
  dataStore,
  fetchCommentsForIssue,
  fetchReviewComments,
} = require("../github.js");
const {
  loadConfig,
  isConfigReady,
  updateContextAvailability,
  invalidateConfigCache,
  skipInitialCall,
} = require("../config.js");
const { hexToRgb, IssueItem } = require("./item.js");

class GitHubIssuesProvider {
  constructor(state, type = "issue") {
    this.state = state; // 'open' or 'closed'
    this.type = type; // 'issue' or 'pull'
    this.rootItems = [];
    this.itemsById = new Map();
    this.itemMap = new WeakMap();
    this.initialized = false;

    // Re-fetch when config changes (global or workspace-scoped).
    // Bursts of change events (e.g. keystrokes in a settings field) are
    // coalesced: only the last event within 500ms triggers a refresh.
    for (const key of ["github.token", "github.owner"]) {
      nova.config.observe(
        key,
        skipInitialCall(() => this.scheduleRefresh()),
      );
    }
    for (const key of ["github.owner", "github.repo"]) {
      nova.workspace.config.observe(
        key,
        skipInitialCall(() => this.scheduleRefresh()),
      );
    }
  }

  /**
   * Schedule a coalesced refresh — used for config observer fires and
   * by the detection flow (which applies its state in memory and does
   * not produce a config change event).
   */
  scheduleRefresh() {
    if (this._pendingRefresh) clearTimeout(this._pendingRefresh);
    this._pendingRefresh = setTimeout(() => {
      this._pendingRefresh = null;
      updateContextAvailability();
      if (isConfigReady()) this.refresh(true);
    }, 500);
  }

  configChanged() {
    this.scheduleRefresh();
  }

  async refresh(force = false) {
    const { token, owner, repo } = loadConfig();
    if (!token || !owner || !repo) {
      console.warn(
        `[${this.type}-${this.state}] Missing config (token/owner/repo); skipping refresh`,
      );
      return false;
    }

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

    return this._refreshInternal(data, force);
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

  async _refreshInternal(data, force = false) {
    const { token, owner, repo } = loadConfig();
    const headers = {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
    };

    // 4) Parse & filter
    const issues =
      this.type === "issue"
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

    // 6) Build tree. Items are processed with bounded concurrency —
    // PR hydration fetches a detail endpoint per item, and a few
    // hundred simultaneous requests can trigger rate limits and
    // flood Nova's process bridges.
    this.rootItems = await mapPool(issues, 6, async (i) => {
      // 6a) Hydrate PR fields *before* creating the node
      if (this.type === "pull") {
        const originalComments = i.comments;
        const detailKey = `${owner}/${repo}#${i.number}`;
        const cachedDetail = dataStore.pullDetails[detailKey];

        if (cachedDetail && cachedDetail.updated_at === i.updated_at) {
          // PR unchanged since last hydration — reuse memoized details
          Object.assign(i, cachedDetail.data);
        } else {
          const pullResp = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${i.number}`,
            { headers },
          );
          if (pullResp.ok) {
            const pullData = await pullResp.json();
            // merge only the fields you need
            const detail = {
              draft: pullData.draft,
              merged_at: pullData.merged_at,
              head: pullData.head,
              base: pullData.base,
              review_comments: pullData.review_comments,
            };
            dataStore.pullDetails[detailKey] = {
              updated_at: i.updated_at,
              data: detail,
            };
            Object.assign(i, detail);
          }
        }
        i.comments = originalComments;
      }

      // 6b) Create the node
      const parent = new IssueItem(i);
      this.itemsById.set(String(i.id), parent);

      // 6c) Standard children (state, dates, author, assignees, milestone, labels)
      // – show reopen/close reason
      if (i.state_reason === "reopened") {
        const reasonItem = new IssueItem({
          title: "Reopened",
          image: "issue_reopened",
        });
        reasonItem.parent = parent;
        parent.children.push(reasonItem);
      } else if (i.state === "closed" && i.state_reason) {
        const map = {
          completed: { text: "Completed", image: "issue_completed" },
          not_planned: { text: "Not Planned", image: "issue_not_planned" },
          duplicate: { text: "Duplicate", image: "issue_not_planned" },
        };
        const r = map[i.state_reason] || { text: i.state_reason };
        const reasonItem = new IssueItem({ title: r.text, image: r.image });
        reasonItem.parent = parent;
        parent.children.push(reasonItem);
      }

      // – creation & update timestamps
      const isClosed = i.state === "closed";

      if (isClosed && i.closed_at) {
        const closedAt = new IssueItem({
          title: "Closed",
          body: new Date(i.closed_at).toLocaleString(),
          image: ["not_planned", "duplicate"].includes(i.state_reason)
            ? "pr_closed"
            : "issue_closed",
        });
        closedAt.parent = parent;
        parent.children.push(closedAt);
      } else {
        const createdAt = new IssueItem({
          title: "Created",
          body: new Date(i.created_at).toLocaleString(),
          image: "issue_created",
        });
        createdAt.parent = parent;
        parent.children.push(createdAt);

        if (i.updated_at !== i.created_at) {
          const updatedAt = new IssueItem({
            title: "Updated",
            body: new Date(i.updated_at).toLocaleString(),
            image: "issue_updated",
          });
          updatedAt.parent = parent;
          parent.children.push(updatedAt);
        }
      }

      if (this.type === "pull") {
        if (i.merged_at) {
          const merged = new IssueItem({
            title: "Merged",
            body: new Date(i.merged_at).toLocaleString(),
            image: "issue_closed",
          });
          merged.parent = parent;
          parent.children.push(merged);
        } else if (isClosed) {
          const prClosed = new IssueItem({
            title: "Closed",
            body: new Date(i.closed_at).toLocaleString(),
            image: "pr_closed",
          });
          prClosed.parent = parent;
          parent.children.push(prClosed);
        }
      }

      // – author
      if (i.user?.login) {
        const author = new IssueItem({
          title: "Author",
          body: i.user.login,
          image: "author",
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
          title: "Assignee",
          body: a.login,
          image: "assignee",
        });
        asn.parent = parent;
        parent.children.push(asn);
      }

      // – milestone
      if (i.milestone?.title) {
        const ms = new IssueItem({
          title: "Milestone",
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
      // 6d) Comments are loaded lazily: the group node carries the
      // request info, actual fetching happens in getChildren() when
      // the user expands the group. This keeps enabling the extension
      // at a handful of requests instead of one per issue.
      const commentCount =
        (i.comments || 0) + (this.type === "pull" ? i.review_comments || 0 : 0);
      if (commentCount > 0) {
        const group = new IssueItem({
          title: "Comments",
          body: `(${commentCount})`,
          image: "comments",
        });
        group.parent = parent;
        group.commentSource = {
          kind: this.type, // 'issue' | 'pull'
          number: i.number,
          issueComments: i.comments || 0,
          reviewComments: this.type === "pull" ? i.review_comments || 0 : 0,
          cfg: { token, owner, repo },
        };

        parent.children.push(group);
      }

      return parent;
    });

    return true;
  }

  /**
   * Fetch and attach comments for a Comments group on first expand.
   * Repeated calls while a load is in flight share the same promise.
   */
  loadComments(group) {
    if (group.commentsLoaded) return group.children;
    if (group.commentsPending) return group.commentsPending;

    const src = group.commentSource;
    const issueFetch =
      src.issueComments > 0
        ? fetchCommentsForIssue(src.number, src.issueComments, src.cfg)
        : Promise.resolve([]);
    const reviewFetch =
      src.reviewComments > 0
        ? fetchReviewComments(src.number, src.reviewComments, src.cfg)
        : Promise.resolve([]);

    group.commentsPending = Promise.all([issueFetch, reviewFetch])
      .then(([comments, reviewComments]) => {
        const all = [...comments, ...reviewComments];
        group.children = all.map((c) => {
          const item = buildCommentItem(c);
          item.parent = group;
          return item;
        });
        group.commentsLoaded = true;
        group.commentsPending = null;
        return group.children;
      })
      .catch((err) => {
        console.warn(`[Comments] Failed to load for #${src.number}:`, err);
        group.commentsPending = null; // allow retry on next expand
        return [];
      });

    return group.commentsPending;
  }

  // ─── TreeDataProvider methods ────────────────────────────

  getChildren(element) {
    if (!element) return this.rootItems;
    if (element.commentSource) return this.loadComments(element);
    return element.children;
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
      const isDraft = this.type === "pull" && issue.draft === true;

      item.identifier = issue.id;
      item.contextValue = "issue-root";
      item.name = isDraft ? `#${issue.number} [DRAFT]` : `#${issue.number}`;
      item.descriptiveText = issue.title;

      if (issue.body && issue.body.trim()) {
        item.tooltip = issue.body;
      } else {
        item.tooltip = "No description provided.";
      }

      const reason = issue.state_reason;
      if (isDraft) {
        item.color = Color.rgb(140 / 255, 140 / 255, 140 / 255); // muted gray
      } else if (this.state === "open" || reason === "reopened") {
        item.color = Color.rgb(45 / 255, 164 / 255, 78 / 255); // GitHub open green
      } else {
        // it's closed — check state_reason
        if (reason === "not_planned" || reason === "duplicate") {
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
    this.itemMap.set(item, element);
    return item;
  }

  /**
   * Map a TreeItem handed back by selection callbacks to its original
   * tree element, falling back to the TreeItem itself.
   */
  resolveElement(treeItem) {
    return (treeItem && this.itemMap.get(treeItem)) || treeItem || null;
  }
}

/**
 * Map items over an async worker with at most `limit` operations in
 * flight. Results keep input order.
 */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Build a comment tree node from a GitHub comment/review-comment object.
 */
function buildCommentItem(c) {
  const commentDate = new Date(c.created_at).toLocaleString();

  const lines = c.body.split(/\r?\n/);
  const firstLine = lines.find((l) => l.trim() !== "") || "";

  // build a tooltip of up to 20 lines
  const allLines = c.body.split(/\r?\n/);
  const snippet = allLines.slice(0, 20);
  if (allLines.length > 20) snippet.push("…");

  // Trim leading/trailing empty lines
  while (snippet.length && snippet[0].trim() === "") snippet.shift();
  while (snippet.length && snippet[snippet.length - 1].trim() === "")
    snippet.pop();

  const tooltipBody = snippet.join("\n");
  const author = c.user?.login || "unknown";
  const tooltip = `${author} on ${commentDate}:\n\n${tooltipBody}`;

  const date = new Date(c.created_at);
  const shortDate = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  }); // “Apr 2”
  const title = `${author} on ${shortDate}`;

  const item = new IssueItem({
    title,
    body: firstLine,
    tooltip,
    image: "comment",
    url: c.html_url,
  });
  item.contextValue = "comment";
  return item;
}

module.exports = { GitHubIssuesProvider };
