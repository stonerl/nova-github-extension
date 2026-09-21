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

function loadConfig() {
  const now = Date.now();
  if (configCache && now - configCacheAt < CONFIG_CACHE_TTL) {
    return configCache;
  }

  let result;

  // 1) Owner is mandatory. Workspace override wins, global fallback.
  const owner = readScoped(nova.config, "github.owner");
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
      repo: nova.workspace.config.get("github.repo"),
      refreshInterval: nova.config.get("github.refreshInterval"),
      maxRecentItems: nova.config.get("github.maxRecentItems"),
      itemsPerPage: nova.config.get("github.itemsPerPage"),
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

function getLastRefresh() {
  return nova.config.get("github.lastRefresh") || 0;
}

function setLastRefresh(ts) {
  try {
    nova.config.set("github.lastRefresh", ts);
  } catch (e) {
    console.warn("[Config] Failed to record last refresh:", e);
  }
}

module.exports = {
  CREDENTIALS_SERVICE,
  loadConfig,
  isConfigReady,
  updateContextAvailability,
  getLastRefresh,
  setLastRefresh,
  invalidateConfigCache,
  readSetting,
};
