// main.js
// Activation, sidebar wiring, commands, and issue state changes.

const {
  loadConfig,
  isConfigReady,
  updateContextAvailability,
  getLastRefresh,
  setLastRefresh,
  invalidateConfigCache,
  readSetting,
  resolveOwner,
  getConfiguredRepos,
  resolveActiveRepo,
  loadDetections,
  saveDetectionForWorkspace,
  setGlobalConfig,
  setWorkspaceConfig,
  skipInitialCall,
  CREDENTIALS_SERVICE,
} = require("./lib/config.js");
const { cacheDir, ensureDirExists, loadCache } = require("./lib/cache.js");
const { dataStore, resetRateLimitFlag } = require("./lib/github.js");
const { GitHubIssuesProvider } = require("./lib/tree/issues-provider.js");
const { GitHubRepoProvider } = require("./lib/tree/repo-provider.js");
const { parseGitConfig, decideDetection } = require("./lib/detect.js");

let refreshTimer = null;
let configSetupTimer = null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Debounced token persistence: Nova commits settings fields on every
// keystroke, and each config read/write crosses into the app process —
// bursts can lock up Nova's config bridge. Coalesce into one write.
let tokenSaveTimer = null;
let tokenSavePayload = null; // { owner, token }

function flushTokenSave() {
  if (tokenSaveTimer) {
    clearTimeout(tokenSaveTimer);
    tokenSaveTimer = null;
  }
  if (!tokenSavePayload) return;
  const { owner, token } = tokenSavePayload;
  tokenSavePayload = null;
  try {
    nova.credentials.setPassword(CREDENTIALS_SERVICE, owner, token);
    // mask the setting so it never stays in cleartext
    setGlobalConfig("github.token", "***");
    invalidateConfigCache(); // cached config may hold token: null
    console.log("[Config] GitHub token moved to Keychain");
  } catch (err) {
    console.error("[Config] Failed to save token to Keychain:", err);
  }
}

let openView, closedView;
let openProvider, closedProvider;
let openPRView, closedPRView;
let openPRProvider, closedPRProvider;

let selectedItems = {
  issues: null,
  "closed-issues": null,
  pulls: null,
  "closed-pulls": null,
};

