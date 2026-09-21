// lib/cache.js
// Disk cache for issues/PRs and comments, stored per owner/repo
// under the extension's global storage. Owner/repo are passed in by
// callers — reading them from config on every cache access caused a
// config IPC storm in the Nova app process.

const cacheDir = `${nova.extension.globalStoragePath}/cache`;

// Directories already ensured this session — mkdir on every cache
// access would throw/catch across the fs bridge per call.
const ensuredDirs = new Set();

function ensureDirExists(dir) {
  if (ensuredDirs.has(dir)) return;
  try {
    nova.fs.mkdir(dir);
  } catch (err) {
    // if it already exists, mkdir will throw; ignore that
    // any other error you’d probably want to know about
  }
  ensuredDirs.add(dir);
}

function repoDirFor(owner, repo) {
  const repoDir = `${cacheDir}/${owner}-${repo}`;
  ensureDirExists(repoDir);
  return repoDir;
}

function cachePath(state, owner, repo) {
  return `${repoDirFor(owner, repo)}/${state}.json`; // e.g. open.json
}

function saveCache(state, data, owner, repo) {
  const path = cachePath(state, owner, repo);
  try {
    const file = nova.fs.open(path, "w+t");
    file.write(JSON.stringify(data));
    file.close();
  } catch (e) {
    console.warn("[Cache] write failed:", e);
  }
}

function loadCache(state, owner, repo) {
  const path = cachePath(state, owner, repo);
  try {
    const file = nova.fs.open(path, "r");
    const text = file.read();
    file.close();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function commentCachePath(type, number, owner, repo) {
  return `${repoDirFor(owner, repo)}/comments-${type}-${number}.json`;
}

function saveCommentCache(
  type,
  number,
  etag,
  data,
  issueUpdatedAt,
  owner,
  repo,
) {
  const path = commentCachePath(type, number, owner, repo);
  const payload = { etag, data, issueUpdatedAt };
  try {
    // 'w+t' will create the file if it doesn't exist
    const file = nova.fs.open(path, "w+t");
    file.write(JSON.stringify(payload));
    file.close();
  } catch (e) {
    console.warn(`[Cache] Failed to save ${type} #${number} comments:`, e);
  }
}

function loadCommentCache(type, number, owner, repo) {
  const path = commentCachePath(type, number, owner, repo);
  try {
    const file = nova.fs.open(path, "r");
    const text = file.read();
    file.close();
    const { etag, data, issueUpdatedAt } = JSON.parse(text);
    return { etag, data, count: data.length, issueUpdatedAt };
  } catch {
    return { etag: null, data: [], count: 0, issueUpdatedAt: null };
  }
}

// Removes orphaned files from a repo's cache directory after a
// successful refresh: comment caches for items no longer in any
// fetched list, legacy per-type list caches, and sibling directories
// from failed resolutions ("owner-null"). Each removal is
// independent — a failure is retried on the next prune.
function pruneCaches(owner, repo, keepNumbers) {
  const keep = new Set(keepNumbers);

  try {
    for (const entry of nova.fs.listdir(cacheDir)) {
      const entryPath = `${cacheDir}/${entry}`;

      // sibling directories from failed owner/repo resolutions
      if (entry.endsWith("-null")) {
        try {
          for (const inner of nova.fs.listdir(entryPath)) {
            nova.fs.remove(`${entryPath}/${inner}`);
          }
          nova.fs.rmdir(entryPath);
        } catch {
          // retry next prune
        }
        continue;
      }

      if (entry !== `${owner}-${repo}`) continue;
      const repoDirPath = entryPath;

      try {
        for (const file of nova.fs.listdir(repoDirPath)) {
          // legacy per-type list caches (pre-state-naming)
          if (/^(issue|pull)-(open|closed)\.json$/.test(file)) {
            try {
              nova.fs.remove(`${repoDirPath}/${file}`);
            } catch {}
            continue;
          }

          // comment caches for items no longer in any fetched list
          const match = file.match(/^comments-(issue|pull)-(\d+)\.json$/);
          if (match && !keep.has(Number(match[2]))) {
            try {
              nova.fs.remove(`${repoDirPath}/${file}`);
            } catch {}
          }
        }
      } catch {
        // repo dir unreadable — retry next prune
      }
    }
  } catch {
    // cache dir unreadable — nothing to prune
  }
}

module.exports = {
  cacheDir,
  ensureDirExists,
  repoDirFor,
  cachePath,
  saveCache,
  loadCache,
  commentCachePath,
  saveCommentCache,
  loadCommentCache,
  pruneCaches,
};
