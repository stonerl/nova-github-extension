// lib/config.js
// Extension settings, credentials, and readiness context.
//
// Nova semantics note: `nova.workspace.config.get(key)` only returns a
// value that was explicitly set at the workspace level — it does NOT
// fall back to the global extension preference. The workspace value is
// therefore combined manually (workspace ?? global) below.

const CREDENTIALS_SERVICE = "github-for-nova";

// loadConfig() crosses into the Nova app process for every read (plus
// a Keychain round-trip), so results are cached briefly. Call
// invalidateConfigCache() after changing any github.* setting or
// observing a change to one.
const CONFIG_CACHE_TTL = 1000;
let configCache = null;
let configCacheAt = 0;

function invalidateConfigCache() {
  configCache = null;
  configCacheAt = 0;
}

// Console messages cross into Nova's process — floods of them can lock
// up the UI bridge. Repeating warnings go out at most once per 30s.
const lastLogAt = {};
function logThrottled(key, fn) {
  const now = Date.now();
  if (lastLogAt[key] && now - lastLogAt[key] < 30_000) return;
  lastLogAt[key] = now;
  fn();
}

function readScoped(config, key) {
  const workspaceValue = nova.workspace.config.get(key);
  if (workspaceValue !== null && workspaceValue !== undefined) {
    return workspaceValue;
  }
  return config.get(key);
}

function readSetting(key) {
  return readScoped(nova.config, key);
}

// Repo auto-detection never writes workspace config: single config
// writes have been observed to amplify into thousands of writes inside
// Nova (write storm → freeze). Instead, detections are kept in memory
// and persisted in the extension's own global storage file. Explicit
// settings (manual workspace overrides) still win over detection.
const detectionsPath = `${nova.extension.globalStoragePath}/detections.json`;
let detectedWorkspace = null; // { owner, repo } for this workspace path

function parseDetectedEntry(raw) {
  if (!raw || typeof raw !== "string") return null;
  const slash = raw.indexOf("/");
  if (slash < 1 || slash === raw.length - 1) return null;
  return { owner: raw.slice(0, slash), repo: raw.slice(slash + 1) };
}

function loadDetections() {
  try {
    const file = nova.fs.open(detectionsPath, "r");
    const text = file.read();
    file.close();
    const map = JSON.parse(text);
    detectedWorkspace = parseDetectedEntry(map[nova.workspace.path]);
  } catch {
    detectedWorkspace = null; // no file yet, or unreadable
  }
}

function saveDetectionForWorkspace(owner, repo) {
  let map = {};
  try {
    const file = nova.fs.open(detectionsPath, "r");
    const text = file.read();
    file.close();
    map = JSON.parse(text);
  } catch {
    // no file yet
  }
  const path = nova.workspace.path;
  if (!path) return;
  map[path] = `${owner}/${repo}`;
  try {
    const file = nova.fs.open(detectionsPath, "w+t");
    file.write(JSON.stringify(map, null, 2));
    file.close();
  } catch (e) {
    console.warn("[Detect] Failed to persist detection:", e);
  }
  detectedWorkspace = { owner, repo };
}

function detectedOverride() {
  return detectedWorkspace;
}

// Tokens are keyed in the Keychain by the AUTHENTICATED login (one
// entry per GitHub account), not by repo owner — a personal login and
// the orgs it can access share one credential, so a rotation updates
// all of them at once. Which owner belongs to which account is learned
// at runtime and persisted in the extension's own storage file (same
// discipline as detections: no config writes, no bursts).
const accountsPath = `${nova.extension.globalStoragePath}/accounts.json`;
let orgToLogin = null; // lazy: { "<repo-owner>": "<login>" }

function loadOrgToLogin() {
  if (orgToLogin) return orgToLogin;
  try {
    const file = nova.fs.open(accountsPath, "r");
    const text = file.read();
    file.close();
    const parsed = JSON.parse(text);
    orgToLogin =
      parsed && typeof parsed.orgToLogin === "object" && parsed.orgToLogin
        ? parsed.orgToLogin
        : {};
  } catch {
    orgToLogin = {}; // no file yet, or unreadable
  }
  return orgToLogin;
}

function persistOrgToLogin() {
  try {
    const file = nova.fs.open(accountsPath, "w+t");
    file.write(JSON.stringify({ orgToLogin: orgToLogin || {} }, null, 2));
    file.close();
  } catch (e) {
    console.warn("[Config] Failed to persist account mapping:", e);
  }
}

