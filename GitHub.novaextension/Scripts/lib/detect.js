// lib/detect.js
// Detects the GitHub repository for the current workspace from its
// .git/config. Policy decisions are pure so they can be tested without
// Nova; the caller applies the decision.

/**
 * Extract an owner/repo pair from a remote URL. Handles
 *   https://github.com/owner/repo(.git)
 *   ssh://git@github.com/owner/repo(.git)
 *   git@github.com:owner/repo(.git)
 * and ignores non-GitHub remotes.
 */
function parseRemoteUrl(url) {
  const match = url.match(
    /^(?:https?|ssh):\/\/(?:[^/@]+@)?github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  if (match) return { owner: match[1], repo: match[2] };

  const scpMatch = url.match(
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  if (scpMatch) return { owner: scpMatch[1], repo: scpMatch[2] };

  return null;
}

/**
 * Parse the text of a .git/config file and return the first usable
 * GitHub remote as { owner, repo }, preferring the "origin" remote.
 * Returns null when there is none.
 */
function parseGitConfig(text) {
  if (!text) return null;

  let currentRemote = null;
  let originPair = null;
  let firstPair = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    const sectionMatch = line.match(/^\[remote\s+"([^"]+)"\]/);
    if (sectionMatch) {
      currentRemote = sectionMatch[1];
      continue;
    }
    if (line.startsWith("[")) {
      currentRemote = null;
      continue;
    }

    const urlMatch = line.match(/^url\s*=\s*(\S+)$/);
    if (!urlMatch || !currentRemote) continue;

    const pair = parseRemoteUrl(urlMatch[1]);
    if (!pair) continue;

    if (currentRemote === "origin" && !originPair) originPair = pair;
    if (!firstPair) firstPair = pair;
  }

  return originPair || firstPair;
}

/**
 * Decide what to do with a detected repo, given the current setup:
 *   - none:               nothing to do (incl. a previously declined
 *                         detection for exactly this owner/repo)
 *   - setActiveRepo:      same account, repo already configured —
 *                         safe to switch the active repo silently
 *   - confirmNewAccount:  different account or unknown repo — needs
 *                         explicit confirmation before applying
 *
 * `current.repos` holds resolved {owner, repo} pairs and
 * `current.activeRepo` the active pair; bare config entries arrive
 * pre-resolved by the caller.
 */
function decideDetection(detected, current) {
  if (!detected) return { type: "none" };

  if (current.declined === `${detected.owner}/${detected.repo}`) {
    return { type: "none" }; // user said "No" to this repo before
  }

  const sameOwner = detected.owner === current.owner;
  const samePair = (pair) =>
    !!pair && pair.owner === detected.owner && pair.repo === detected.repo;
  const inList = (current.repos || []).some(samePair);

  if (sameOwner && inList) {
    if (samePair(current.activeRepo)) return { type: "none" };
    return {
      type: "setActiveRepo",
      owner: detected.owner,
      repo: detected.repo,
    };
  }

  if (sameOwner && samePair(current.activeRepo)) {
    return { type: "none" };
  }

  return {
    type: "confirmNewAccount",
    owner: detected.owner,
    repo: detected.repo,
  };
}

module.exports = { parseRemoteUrl, parseGitConfig, decideDetection };
