// lib/tree/repo-provider.js
// TreeDataProvider for the "Repositories" sidebar sections (Issues and
// PRs sidebars share one provider instance).

const {
  invalidateConfigCache,
  getConfiguredRepoPairs,
  resolveActiveRepoPair,
  resolveOwner,
  setWorkspaceConfig,
  readSetting,
  normalizeRepoRef,
  detectedOverride,
} = require("../config.js");

// A row is detection-sourced when it comes from the detection layer
// and is not also explicitly configured — those are the only rows a
// user can "forget" (explicit rows are managed in settings). Entries
// match by resolved pair, so a bare "repo" counts as explicit for
// owner/repo when the account it resolves to is the same.
function repoSourceValue(pair) {
  const ref = `${pair.owner}/${pair.repo}`;
  const detected = detectedOverride();
  if (
    detected &&
    detected.owner === pair.owner &&
    detected.repo === pair.repo
  ) {
    const wsOwner = nova.workspace.config.get("github.owner");
    const globalOwner = nova.config.get("github.owner");
    const wsList = readSetting("github.repos") || [];
    const globalList = nova.config.get("github.repos") || [];
    const explicitlyConfigured = [
      ...wsList.map((entry) =>
        normalizeRepoRef(entry, wsOwner || resolveOwner()),
      ),
      ...globalList.map((entry) => normalizeRepoRef(entry, globalOwner)),
    ].some((candidate) => candidate === ref);
    if (!explicitlyConfigured) return "detected-repo-item";
  }
  return "repo-item";
}

// Rows for the user's own account show the bare repo name; repos of
// orgs and other accounts show "owner/repo" so they stay
// distinguishable from same-named repos elsewhere.
function rowTitle(pair, ownAccount) {
  return pair.owner === ownAccount ? pair.repo : `${pair.owner}/${pair.repo}`;
}

class GitHubRepoProvider {
  constructor() {
    // Starts empty: updateRepoList() reads config, so it runs in the
    // deferred configuration step (never during activation).
    this.rootItems = [];
  }

  updateRepoList() {
    // 1) load all repos as resolved owner/repo pairs
    const repos = getConfiguredRepoPairs() || [];
    const ref = (pair) => `${pair.owner}/${pair.repo}`;

    // 2) figure out the "current" repo (same precedence)
    let current = resolveActiveRepoPair();
    // Rows for the user's OWN account (the global setting) show the
    // bare repo name; everything else — orgs, workspace-override
    // accounts, other users — shows "owner/repo" so the origin stays
    // visible. Falls back to the workspace's account when no global
    // owner is set.
    const ownAccount = nova.config.get("github.owner") || resolveOwner();

    // 3) if none is set or it's not in the list, pick the first one.
    //    With no repos configured at all, the stale persisted value
    //    is ignored — an empty section beats a phantom repo.
    if (!current || !repos.some((p) => ref(p) === ref(current))) {
      if (repos.length > 0) {
        current = repos[0];
        setWorkspaceConfig("github.repo", ref(current));
        invalidateConfigCache();
        console.log(
          `[RepoSelect] No valid current repo, defaulting to "${ref(current)}"`,
        );
      } else {
        current = null;
      }
    } else {
      // The selection resolves fine, but a legacy bare spelling
      // ("crankboy-app") is ambiguous about its owner — rewrite it
      // once as a canonical "owner/repo" ref. Pure reformat: same
      // pair, no behavior change, and after this write the condition
      // never fires again for this workspace.
      const raw = nova.workspace.config.get("github.repo");
      if (raw !== ref(current)) {
        setWorkspaceConfig("github.repo", ref(current));
      }
    }

    // 4) now build the TreeItems
    const items = [];

    // 5) All other repos except the current one — the divider between
    // current and rest only makes sense when there IS a rest; a lone
    // repo gets no rail.
    const remaining = repos.filter((p) => ref(p) !== ref(current || {}));

    if (current) {
      const currentRef = ref(current);
      const currentRow = new TreeItem(
        rowTitle(current, ownAccount),
        TreeItemCollapsibleState.None,
      );
      currentRow.identifier = currentRef;
      currentRow.contextValue = repoSourceValue(current);
      currentRow.image = "sidebar-small";
      items.push(currentRow);

      if (remaining.length > 0) {
        const separator = new TreeItem("", TreeItemCollapsibleState.None);
        separator.contextValue = "separator";
        separator.image = "__builtin.remove";
        items.push(separator);
      }
    }

    for (const pair of remaining) {
      const item = new TreeItem(
        rowTitle(pair, ownAccount),
        TreeItemCollapsibleState.None,
      );
      item.identifier = ref(pair);
      item.contextValue = repoSourceValue(pair);
      item.image = "code_branch";
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

module.exports = { GitHubRepoProvider };