// Called after a token is confirmed to belong to `login` (via the
// /user probe) while working with repo owner `owner`.
function recordOwnerLogin(owner, login) {
  if (!owner || !login) return;
  const map = loadOrgToLogin();
  if (map[owner] === login) return;
  map[owner] = login;
  persistOrgToLogin();
}

function loginForOwner(owner) {
  if (!owner) return null;
  return loadOrgToLogin()[owner] || null;
}

function forgetOwnerLogin(owner) {
  if (!owner) return;
  const map = loadOrgToLogin();
  if (!map[owner]) return;
  delete map[owner];
  persistOrgToLogin();
}

// Known repo owners across this installation: the global setting plus
// every owner recorded in the detections file. Used by the one-time
// /user backfill that maps legacy per-owner tokens to logins.
function knownOwners() {
  const owners = new Set();
  const globalOwner = nova.config.get("github.owner");
  if (globalOwner) owners.add(globalOwner);
  try {
    const file = nova.fs.open(detectionsPath, "r");
    const text = file.read();
    file.close();
    const map = JSON.parse(text);
    for (const value of Object.values(map || {})) {
      const detected = parseDetectedEntry(value);
      if (detected) owners.add(detected.owner);
    }
  } catch {
    // no detections file — global owner only
  }
  return [...owners];
}

// Global feature toggle: whether the extension reads .git/config and
// offers detected repos. On by default; persisted detections keep
// resolving while it is off (forgetDetection removes one).
function isAutoDetectEnabled() {
  return nova.config.get("github.autoDetectRepos") !== false;
}

// Repo entries may be owner-prefixed ("CrankBoyHQ/crankboy-app") or
// bare ("crankboy-app"). A bare name belongs to the account of the
// list it was written in: workspace-list entries resolve against the
// workspace's owner (override, else detection, else global), global-
// list entries against the global owner — so "global list → global
// token" holds even when a workspace override is active.

// "CrankBoyHQ/x" → {owner, repo} literal; "x" → {owner: contextOwner,
// repo}; anything malformed → null.
function resolveRepoEntry(entry, contextOwner) {
  if (!entry || typeof entry !== "string") return null;
  const slash = entry.indexOf("/");
  if (slash < 1) {
    if (entry.includes("/")) return null; // malformed ("", "/x", "a/")
    if (!contextOwner) return null;
    return { owner: contextOwner, repo: entry };
  }
  const owner = entry.slice(0, slash);
  const repo = entry.slice(slash + 1);
  if (!owner || !repo || repo.includes("/")) return null;
  return { owner, repo };
}

// Canonical always-prefixed form — used for identifiers, comparisons,
// and persisted selections so same-named repos of different owners
// stay distinct everywhere.
function normalizeRepoRef(entry, contextOwner) {
  const pair = resolveRepoEntry(entry, contextOwner);
  return pair ? `${pair.owner}/${pair.repo}` : null;
}

// True when this owner/repo pair is what the workspace is actually
// configured for right now (a configured pair, or the active repo).
// Used to keep 404 alerts meaningful: a fetch for a stale or
// unconfirmed repo (detection prompt still pending, or a leftover
// workspace github.repo from another account) must not surface a
// scary "repository not found" alert.
function isConfiguredRepo(owner, repo) {
  if (!owner || !repo) return false;
  const active = resolveActiveRepoPair();
  if (active && active.owner === owner && active.repo === repo) return true;
  const pairs = getConfiguredRepoPairs() || [];
  return pairs.some((p) => p.owner === owner && p.repo === repo);
}

// Removes this workspace's entry from the detection file and clears
// the in-memory state; the sidebar falls back to explicit settings.
function forgetDetectionForWorkspace() {
  const path = nova.workspace.path;
  if (!path) return;
  let map = {};
  try {
    const file = nova.fs.open(detectionsPath, "r");
    const text = file.read();
    file.close();
    map = JSON.parse(text);
  } catch {
    map = {};
  }
  delete map[path];
  try {
    const file = nova.fs.open(detectionsPath, "w+t");
    file.write(JSON.stringify(map, null, 2));
    file.close();
  } catch (e) {
    console.warn("[Detect] Failed to update detection file:", e);
  }
  detectedWorkspace = null;
}

function resolveOwner() {
  const ws = nova.workspace.config.get("github.owner");
  if (ws !== null && ws !== undefined) return ws;
  const detected = detectedWorkspace;
  if (detected) return detected.owner;
  return nova.config.get("github.owner");
}

