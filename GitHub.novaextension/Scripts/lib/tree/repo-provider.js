// lib/tree/repo-provider.js
// TreeDataProvider for the "Repositories" sidebar section.

const {
  invalidateConfigCache,
  getConfiguredRepos,
  resolveActiveRepo,
  setWorkspaceConfig,
  readSetting,
  detectedOverride,
} = require("../config.js");

// A row is detection-sourced when it comes from the detection layer
// and is not also explicitly configured — those are the only rows a
// user can "forget" (explicit rows are managed in settings).
function repoSourceValue(name) {
  const explicit = readSetting("github.repos");
  const detected = detectedOverride();
  if (
    detected &&
    name === detected.repo &&
    !(Array.isArray(explicit) && explicit.includes(name))
  ) {
    return "detected-repo-item";
  }
  return "repo-item";
}

class GitHubRepoProvider {
  constructor() {
    // Starts empty: updateRepoList() reads config, so it runs in the
    // deferred configuration step (never during activation).
    this.rootItems = [];
  }

  updateRepoList() {
    // 1) load all repos — explicit workspace override > detected > global
    const repos = getConfiguredRepos() || [];

    // 2) figure out the “current” repo (same precedence)
    let currentRepo = resolveActiveRepo();

    // 3) if none is set or it’s not in the list, pick the first one.
    //    With no repos configured at all, the stale persisted value
    //    is ignored — an empty section beats a phantom repo.
    if (!currentRepo || !repos.includes(currentRepo)) {
      if (repos.length > 0) {
        currentRepo = repos[0];
        setWorkspaceConfig("github.repo", currentRepo);
        invalidateConfigCache();
        console.log(
          `[RepoSelect] No valid current repo, defaulting to "${currentRepo}"`,
        );
      } else {
        currentRepo = null;
      }
    }

    // 4) now build the TreeItems
    const items = [];

    // 5) All other repos except the current one — the divider between
    // current and rest only makes sense when there IS a rest; a lone
    // repo gets no rail.
    const remaining = repos.filter((r) => r !== currentRepo);

    if (currentRepo) {
      const current = new TreeItem(currentRepo, TreeItemCollapsibleState.None);
      current.identifier = currentRepo;
      current.contextValue = repoSourceValue(currentRepo);
      current.image = "sidebar-small";
      items.push(current);

      if (remaining.length > 0) {
        const separator = new TreeItem("", TreeItemCollapsibleState.None);
        separator.contextValue = "separator";
        separator.image = "__builtin.remove";
        items.push(separator);
      }
    }

    for (const name of remaining) {
      const item = new TreeItem(name, TreeItemCollapsibleState.None);
      item.identifier = name;
      item.contextValue = repoSourceValue(name);
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
