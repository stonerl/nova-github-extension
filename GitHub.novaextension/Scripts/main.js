// main.js
// Activation, sidebar wiring, commands, and issue state changes.

const {
  loadConfig,
  isConfigReady,
  updateContextAvailability,
  isRepoFresh,
  markRepoRefreshed,
  invalidateConfigCache,
  readSetting,
  resolveOwner,
  getConfiguredRepos,
  resolveActiveRepo,
  loadDetections,
  saveDetectionForWorkspace,
  forgetDetectionForWorkspace,
  recordOwnerLogin,
  loginForOwner,
  forgetOwnerLogin,
  knownOwners,
  isAutoDetectEnabled,
  setGlobalConfig,
  setWorkspaceConfig,
  skipInitialCall,
  CREDENTIALS_SERVICE,
} = require("./lib/config.js");
const {
  cacheDir,
  ensureDirExists,
  loadCache,
  pruneCaches,
} = require("./lib/cache.js");
const {
  dataStore,
  resetRateLimitFlag,
  wasLiveFetch,
} = require("./lib/github.js");
const { GitHubIssuesProvider } = require("./lib/tree/issues-provider.js");
const { GitHubRepoProvider } = require("./lib/tree/repo-provider.js");
const { parseGitConfig, decideDetection } = require("./lib/detect.js");
const notify = require("./lib/notify.js");

let refreshTimer = null;
let configSetupTimer = null;