// The configured repositories as RESOLVED PAIRS. Sources:
//   1. the auto-detected repo — always first, literal owner/repo
//   2. the workspace list (entries resolved against the workspace's
//      owner: override, else detection, else global) — or, absent a
//      workspace list, the global list (entries resolved against the
//      global owner — never mixed with the workspace scope)
//   3. with github.includeGlobalRepos: global entries appended after
//      the workspace's own (still resolved against the GLOBAL owner)
// Dedupe is pair-keyed: the same repo name under two owners is two
// repositories; the workspace list wins position on exact pair
// collisions.
function getConfiguredRepoPairs() {
  const wsOwner = nova.workspace.config.get("github.owner");
  const globalOwner = nova.config.get("github.owner");
  const wsList = nova.workspace.config.get("github.repos");
  const globalList = nova.config.get("github.repos");
  const includeGlobal =
    nova.workspace.config.get("github.includeGlobalRepos") === true;

  const pairs = [];
  const push = (pair) => {
    if (
      pair &&
      !pairs.some((p) => p.owner === pair.owner && p.repo === pair.repo)
    ) {
      pairs.push(pair);
    }
  };

  if (detectedWorkspace) {
    push({ owner: detectedWorkspace.owner, repo: detectedWorkspace.repo });
  }

  const wsPairs = (Array.isArray(wsList) ? wsList : []).map((entry) =>
    resolveRepoEntry(entry, wsOwner || resolveOwner()),
  );
  const globalPairs = (Array.isArray(globalList) ? globalList : []).map(
    (entry) => resolveRepoEntry(entry, globalOwner),
  );

  if (wsList !== null && wsList !== undefined) {
    wsPairs.forEach(push);
    if (includeGlobal) globalPairs.forEach(push);
  } else {
    globalPairs.forEach(push);
  }

  return pairs;
}

// The ACTIVE repository as a resolved pair: the workspace's github.repo
// selection (resolved like a workspace-list entry) or the detected
// repo. Null when neither exists.
function resolveActiveRepoPair() {
  const entry = nova.workspace.config.get("github.repo");
  if (entry !== null && entry !== undefined && entry !== "") {
    return resolveRepoEntry(entry, resolveOwner());
  }
  if (detectedWorkspace) {
    return {
      owner: detectedWorkspace.owner,
      repo: detectedWorkspace.repo,
    };
  }
  return null;
}

// Audit every config write the extension performs. If Nova ever
// amplifies a write into a storm, the Extension Console names the
// call site and the count immediately.
let configSetCount = 0;
function setGlobalConfig(key, value) {
  configSetCount++;
  console.log(
    `[SetAudit] #${configSetCount} ${key} = ${JSON.stringify(value)}`,
  );
  nova.config.set(key, value);
}

function setWorkspaceConfig(key, value) {
  configSetCount++;
  console.log(
    `[SetAudit] #${configSetCount} workspace ${key} = ${JSON.stringify(value)}`,
  );
  nova.workspace.config.set(key, value);
}

// Enum settings come back as strings ("50"); numeric coercion keeps
// comparisons like maxRecentItems <= itemsPerPage working so ETag
// revalidation stays enabled.
function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Nova config observers fire once with the current value at
// registration. That initial notification must not reach our
// callbacks — they would re-enter config reads during activation,
// widening the deadlock window with other extensions. Only real
// changes are forwarded. (Same pattern as nova-prettier-extension.)
function skipInitialCall(fn) {
  let skipped = false;
  return function (...args) {
    if (!skipped) {
      skipped = true;
      return;
    }
    fn.apply(this, args);
  };
}

