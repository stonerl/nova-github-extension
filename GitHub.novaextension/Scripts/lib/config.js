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

function getConfiguredRepos() {
  const ws = nova.workspace.config.get("github.repos");
  if (ws !== null && ws !== undefined) return ws;
  if (detectedWorkspace) return [detectedWorkspace.repo];
  return nova.config.get("github.repos");
}

function resolveActiveRepo() {
  const ws = nova.workspace.config.get("github.repo");
  if (ws !== null && ws !== undefined) return ws;
  if (detectedWorkspace) return detectedWorkspace.repo;
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

  // 1) Owner is mandatory. Precedence: explicit workspace override >
  //    detected workspace account > global setting.
  const owner = resolveOwner();
  if (!owner) {
    logThrottled("no-owner", () =>
      console.error("[Config] github.owner must be set"),
    );
    result = { token: null, owner: null, repo: null /*…*/ };
  } else {
    // 2) First try to load under the real owner
    let token = nova.credentials.getPassword(CREDENTIALS_SERVICE, owner);

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
      repo: resolveActiveRepo(),
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
  getConfiguredRepos,
  resolveActiveRepo,
  detectedOverride,
  loadDetections,
  saveDetectionForWorkspace,
  forgetDetectionForWorkspace,
  setGlobalConfig,
  setWorkspaceConfig,
  skipInitialCall,
};
