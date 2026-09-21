// lib/tree/repo-provider.js
// TreeDataProvider for the "Repositories" sidebar section.

const {
  invalidateConfigCache,
  getConfiguredRepos,
  resolveActiveRepo,
  setWorkspaceConfig,
} = require("../config.js");

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

    if (currentRepo) {
      const current = new TreeItem(currentRepo, TreeItemCollapsibleState.None);
      current.identifier = currentRepo;
      current.contextValue = "repo-item";
      current.image = "sidebar-small";
      items.push(current);

      // Add separator
      const separator = new TreeItem("", TreeItemCollapsibleState.None);
      separator.contextValue = "separator";
      separator.image = "__builtin.remove";
      items.push(separator);
    }

    // 5) Add all other repos except the current one
    const remaining = repos.filter((r) => r !== currentRepo);
    for (const name of remaining) {
      const item = new TreeItem(name, TreeItemCollapsibleState.None);
      item.identifier = name;
      item.contextValue = "repo-item";
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
