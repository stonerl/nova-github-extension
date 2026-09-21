// lib/config.js
// Extension settings, credentials, and readiness context.

const CREDENTIALS_SERVICE = "github-for-nova";

function loadConfig() {
  // 1) Owner is now mandatory. Read from the workspace scope first so
  //    each project can use its own account (e.g. a work organization),
  //    falling back to the global setting otherwise.
  const owner = nova.workspace.config.get("github.owner");
  if (!owner) {
    console.error("[Config] github.owner must be set");
    return { token: null, owner: null, repo: null /*…*/ };
  }

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
    console.warn("[Config] No GitHub token in Keychain for owner:", owner);
  }

  return {
    token,
    owner,
    repo: nova.workspace.config.get("github.repo"),
    refreshInterval: nova.config.get("github.refreshInterval"),
    maxRecentItems: nova.config.get("github.maxRecentItems"),
    itemsPerPage: nova.config.get("github.itemsPerPage"),
  };
}

function isConfigReady() {
  const { token, owner, repo } = loadConfig();
  return !!(token && owner && repo);
}

function updateContextAvailability() {
  nova.workspace.context.set("github.ready", isConfigReady());
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
};
