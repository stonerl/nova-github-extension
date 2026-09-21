// lib/notify.js
// Throttled user-facing error surfacing. The console keeps the detailed
// log; this makes failures visible without one alert per item per
// refresh cycle.

const lastShownAt = {};
const THROTTLE_MS = 60_000;

function showThrottled(key, fn) {
  const now = Date.now();
  if (now - (lastShownAt[key] || 0) < THROTTLE_MS) return;
  lastShownAt[key] = now;
  fn();
}

function networkError() {
  showThrottled("network", () =>
    nova.workspace
      .showErrorMessage(
        "GitHub is unreachable — check your internet connection. Cached data is shown where available.",
      )
      .catch(() => {}),
  );
}

function authError() {
  showThrottled("auth", () =>
    nova.workspace
      .showErrorMessage(
        "GitHub rejected your token (401). Check the Personal Access Token in the extension settings.",
      )
      .catch(() => {}),
  );
}

function forbiddenError() {
  showThrottled("forbidden", () =>
    nova.workspace
      .showWarningMessage(
        "GitHub denied the request (403). Your token may be missing scopes (public_repo / repo), or the repository may be inaccessible.",
      )
      .catch(() => {}),
  );
}

function rateLimitError() {
  showThrottled("rate-limit", () =>
    nova.workspace
      .showWarningMessage(
        "GitHub API rate limit reached. Retrying automatically after the limit resets.",
      )
      .catch(() => {}),
  );
}

function configIncomplete() {
  showThrottled("config", () =>
    nova.workspace
      .showWarningMessage(
        "GitHub extension not configured — set Username, Token, and Repositories in the extension settings.",
      )
      .catch(() => {}),
  );
}

module.exports = {
  networkError,
  authError,
  forbiddenError,
  rateLimitError,
  configIncomplete,
};
