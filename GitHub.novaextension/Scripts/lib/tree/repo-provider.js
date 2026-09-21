// lib/tree/repo-provider.js
// TreeDataProvider for the "Repositories" sidebar section.

const { invalidateConfigCache, readSetting } = require("../config.js");

class GitHubRepoProvider {
  constructor() {
    this.rootItems = [];
    this.updateRepoList();
  }

  updateRepoList() {
    // 1) load all repos from config (workspace override wins)
    const repos = readSetting("github.repos") || [];

    // 2) figure out the “current” repo
    let currentRepo = nova.workspace.config.get("github.repo");

    // 3) if none is set or it’s not in the list, pick the first one
    if (!currentRepo || !repos.includes(currentRepo)) {
      if (repos.length > 0) {
        currentRepo = repos[0];
        nova.workspace.config.set("github.repo", currentRepo);
        invalidateConfigCache();
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