// Record per-repo freshness only when the underlying cycle actually
// reached the network — budget-low, rate-limit, and network-error
// fallbacks serve cached/empty data that must not count as "fresh",
// or the auto-refresh guard would suppress retries for a full interval.
function markRepoRefreshedIfLive(owner, repo) {
  if (wasLiveFetch("open") && wasLiveFetch("closed")) {
    markRepoRefreshed(owner, repo);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Debounced token persistence: Nova commits settings fields on every
// keystroke, and each config read/write crosses into the app process —
// bursts can lock up Nova's config bridge. Coalesce into one write.
let tokenSaveTimer = null;
let tokenSavePayload = null; // { owner, token }

// One authenticated request identifies the ACCOUNT a token belongs to.
// Tokens are stored under that login — a personal login and all orgs
// it can access then share a single Keychain entry, so rotating the
// PAT updates every repo at once while genuinely separate accounts
// keep separate entries.
async function probeTokenLogin(token) {
  const resp = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (!resp.ok) return { ok: false, status: resp.status };
  const data = await resp.json();
  return data && data.login
    ? { ok: true, login: data.login }
    : { ok: false, status: resp.status };
}

async function flushTokenSave() {
  if (tokenSaveTimer) {
    clearTimeout(tokenSaveTimer);
    tokenSaveTimer = null;
  }
  if (!tokenSavePayload) return;
  const { owner, token, scope } = tokenSavePayload;
  tokenSavePayload = null;
  try {
    let probe = null;
    try {
      probe = await probeTokenLogin(token);
    } catch {
      probe = null; // offline — fall through to the legacy write
    }

    if (probe && probe.ok) {
      nova.credentials.setPassword(CREDENTIALS_SERVICE, probe.login, token);
      recordOwnerLogin(owner, probe.login);
      console.log(
        `[Config] GitHub token stored for account ${probe.login} (owner ${owner})`,
      );
    } else {
      if (probe) {
        console.warn(
          `[Config] /user probe rejected the token (HTTP ${probe.status}) — storing under owner "${owner}" as fallback`,
        );
      } else {
        console.warn(
          `[Config] /user probe unreachable — storing token under owner "${owner}" as fallback`,
        );
      }
      nova.credentials.setPassword(CREDENTIALS_SERVICE, owner, token);
    }
    // mask the setting so it never stays in cleartext — only in the
    // scope the user typed into; the other scope keeps its own mask
    if (scope === "workspace") {
      setWorkspaceConfig("github.token", "***");
    } else {
      setGlobalConfig("github.token", "***");
    }
    invalidateConfigCache(); // cached config may hold token: null
  } catch (err) {
    console.error("[Config] Failed to save token to Keychain:", err);
  }
}

// One-time migration for tokens stored by earlier versions under the
// repo owner instead of the account login: probe /user once per known
// owner that has no mapping yet and record which account it belongs
// to. Persisted, so the cost is paid once per owner ever.
async function backfillAccountMappings() {
  for (const owner of knownOwners()) {
    if (loginForOwner(owner)) continue;
    let token = null;
    try {
      token = nova.credentials.getPassword(CREDENTIALS_SERVICE, owner);
    } catch {
      return; // keychain bridge trouble — don't hammer it with probes
    }
    if (!token) continue;
    try {
      const probe = await probeTokenLogin(token);
      if (probe.ok) {
        recordOwnerLogin(owner, probe.login);
        console.log(
          `[Config] Account backfill: owner ${owner} → ${probe.login}`,
        );
      }
    } catch {
      return; // offline — retry next session
    }
  }
}

let selectedRepoRow = null; // last repo row picked in the Repositories section

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
    // Detection memory first: everything below resolves owner/repo, and
    // loadConfig() caches its result — a cache primed before detections
    // load makes applyDetectedRepo see a stale owner and re-prompt.
    loadDetections();
    updateContextAvailability();
    setupAutoRefreshAndObservers();
    observeMaxRecentItems();
    updateRepoViews(); // initial repos list (config reads — deferred)
    observeRepoListChanges();
    // Feature toggle: turning detection on mid-session runs it right
    // away; off is non-destructive — saved detections keep applying.
    nova.config.observe(
      "github.autoDetectRepos",
      skipInitialCall((enabled) => {
        if (!enabled) return;
        invalidateConfigCache();
        updateRepoViews();
        applyDetectedRepo();
      }),
    );
    startDetection();
    observeTokenSetting();
    backfillAccountMappings();
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

    // The actual work, but guarded by per-repo freshness: only the
    // ACTIVE repo counts, so a repo switched to (or newly detected for
    // this workspace) refreshes even when the global cycle ran recently.
    const doRefresh = async () => {
      const { token, owner, repo } = loadConfig();
      const intervalMs = refreshInterval * 60 * 1000;
      if (!token || !owner || !repo) {
        console.log("[Auto-refresh] Skipped – config incomplete");
        return;
      }
      if (isRepoFresh(owner, repo, intervalMs)) {
        console.log(
          "[Auto-refresh] Skipped; active repo fetched within the current interval",
        );
        return;
      }
      const [openData, closedData] = await Promise.all([
        dataStore.fetchState("open", token, owner, repo),
        dataStore.fetchState("closed", token, owner, repo),
      ]);

      if (await openProvider.refreshWithData(openData)) openView.reload();
      if (await openPRProvider.refreshWithData(openData)) openPRView.reload();
      if (await closedProvider.refreshWithData(closedData)) closedView.reload();
      if (await closedPRProvider.refreshWithData(closedData))
        closedPRView.reload();

      // Full cycle succeeded — prune caches for items that vanished.
      const keepNumbers = [...openData, ...closedData].map((i) => i.number);
      pruneCaches(owner, repo, keepNumbers);

      markRepoRefreshedIfLive(owner, repo);
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
          dataStore.fetchState("open", token, owner, repo),
          dataStore.fetchState("closed", token, owner, repo),
        ]).then(([openData, closedData]) => {
          openProvider
            .refreshWithData(openData)
            .then((c) => c && openView.reload());
          openPRProvider
            .refreshWithData(openData)
            .then((c) => c && openPRView.reload());
          closedProvider
            .refreshWithData(closedData)
            .then((c) => c && closedView.reload());
          closedPRProvider
            .refreshWithData(closedData)
            .then((c) => c && closedPRView.reload());
          markRepoRefreshedIfLive(owner, repo);
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

  // scheduleRefresh-driven rebuilds (config observers, detection apply)
  // must repaint their TreeView and record per-repo freshness — without
  // this the detection-applied repo stayed empty until the next
  // auto-refresh cycle.
  const wireRebuilt = (provider, view) => {
    provider.onRebuilt = () => {
      const { owner, repo } = loadConfig();
      markRepoRefreshedIfLive(owner, repo);
      view.reload();
    };
  };
  wireRebuilt(openProvider, openView);
  wireRebuilt(closedProvider, closedView);
  wireRebuilt(openPRProvider, openPRView);
  wireRebuilt(closedPRProvider, closedPRView);

  const reposProvider = new GitHubRepoProvider();
  const reposView = new TreeView("repos", { dataProvider: reposProvider });
  nova.subscriptions.add(reposView);

  reposView.onDidChangeSelection((items) => {
    const selected = items[0];
    // 1) ignore if they clicked nothing—or the separator visual
    if (!selected || selected.contextValue === "separator") {
      selectedRepoRow = null;
      return;
    }

    // Track the picked row: context commands cannot receive the clicked
    // TreeItem, so this is how copyUrl/openInBrowser know which repo
    // the user right-clicked.
    selectedRepoRow = selected.identifier || null;

    const repos = getConfiguredRepos() || [];
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

    // Provider refreshes ride the workspace github.repo observers
    // (coalesced) — no second fetch cycle needed here.
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
    // workspace-only toggle: merging global repos changes the list
    nova.workspace.config.observe(
      "github.includeGlobalRepos",
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
    // Feature toggle (github.autoDetectRepos, global, on by default):
    // off means no scanning, no prompts, no new applications. Checked
    // BEFORE the re-entry guard so flipping it on later still applies.
    // Already-saved detections keep resolving — forgetDetection
    // removes one explicitly.
    if (!isAutoDetectEnabled()) return;
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
    // Belt+braces: a config cache primed before the detection load (e.g.
    // on workspace path change) must not leak into the decision below.
    invalidateConfigCache();
    applyDetectedRepo();
    nova.workspace.onDidChangePath(() => {
      detectionAppliedPath = null;
      loadDetections();
      invalidateConfigCache();
      applyDetectedRepo();
    });
  }

  // Move the token from the settings field into the Keychain. Both
  // scopes feed the same flow: the saved credential lands under the
  // authenticated login, and only a *** mask stays in whichever field
  // the user typed into. The payload remembers the scope for that
  // mask write.
  function observeTokenSetting() {
    const handleTokenChange = (scope) => (newValue) => {
      const owner = resolveOwner() || "default";
      if (newValue === "") {
        // cancel any pending save, then remove immediately
        if (tokenSaveTimer) {
          clearTimeout(tokenSaveTimer);
          tokenSaveTimer = null;
          tokenSavePayload = null;
        }
        // the credential is shared by every owner of the account, so
        // the mapped login entry goes too
        const login = loginForOwner(owner);
        if (login) {
          try {
            nova.credentials.removePassword(CREDENTIALS_SERVICE, login);
          } catch {}
        }
        try {
          nova.credentials.removePassword(CREDENTIALS_SERVICE, owner);
        } catch {}
        forgetOwnerLogin(owner);
        console.log("[Config] GitHub token removed from Keychain");
      } else if (
        typeof newValue === "string" &&
        newValue.length >= 20 && // plausible token; ignore partial edits
        newValue !== "***"
      ) {
        tokenSavePayload = { owner, token: newValue, scope };
        if (tokenSaveTimer) clearTimeout(tokenSaveTimer);
        tokenSaveTimer = setTimeout(flushTokenSave, 250);
      }
    };
    // Registration-time fires are harmless here: an unset field fires
    // null/"" (mask/length checks or removal of a non-existent entry),
    // a previously saved field fires "***" (ignored) — both no-ops.
    nova.config.observe("github.token", handleTokenChange("global"));
    nova.workspace.config.observe(
      "github.token",
      handleTokenChange("workspace"),
    );
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

  // 3) Initial load. Freshness is per active repo: an in-memory map
  // starts empty on extension start, so opening a workspace always
  // treats the (possibly auto-detected) repo as stale and fetches once
  // instead of serving another workspace's "fresh" timestamp.
  async function initialLoad() {
    const { refreshInterval } = loadConfig();
    const { owner, repo } = loadConfig();

    if (owner && repo && isRepoFresh(owner, repo, refreshInterval * 60_000)) {
      console.log(
        "[Initial Load] Active repo fetched recently — loading from cache instead",
      );
      // load whatever's on disk and populate the views
      const cachedOpen = loadCache("open", owner, repo) || [];
      const cachedClosed = loadCache("closed", owner, repo) || [];

      await openProvider.refreshWithData(cachedOpen);
      await openPRProvider.refreshWithData(cachedOpen);
      await closedProvider.refreshWithData(cachedClosed);
      await closedPRProvider.refreshWithData(cachedClosed);

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

    const { token, owner: netOwner, repo: netRepo } = loadConfig();
    const [openData, closedData] = await Promise.all([
      dataStore.fetchState("open", token, netOwner, netRepo),
      dataStore.fetchState("closed", token, netOwner, netRepo),
    ]);

    if (await openProvider.refreshWithData(openData)) openView.reload();
    if (await openPRProvider.refreshWithData(openData)) openPRView.reload();
    if (await closedProvider.refreshWithData(closedData)) closedView.reload();
    if (await closedPRProvider.refreshWithData(closedData))
      closedPRView.reload();

    // record that we just did our "initial" fetch
    markRepoRefreshedIfLive(netOwner, netRepo);
  }

  // Config-incomplete surfacing that can tell WHY: owner and repo are
  // resolved but no Keychain credential exists for that account — that
  // deserves a different message than a blank configuration.
  function notifyConfigIncomplete() {
    const { owner, repo, token } = loadConfig();
    if (owner && repo && !token) {
      notify.missingWorkspaceToken(owner);
    } else {
      notify.configIncomplete();
    }
  }

  // 4) “Refresh” runs both
  nova.commands.register("github-issues.refresh", async () => {
    if (!isConfigReady()) {
      console.warn("[Command: Refresh] Skipped – config incomplete");
      notifyConfigIncomplete();
      return;
    }
    const { token, owner, repo } = loadConfig();
    const [openData, closedData] = await Promise.all([
      dataStore.fetchState("open", token, owner, repo, {
        allowBudgetSkip: false,
      }),
      dataStore.fetchState("closed", token, owner, repo, {
        allowBudgetSkip: false,
      }),
    ]);

    if (await openProvider.refreshWithData(openData)) openView.reload();
    if (await openPRProvider.refreshWithData(openData)) openPRView.reload();
    if (await closedProvider.refreshWithData(closedData)) closedView.reload();
    if (await closedPRProvider.refreshWithData(closedData))
      closedPRView.reload();

    // Full cycle succeeded — prune caches for items that vanished.
    const keepNumbers = [...openData, ...closedData].map((i) => i.number);
    pruneCaches(owner, repo, keepNumbers);
    markRepoRefreshedIfLive(owner, repo);
  });

  nova.commands.register("github-issues.newIssue", () => {
    const { owner, repo } = loadConfig();
    if (!owner || !repo) {
      console.warn("[NewIssue] Missing owner/repo in config");
      notify.configIncomplete();
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
      notify.configIncomplete();
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

    // 2) If nothing selected, open the current repo instead — or the
    //    repo row the user last picked (right-click target)
    const { owner } = loadConfig();
    const repos = getConfiguredRepos() || [];
    const repo =
      selectedRepoRow && repos.includes(selectedRepoRow)
        ? selectedRepoRow
        : loadConfig().repo;
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

    // 2) Fallback: copy the current repository's URL — or the repo row
    //    the user last picked (right-click target)
    const { owner } = loadConfig();
    const repos = getConfiguredRepos() || [];
    const repo =
      selectedRepoRow && repos.includes(selectedRepoRow)
        ? selectedRepoRow
        : loadConfig().repo;
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

  // Removes this workspace's detected repo (one-click; the detection
  // notification simply reappears next open if still wanted).
  nova.commands.register("github-issues.forgetDetection", () => {
    forgetDetectionForWorkspace();
    invalidateConfigCache();
    console.log("[RepoSelect] Detection forgotten for this workspace");
    updateRepoViews();
    for (const provider of [
      openProvider,
      closedProvider,
      openPRProvider,
      closedPRProvider,
    ]) {
      provider.configChanged();
    }
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

      // The server state changed — drop cached lists + ETags so the
      // provider refreshes refetch instead of revalidating to 304s,
      // then let each issue provider rebuild from its own request.
      delete dataStore.cache["open"];
      delete dataStore.cache["closed"];
      delete dataStore.etags["open"];
      delete dataStore.etags["closed"];

      await Promise.all([
        openProvider.refresh(true),
        closedProvider.refresh(true),
      ]);
      openView.reload();
      closedView.reload();
      markRepoRefreshedIfLive(owner, repo);
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
