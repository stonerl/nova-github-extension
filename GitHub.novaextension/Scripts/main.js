// main.js
// Activation, sidebar wiring, commands, and issue state changes.

const {
  loadConfig,
  isConfigReady,
  updateContextAvailability,
  isRepoFresh,
  markRepoRefreshed,
  invalidateConfigCache,
  resolveOwner,
  getConfiguredRepoPairs,
  resolveActiveRepoPair,
  normalizeRepoRef,
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
let reconcileTimer = null; // delayed post-PATCH list reconciliation

// Record per-repo freshness only when the underlying cycle actually
// reached the network — budget-low, rate-limit, and network-error
// fallbacks serve cached/empty data that must not count as "fresh",
// or the auto-refresh guard would suppress retries for a full interval.
function markRepoRefreshedIfLive(owner, repo) {
  if (wasLiveFetch("open") && wasLiveFetch("closed")) {
    markRepoRefreshed(owner, repo);
  }
}

// Optimistically moved items (close/reopen) that the server's list
// endpoints may not reflect yet — GitHub lags behind PATCHes. Between
// the move and the server catching up, EVERY fetched list is corrected
// here so the item never jumps back to its old section. An entry is
// dropped once the fetched list genuinely contains the moved item, or
// after 120s (server truth wins; no infinite fighting).
const pendingMoves = new Map();
const PENDING_MOVE_TTL = 120_000;

function enforcePendingMoves(owner, repo) {
  const now = Date.now();
  for (const [key, move] of [...pendingMoves]) {
    if (move.owner !== owner || move.repo !== repo) continue;
    if (now - move.at > PENDING_MOVE_TTL) {
      pendingMoves.delete(key);
      continue;
    }
    const newList = dataStore.cache[move.newState] || [];
    const landed = newList.some(
      (i) => i.number === move.number && !i.__pendingMove,
    );
    if (landed) {
      pendingMoves.delete(key);
      continue;
    }
    const fromState = move.newState === "closed" ? "open" : "closed";
    const fromList = dataStore.cache[fromState];
    if (fromList) {
      const idx = fromList.findIndex((i) => i.number === move.number);
      if (idx >= 0) fromList.splice(idx, 1);
    }
    move.item.state = move.newState;
    move.item.state_reason = move.reason;
    move.item.closed_at =
      move.newState === "closed"
        ? move.item.closed_at || new Date().toISOString()
        : null;
    move.item.__pendingMove = true;
    (dataStore.cache[move.newState] =
      dataStore.cache[move.newState] || []).unshift(move.item);
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
    // Initial repos list AFTER detection loads: with detection memory
    // in place, the fallback selection (no workspace github.repo set)
    // claims the DETECTED repo instead of racing it and writing the
    // first configured repo over the anchor.
    updateRepoViews();
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
      enforcePendingMoves(owner, repo);

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
          enforcePendingMoves(owner, repo);
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
  // The Repositories section is declared in BOTH sidebars (Issues and
  // PRs) — each needs its own TreeView instance bound to its section
  // id; a single instance left the other sidebar's section without a
  // provider until a restart re-bound it. One provider drives both, so
  // the two views always render the same data.
  const reposPullView = new TreeView("repos-pull", {
    dataProvider: reposProvider,
  });
  nova.subscriptions.add(reposView, reposPullView);

  const wireRepoSelection = (view) => {
    view.onDidChangeSelection((items) => {
      const selected = items[0];
      // 1) ignore if they clicked nothing—or the separator visual
      if (!selected || selected.contextValue === "separator") {
        selectedRepoRow = null;
        return;
      }

      // Track the picked row: context commands cannot receive the
      // clicked TreeItem, so this is how copyUrl/openInBrowser know
      // which repo the user right-clicked. Both sidebar views share
      // this state — selecting in one sets the current repo for both.
      // Row identifiers are canonical "owner/repo" refs.
      selectedRepoRow = selected.identifier || null;

      const repoRefs = (getConfiguredRepoPairs() || []).map(
        (p) => `${p.owner}/${p.repo}`,
      );
      let newRepo = items[0]?.identifier;

      // if they didn’t actually pick one (or it’s no longer in the list),
      // default back to the very first repo
      if (!newRepo || !repoRefs.includes(newRepo)) {
        if (repoRefs.length === 0) {
          console.warn("[RepoSelect] No repos configured, nothing to do.");
          return;
        }
        newRepo = repoRefs[0];
        setWorkspaceConfig("github.repo", newRepo);
        invalidateConfigCache();
        console.log(
          `[RepoSelect] No valid selection → defaulting to "${newRepo}"`,
        );
      }

      const currentRef = normalizeRepoRef(
        nova.workspace.config.get("github.repo"),
        resolveOwner(),
      );
      if (newRepo === currentRef) {
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
      reposPullView.reload();
    });
  };
  wireRepoSelection(reposView);
  wireRepoSelection(reposPullView);

  const updateRepoViews = () => {
    // Deferred: this runs from config change notifications, and its
    // config reads must not nest inside Nova's notification dispatch.
    setTimeout(() => {
      reposProvider.updateRepoList();
      reposView.reload(); // tell Nova to repaint the UI
      reposPullView.reload();
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
      owner: loadConfig().homeOwner || loadConfig().owner,
      repos: getConfiguredRepoPairs() || [],
      activeRepo: resolveActiveRepoPair(),
      declined: nova.workspace.config.get("github.detectedDeclined"),
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
        if (response && response.actionIdx === 1) {
          // Explicit "No" — persist so this repo stops being asked
          // about on every workspace open. Deferred: no sync IPC
          // inside the notification dispatch. Dismissals (clicking
          // the notification away) are NOT recorded — they ask again.
          await wait(100);
          setWorkspaceConfig(
            "github.detectedDeclined",
            `${decision.owner}/${decision.repo}`,
          );
          console.log(`[RepoSelect] Declined ${label} for this workspace`);
          return;
        }
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
    enforcePendingMoves(netOwner, netRepo);

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
    enforcePendingMoves(owner, repo);

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
    //    repo row the user last picked (right-click target). Row refs
    //    carry their own owner, so org repos open under the right
    //    account even when it differs from the active one.
    const pairForRef = (ref) =>
      (getConfiguredRepoPairs() || []).find(
        (p) => `${p.owner}/${p.repo}` === ref,
      );
    const { owner, repo } = loadConfig();
    const target =
      (selectedRepoRow && pairForRef(selectedRepoRow)) ||
      (owner && repo ? { owner, repo } : null);
    if (target) {
      const repoURL = `https://github.com/${target.owner}/${target.repo}`;
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
    const pairForRef = (ref) =>
      (getConfiguredRepoPairs() || []).find(
        (p) => `${p.owner}/${p.repo}` === ref,
      );
    const { owner, repo } = loadConfig();
    const target =
      (selectedRepoRow && pairForRef(selectedRepoRow)) ||
      (owner && repo ? { owner, repo } : null);
    if (target) {
      const repoUrl = `https://github.com/${target.owner}/${target.repo}`;
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
    // Capture the active repo before the forget so we can tell whether
    // the forgotten repo was the selected one.
    const forgotten = resolveActiveRepoPair();
    forgetDetectionForWorkspace();
    // reset a recorded decline too — forgetting should ask again
    setWorkspaceConfig("github.detectedDeclined", "");

    // If the forgotten repo was the active one, drop the selection:
    // updateRepoViews' fallback re-selects the first remaining repo;
    // when none remain, "" resolves to nothing instead of a phantom.
    const remaining = getConfiguredRepoPairs() || [];
    const stillConfigured = remaining.some(
      (p) => p.owner === forgotten?.owner && p.repo === forgotten?.repo,
    );
    if (forgotten && !stillConfigured) {
      setWorkspaceConfig("github.repo", "");
    }

    // Purge the forgotten repo's data from the views immediately —
    // without this, the stale rootItems stayed visible until the next
    // successful refresh (and the stale selection even kept it being
    // fetched).
    dataStore.cache = {};
    dataStore.etags = {};
    dataStore.pullDetails = {};
    for (const provider of [
      openProvider,
      closedProvider,
      openPRProvider,
      closedPRProvider,
    ]) {
      provider.rootItems = [];
      provider.itemsById.clear();
    }

    invalidateConfigCache();
    console.log("[RepoSelect] Detection forgotten for this workspace");
    updateRepoViews();
    openView.reload();
    closedView.reload();
    openPRView.reload();
    closedPRView.reload();
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
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
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

      // GitHub's list endpoints lag behind PATCHes (eventually
      // consistent) — an immediate refetch returns the OLD lists, so
      // the moved item would vanish from its old section and only
      // appear in the right one after a later cycle. Move the item
      // optimistically in the cached lists and rebuild all four
      // providers (issue/pull × open/closed share the per-state
      // lists) without touching the network.
      const fromState = newState === "closed" ? "open" : "closed";
      const fromList = dataStore.cache[fromState] || [];
      const idx = fromList.findIndex((i) => i.number === issueNumber);
      let moved = null;
      if (idx >= 0) {
        [moved] = fromList.splice(idx, 1);
        moved.state = newState;
        moved.state_reason = reason;
        moved.__pendingMove = true;
        moved.closed_at =
          newState === "closed"
            ? moved.closed_at || new Date().toISOString()
            : null;
        dataStore.cache[newState] = dataStore.cache[newState] || [];
        dataStore.cache[newState].unshift(moved);
      }

      const reloadFromCache = () => {
        // All four providers share the two per-state lists; rebuild
        // each from cache and repaint. refreshWithData is async — the
        // reloads chain off the rebuilds.
        const pairs = [
          [openProvider, openView],
          [closedProvider, closedView],
          [openPRProvider, openPRView],
          [closedPRProvider, closedPRView],
        ];
        for (const [provider, view] of pairs) {
          provider
            .refreshWithData(dataStore.cache[provider.state] || [])
            .then((rebuilt) => {
              if (rebuilt) view.reload();
            });
        }
      };

      if (moved) {
        pendingMoves.set(`${owner}/${repo}#${issueNumber}`, {
          owner,
          repo,
          number: issueNumber,
          newState,
          reason,
          item: moved,
          at: Date.now(),
        });
        reloadFromCache();

        // Reconcile with server truth once its lists have caught up —
        // normalizes timestamps and ordering. If GitHub still lags,
        // enforcePendingMoves corrects the fetched lists so the item
        // stays put; the next auto-refresh (ETags intact → cheap)
        // settles it for good.
        if (reconcileTimer) clearTimeout(reconcileTimer);
        reconcileTimer = setTimeout(async () => {
          reconcileTimer = null;
          delete dataStore.etags["open"];
          delete dataStore.etags["closed"];
          try {
            await Promise.all([
              dataStore.fetchState("open", token, owner, repo),
              dataStore.fetchState("closed", token, owner, repo),
            ]);
          } catch (err) {
            console.warn("[Update] Reconciliation fetch failed:", err);
          }
          enforcePendingMoves(owner, repo);
          reloadFromCache();
          markRepoRefreshedIfLive(owner, repo);
        }, 3000);
      } else {
        // Item not in the in-memory cache — no optimistic move
        // possible; fall back to the immediate refetch, then enforce
        // any other pending moves before the views rebuild.
        delete dataStore.cache["open"];
        delete dataStore.cache["closed"];
        delete dataStore.etags["open"];
        delete dataStore.etags["closed"];
        await Promise.all([
          dataStore.fetchState("open", token, owner, repo),
          dataStore.fetchState("closed", token, owner, repo),
        ]);
        enforcePendingMoves(owner, repo);
        reloadFromCache();
        markRepoRefreshedIfLive(owner, repo);
      }
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
