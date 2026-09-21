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

// Nova versions differ: showErrorMessage/showWarningMessage may return
// a Promise or nothing at all. Calling .catch on undefined throws —
// so handle every shape defensively; the console log keeps details.
function showAlert(method, message) {
  try {
    const result = method.call(nova.workspace, message);
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch {
    // alert display failed — the console log still has the details
  }
}

function authError() {
  showThrottled("auth", () =>
    showAlert(
      nova.workspace.showErrorMessage,
      "GitHub rejected your token (401). Check the Personal Access Token in the extension settings.",
    ),
  );
}

function forbiddenError() {
  showThrottled("forbidden", () =>
    showAlert(
      nova.workspace.showWarningMessage,
      "GitHub denied the request (403). Your token may be missing scopes (public_repo / repo), or the repository may be inaccessible.",
    ),
  );
}

// 404 = no access (GitHub answers unauthorized private-repo access with
// 404, not 403) or a deleted/renamed repo. Shown ONCE per session —
// it would otherwise repeat every refresh cycle until it's fixed.
let notFoundShown = false;

function notFoundError() {
  if (notFoundShown) return;
  notFoundShown = true;
  showAlert(
    nova.workspace.showWarningMessage,
    "Repository not found (404) — it may have been deleted or renamed, or your Personal Access Token lacks access (private repositories need the 'repo' scope).",
  );
}

function rateLimitError() {
  showThrottled("rate-limit", () =>
    showAlert(
      nova.workspace.showWarningMessage,
      "GitHub API rate limit reached. Retrying automatically after the limit resets.",
    ),
  );
}

function budgetLow(remaining) {
  showThrottled("budget", () =>
    showAlert(
      nova.workspace.showWarningMessage,
      `GitHub API budget low (${remaining} requests left) — auto-refresh paused until the limit resets. Manual refresh still works.`,
    ),
  );
}

function configIncomplete() {
  showThrottled("config", () =>
    showAlert(
      nova.workspace.showWarningMessage,
      "GitHub extension not configured — set Username, Token, and Repositories in the extension settings.",
    ),
  );
}

module.exports = {
  authError,
  forbiddenError,
  notFoundError,
  rateLimitError,
  budgetLow,
  configIncomplete,
};