exports.activate = function () {
  resetRateLimitFlag();

  // All config-touching setup runs deferred: Nova config observers fire
  // once with the current value at registration, and config traffic
  // during activation contends with other extensions' traffic behind
  // Nova's writer-priority config lock (deadlock window — see the
  // conventions in AGENTS.md). activate() itself performs none.
  function setupConfiguration() {
    updateContextAvailability();
    setupAutoRefreshAndObservers();
    observeMaxRecentItems();
    updateRepoViews(); // initial repos list (config reads — deferred)
    observeRepoListChanges();
    startDetection();
    observeTokenSetting();
    initialLoad();
  }
  configSetupTimer = setTimeout(() => {
    configSetupTimer = null;
    setupConfiguration();
  }, 0);

  // 6) Auto-refresh every 5 Minutes
  function setupAutoRefreshAndObservers() {
    nova.config.observe(
      "github.refreshInterval",
      skipInitialCall(setupAutoRefresh),
    );
    setupAutoRefresh(); // run once immediately
  }

  function setupAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);

    const { refreshInterval } = loadConfig();
    if (!isConfigReady()) {
      console.warn("[Auto-refresh] Skipped – config incomplete");
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
        dataStore.fetchState("issue", "open", token, owner, repo),
        dataStore.fetchState("issue", "closed", token, owner, repo),
        dataStore.fetchState("pull", "open", token, owner, repo),
        dataStore.fetchState("pull", "closed", token, owner, repo),
      ]);

      if (await openProvider.refreshWithData(openIssues)) openView.reload();
      if (await closedProvider.refreshWithData(closedIssues))
        closedView.reload();
      if (await openPRProvider.refreshWithData(openPRs)) openPRView.reload();
      if (await closedPRProvider.refreshWithData(closedPRs))
        closedPRView.reload();

      setLastRefresh(now);
      console.log("[Auto-refresh] Views updated");
    };

    // schedule it
    refreshTimer = setInterval(doRefresh, refreshInterval * 60 * 1000);

    // and kick it off once immediately
    doRefresh();
  }

  function observeMaxRecentItems() {
    nova.config.observe(
      "github.maxRecentItems",
      skipInitialCall(() => {
        if (!isConfigReady()) {
          console.warn("[maxRecentItems] Skipped – config incomplete");
          return;
        }
        if (
          !openProvider ||
          !closedProvider ||
          !openPRProvider ||
          !closedPRProvider
        )
          return;

        dataStore.cache = {};
        dataStore.etags = {};

        const { token, owner, repo } = loadConfig();
        Promise.all([
          dataStore.fetchState("issue", "open", token, owner, repo),
          dataStore.fetchState("issue", "closed", token, owner, repo),
          dataStore.fetchState("pull", "open", token, owner, repo),
          dataStore.fetchState("pull", "closed", token, owner, repo),
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
      }),
    );
  }

  // ensure your extension's global storage folder exists
  ensureDirExists(cacheDir);

  // Instantiate providers
  openProvider = new GitHubIssuesProvider("open", "issue");
  closedProvider = new GitHubIssuesProvider("closed", "issue");
  openPRProvider = new GitHubIssuesProvider("open", "pull");
  closedPRProvider = new GitHubIssuesProvider("closed", "pull");

  // Wire each to its sidebar section
  openView = new TreeView("issues", { dataProvider: openProvider });
  closedView = new TreeView("closed-issues", { dataProvider: closedProvider });
  openPRView = new TreeView("pulls", { dataProvider: openPRProvider });
  closedPRView = new TreeView("closed-pulls", {
    dataProvider: closedPRProvider,
  });
  nova.subscriptions.add(openView, closedView, openPRView, closedPRView);

  const reposProvider = new GitHubRepoProvider();
  const reposView = new TreeView("repos", { dataProvider: reposProvider });
  nova.subscriptions.add(reposView);

  reposView.onDidChangeSelection((items) => {
    const selected = items[0];
    // 1) ignore if they clicked nothing—or the separator visual
    if (!selected || selected.contextValue === "separator") {
      return;
    }

    const repos = readSetting("github.repos") || [];
    let newRepo = items[0]?.identifier;

    // if they didn’t actually pick one (or it’s no longer in the list),
    // default back to the very first repo
    if (!newRepo || !repos.includes(newRepo)) {
      if (repos.length === 0) {
        console.warn("[RepoSelect] No repos configured, nothing to do.");
        return;
      }
      newRepo = repos[0];
      setWorkspaceConfig("github.repo", newRepo);
      invalidateConfigCache();
      console.log(
        `[RepoSelect] No valid selection → defaulting to "${newRepo}"`,
      );
    }

    const currentRepo = nova.workspace.config.get("github.repo");
    if (newRepo === currentRepo) {
      console.log(`[RepoSelect] Repo "${newRepo}" is already selected.`);
      return;
    }

    console.log(`[RepoSelect] Switching repo to "${newRepo}"`);
    setWorkspaceConfig("github.repo", newRepo);
    invalidateConfigCache();

    // Clear selection
    Object.keys(selectedItems).forEach((k) => (selectedItems[k] = null));

    // Reset each provider’s internal state
    for (const provider of [
      openProvider,
      closedProvider,
      openPRProvider,
      closedPRProvider,
    ]) {
      provider.rootItems = [];
      provider.itemsById.clear();
    }

    // Clear cache
    dataStore.cache = {};
    dataStore.etags = {};
    dataStore.pullDetails = {};

    // Delay to let workspace config observers update
    setTimeout(() => {
      if (!isConfigReady()) {
        console.warn("[RepoSelect] Skipped fetch – config incomplete");
        return;
      }

      const { token, owner, repo } = loadConfig(); // repo is now up to date
      Promise.all([
        dataStore.fetchState("issue", "open", token, owner, repo),
        dataStore.fetchState("issue", "closed", token, owner, repo),
        dataStore.fetchState("pull", "open", token, owner, repo),
        dataStore.fetchState("pull", "closed", token, owner, repo),
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
    reposProvider.updateRepoList();
    reposView.reload();
  });

  const updateRepoViews = () => {
    // Deferred: this runs from config change notifications, and its
    // config reads must not nest inside Nova's notification dispatch.
    setTimeout(() => {
      reposProvider.updateRepoList();
      reposView.reload(); // tell Nova to repaint the UI
    }, 0);
  };

  function observeRepoListChanges() {
    nova.config.observe("github.repos", skipInitialCall(updateRepoViews));
    nova.workspace.config.observe(
      "github.repos",
      skipInitialCall(updateRepoViews),
    );
  }

  // 7) Auto-detect the workspace's GitHub repo from .git/config.
  //    Same account + repo already in the list: switch to it silently.
  //    Different account or unknown repo: ask before applying.
  //    Detection NEVER writes workspace config — a single workspace
  //    write has been observed to amplify into thousands inside Nova
  //    (write storm → freeze). State is kept in memory and persisted
  //    in the extension's own storage file instead.
  let detectionAppliedPath = null;

  async function applyDetectedRepo() {
    const workspacePath = nova.workspace.path;
    if (!workspacePath) return;
    if (detectionAppliedPath === workspacePath) return; // re-entry guard
    detectionAppliedPath = workspacePath;

    let detected = null;
    try {
      const file = nova.fs.open(`${workspacePath}/.git/config`, "r");
      const text = file.read();
      file.close();
      detected = parseGitConfig(text);
    } catch {
      return; // no .git/config here — manual config applies
    }

    const decision = decideDetection(detected, {
      owner: loadConfig().owner,
      repos: getConfiguredRepos() || [],
      activeRepo: resolveActiveRepo(),
    });

    if (decision.type === "none") return;

    if (decision.type === "confirmNewAccount") {
      const label = `${decision.owner}/${decision.repo}`;
      const request = new NotificationRequest("github-detect-repo");
      request.title = `Found GitHub repository ${label}`;
      request.body = `Use ${label} in this workspace? This selects the account and repositories for this project only.`;
      request.actions = ["Use in this workspace", "No"];

      try {
        const response = await nova.notifications.add(request);
        if (!response || response.actionIdx !== 0) return; // dismissed
      } catch {
        return; // notification failed — manual configuration applies
      }
    }

    // Apply in memory + persist to our own storage file. No config
    // writes; the pause lets prior notification dispatch drain first.
    saveDetectionForWorkspace(decision.owner, decision.repo);
    await wait(100);
    invalidateConfigCache();
    console.log(
      `[RepoSelect] Using detected repo ${decision.owner}/${decision.repo} for this workspace`,
    );
    updateRepoViews();
    for (const provider of [
      openProvider,
      closedProvider,
      openPRProvider,
      closedPRProvider,
    ]) {
      provider.configChanged();
    }
  }
  function startDetection() {
    loadDetections();
    applyDetectedRepo();
    nova.workspace.onDidChangePath(() => {
      detectionAppliedPath = null;
      loadDetections();
      applyDetectedRepo();
    });
  }

  // Move the token from the settings field into the Keychain
  function observeTokenSetting() {
    nova.config.observe("github.token", (newValue) => {
      const owner = resolveOwner() || "default";
      if (newValue === "") {
        // cancel any pending save, then remove immediately
        if (tokenSaveTimer) {
          clearTimeout(tokenSaveTimer);
          tokenSaveTimer = null;
          tokenSavePayload = null;
        }
        nova.credentials.removePassword(CREDENTIALS_SERVICE, owner);
        console.log("[Config] GitHub token removed from Keychain");
      } else if (
        typeof newValue === "string" &&
        newValue.length >= 20 && // plausible token; ignore partial edits
        newValue !== "***"
      ) {
        tokenSavePayload = { owner, token: newValue };
        if (tokenSaveTimer) clearTimeout(tokenSaveTimer);
        tokenSaveTimer = setTimeout(flushTokenSave, 250);
      }
    });
  }

  function clearOtherSelections(currentKey) {
    for (const key of Object.keys(selectedItems)) {
      if (key !== currentKey) selectedItems[key] = null;
    }
  }

  openView.onDidChangeSelection((items) => {
    selectedItems["issues"] = openProvider.resolveElement(items[0]);
    clearOtherSelections("issues");
  });
  closedView.onDidChangeSelection((items) => {
    selectedItems["closed-issues"] = closedProvider.resolveElement(items[0]);
    clearOtherSelections("closed-issues");
  });
  openPRView.onDidChangeSelection((items) => {
    selectedItems["pulls"] = openPRProvider.resolveElement(items[0]);
    clearOtherSelections("pulls");
  });
  closedPRView.onDidChangeSelection((items) => {
    selectedItems["closed-pulls"] = closedPRProvider.resolveElement(items[0]);
    clearOtherSelections("closed-pulls");
  });

  // 3) Initial load (only if it’s been longer than a full interval)
  async function initialLoad() {
    const now = Date.now();
    const { refreshInterval } = loadConfig();

    if (now - getLastRefresh() < refreshInterval * 60_000) {
      console.log(
        `[Initial Load] Skipped; only ${Math.floor(
          (now - getLastRefresh()) / 1000,
        )}s since last — loading from cache instead`,
      );
      // load whatever’s on disk and populate the views
      const { owner, repo } = loadConfig();
      const cachedOpenIssues = loadCache("issue", "open", owner, repo) || [];
      const cachedClosedIssues =
        loadCache("issue", "closed", owner, repo) || [];
      const cachedOpenPRs = loadCache("pull", "open", owner, repo) || [];
      const cachedClosedPRs = loadCache("pull", "closed", owner, repo) || [];

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
      console.warn("[Initial Load] Skipped – config incomplete");
      return;
    }

    const { token, owner, repo } = loadConfig();
    const [openIssues, closedIssues, openPRs, closedPRs] = await Promise.all([
      dataStore.fetchState("issue", "open", token, owner, repo),
      dataStore.fetchState("issue", "closed", token, owner, repo),
      dataStore.fetchState("pull", "open", token, owner, repo),
      dataStore.fetchState("pull", "closed", token, owner, repo),
    ]);

    if (await openProvider.refreshWithData(openIssues)) openView.reload();
    if (await closedProvider.refreshWithData(closedIssues)) closedView.reload();
    if (await openPRProvider.refreshWithData(openPRs)) openPRView.reload();
    if (await closedPRProvider.refreshWithData(closedPRs))
      closedPRView.reload();

    // record that we just did our “initial” fetch
    setLastRefresh(now);
  }

  // 4) “Refresh” runs both
  nova.commands.register("github-issues.refresh", async () => {
    if (!isConfigReady()) {
      console.warn("[Command: Refresh] Skipped – config incomplete");
      return;
    }
    const { token, owner, repo } = loadConfig();
    const [openIssues, closedIssues, openPRs, closedPRs] = await Promise.all([
      dataStore.fetchState("issue", "open", token, owner, repo),
      dataStore.fetchState("issue", "closed", token, owner, repo),
      dataStore.fetchState("pull", "open", token, owner, repo),
      dataStore.fetchState("pull", "closed", token, owner, repo),
    ]);

    if (await openProvider.refreshWithData(openIssues)) openView.reload();
    if (await closedProvider.refreshWithData(closedIssues)) closedView.reload();
    if (await openPRProvider.refreshWithData(openPRs)) openPRView.reload();
    if (await closedPRProvider.refreshWithData(closedPRs))
      closedPRView.reload();
  });

  nova.commands.register("github-issues.newIssue", () => {
    const { owner, repo } = loadConfig();
    if (!owner || !repo) {
      console.warn("[NewIssue] Missing owner/repo in config");
      return;
    }
    const url = `https://github.com/${owner}/${repo}/issues/new`;
    console.log("[NewIssue] Opening:", url);
    nova.openURL(url);
  });

  nova.commands.register("github-issues.newPullRequest", () => {
    const { owner, repo } = loadConfig();
    if (!owner || !repo) {
      console.warn("[NewPullRequest] Missing owner/repo in config");
      return;
    }
    const url = `https://github.com/${owner}/${repo}/compare`;
    console.log("[NewPullRequest] Opening:", url);
    nova.openURL(url);
  });

  nova.commands.register("github-issues.openInBrowser", () => {
    // 1) Try to open the selected issue or comment
    for (const item of Object.values(selectedItems)) {
      const url =
        item?.html_url ||
        item?.url ||
        item?.issue?.html_url ||
        item?.issue?.url;

      if (url) {
        console.log("[Command] Opening URL:", url);
        nova.openURL(url);
        return;
      }
    }

    // 2) If nothing selected, open the current repo instead
    const { owner, repo } = loadConfig();
    if (owner && repo) {
      const repoURL = `https://github.com/${owner}/${repo}`;
      console.log("[Command] Opening repository URL:", repoURL);
      nova.openURL(repoURL);
    } else {
      console.warn(
        "[Command] No valid issue/comment selected and no repo configured.",
      );
    }
  });

  nova.commands.register("github-issues.copyUrl", () => {
    // 1) Try to copy the selected issue’s URL
    for (const item of Object.values(selectedItems)) {
      if (item?.issue?.html_url) {
        nova.clipboard.writeText(item.issue.html_url);
        console.log(
          "[Command] Issue URL copied to clipboard:",
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
      console.log("[Command] Repository URL copied to clipboard:", repoUrl);
      return;
    }

    // 3) Nothing to copy
    console.warn(
      "[Command] No issue selected and no repository configured; nothing to copy.",
    );
  });

  nova.commands.register("github-issues.closeIssue", async () => {
    await updateIssueState("closed", undefined);
  });

  nova.commands.register("github-issues.closeNotPlanned", async () => {
    await updateIssueState("closed", "not_planned");
  });
  nova.commands.register("github-issues.closeDuplicate", async () => {
    await updateIssueState("closed", "duplicate");
  });

  nova.commands.register("github-issues.reopenIssue", async () => {
    await updateIssueState("open");
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
  flushTokenSave();
  // cancel deferred configuration so a disposed extension never
  // registers observers or touches config
  if (configSetupTimer) {
    clearTimeout(configSetupTimer);
    configSetupTimer = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
};

async function updateIssueState(newState, reason) {
  for (const item of Object.values(selectedItems)) {
    if (!item) continue;

    // walk up until we find an item with a numeric issue.number
    let root = item;
    while (root && typeof root.issue?.number !== "number") {
      root = root.parent;
    }
    if (!root) continue;
    if (root.issue.state === newState) continue;

    const { token, owner, repo } = loadConfig();
    const issueNumber = root.issue.number;

    if (newState === "open") {
      reason = "reopened";
    }

    if (newState === "closed" && !reason) {
      reason = "completed";
    }

    const body = { state: newState };
    if (reason) body.state_reason = reason;

    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (resp.ok) {
      console.log(
        `[Update] Issue #${issueNumber} set to ${newState}${reason ? ` (${reason})` : ""}`,
      );

      // Patch local model
      root.issue.state = newState;
      root.issue.state_reason = reason ?? null;
      root.issue.closed_at =
        newState === "closed" ? new Date().toISOString() : null;
      root.issue.updated_at = new Date().toISOString();

      // Move in cache
      const keyFrom = `issue-${newState === "closed" ? "open" : "closed"}`;
      const keyTo = `issue-${newState}`;

      dataStore.cache[keyFrom] = (dataStore.cache[keyFrom] || []).filter(
        (i) => i.id !== root.issue.id,
      );
      dataStore.cache[keyTo] = [root.issue, ...(dataStore.cache[keyTo] || [])];

      const fromProvider =
        newState === "closed" ? openProvider : closedProvider;
      const toProvider = newState === "closed" ? closedProvider : openProvider;

      // Remove from old provider's list
      fromProvider.rootItems = fromProvider.rootItems.filter(
        (item) => item.issue.id !== root.issue.id,
      );
      fromProvider.itemsById.delete(String(root.issue.id));

      // Add to new provider
      toProvider.rootItems.unshift(root);
      toProvider.itemsById.set(String(root.issue.id), root);

      // Reload both views to reflect state change
      await openProvider.refreshWithData(dataStore.cache["issue-open"] || []);
      await closedProvider.refreshWithData(
        dataStore.cache["issue-closed"] || [],
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