function loadConfig() {
  const now = Date.now();
  if (configCache && now - configCacheAt < CONFIG_CACHE_TTL) {
    return configCache;
  }

  let result;

  // 1) The fetch owner is the ACTIVE REPO'S OWN owner: bare selections
  //    resolve against the workspace's account, owner-prefixed
  //    selections ("CrankBoyHQ/app") carry their own. Token resolution
  //    falls back to the workspace's home account so org repos work
  //    with the user's own PAT.
  const homeOwner = resolveOwner();
  const activePair = resolveActiveRepoPair();
  const owner = activePair ? activePair.owner : homeOwner;
  if (!owner) {
    logThrottled("no-owner", () =>
      console.error("[Config] github.owner must be set"),
    );
    result = { token: null, owner: null, repo: null /*…*/ };
  } else {
    // 2) Token resolution, newest model first:
    //    a) Keychain entry of the ACCOUNT that owns this repo (learned
    //       via the /user probe) — personal login and orgs share one
    //       token, so rotations propagate everywhere at once.
    //    b) Legacy per-owner entry from earlier versions.
    //    c) The home account's token (workspace or global) — covers
    //       owner-prefixed repos of orgs the user can access.
    //    d) Legacy "default" entry, migrated over once.
    const tokenFor = (accountOwner) => {
      if (!accountOwner) return null;
      const mappedLogin = loginForOwner(accountOwner);
      if (mappedLogin) {
        const mapped = nova.credentials.getPassword(
          CREDENTIALS_SERVICE,
          mappedLogin,
        );
        if (mapped) return mapped;
      }
      return nova.credentials.getPassword(CREDENTIALS_SERVICE, accountOwner);
    };

    let token = tokenFor(owner);
    if (!token && homeOwner && homeOwner !== owner) {
      token = tokenFor(homeOwner);
    }

    // 3) If this is the first time they've set an owner,
    //    migrate the old “default” token over
    if (!token) {
      const defaultToken = nova.credentials.getPassword(
        CREDENTIALS_SERVICE,
        "default",
      );
      if (defaultToken) {
        nova.credentials.setPassword(CREDENTIALS_SERVICE, owner, defaultToken);
        nova.credentials.removePassword(CREDENTIALS_SERVICE, "default");
        token = defaultToken;
        console.log(`[Config] Migrated token from “default” → “${owner}”`);
      }
    }

    if (!token) {
      logThrottled("no-token", () =>
        console.warn("[Config] No GitHub token in Keychain for owner:", owner),
      );
    }

    result = {
      token,
      owner,
      homeOwner: homeOwner !== owner ? homeOwner : null,
      repo: activePair ? activePair.repo : null,
      refreshInterval: toNumber(nova.config.get("github.refreshInterval"), 30),
      maxRecentItems: toNumber(nova.config.get("github.maxRecentItems"), 50),
      itemsPerPage: toNumber(nova.config.get("github.itemsPerPage"), 100),
    };
  }

  // Cache incomplete results too: while config is missing, observers
  // and refreshes still call loadConfig constantly, and without this
  // every call would repeat the config round-trips.
  configCache = result;
  configCacheAt = now;
  return result;
}

function isConfigReady() {
  const { token, owner, repo } = loadConfig();
  return !!(token && owner && repo);
}

let lastReadyValue = null;

function updateContextAvailability() {
  const ready = isConfigReady();
  if (ready === lastReadyValue) return;
  lastReadyValue = ready;
  nova.workspace.context.set("github.ready", ready);
}

// Per-repo freshness tracking. Timestamps live in memory only — the
// map starts empty on every extension start, so the first load after
// opening a workspace always treats the active repo as stale and
// fetches once (the old single global github.lastRefresh config key
// masked staleness across workspaces/repos and cost one config write
// per refresh cycle).
const lastRefreshByRepo = new Map();

function repoKey(owner, repo) {
  return `${owner}/${repo}`;
}

// True when this repo was fully fetched by this extension instance
// within intervalMs. Unknown repos are always stale.
function isRepoFresh(owner, repo, intervalMs) {
  if (!owner || !repo || !(intervalMs > 0)) return false;
  const last = lastRefreshByRepo.get(repoKey(owner, repo));
  if (!last) return false;
  return Date.now() - last < intervalMs;
}

function markRepoRefreshed(owner, repo) {
  if (!owner || !repo) return;
  lastRefreshByRepo.set(repoKey(owner, repo), Date.now());
}

function resetRefreshTracking() {
  lastRefreshByRepo.clear();
}

module.exports = {
  CREDENTIALS_SERVICE,
  loadConfig,
  isConfigReady,
  updateContextAvailability,
  isRepoFresh,
  markRepoRefreshed,
  resetRefreshTracking,
  invalidateConfigCache,
  readSetting,
  resolveOwner,
  resolveRepoEntry,
  normalizeRepoRef,
  getConfiguredRepoPairs,
  resolveActiveRepoPair,
  detectedOverride,
  loadDetections,
  saveDetectionForWorkspace,
  forgetDetectionForWorkspace,
  recordOwnerLogin,
  loginForOwner,
  forgetOwnerLogin,
  knownOwners,
  isConfiguredRepo,
  isAutoDetectEnabled,
  setGlobalConfig,
  setWorkspaceConfig,
  skipInitialCall,
};
