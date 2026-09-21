// lib/cache.js
// Disk cache for issues/PRs and comments, stored per owner/repo
// under the extension's global storage. Owner/repo are passed in by
// callers — reading them from config on every cache access caused a
// config IPC storm in the Nova app process.

const cacheDir = `${nova.extension.globalStoragePath}/cache`;

function ensureDirExists(dir) {
  try {
    nova.fs.mkdir(dir);
  } catch (err) {
    // if it already exists, mkdir will throw; ignore that
    // any other error you’d probably want to know about
  }
}

function repoDirFor(owner, repo) {
  const repoDir = `${cacheDir}/${owner}-${repo}`;
  ensureDirExists(repoDir);
  return repoDir;
}

function cachePath(type, state, owner, repo) {
  return `${repoDirFor(owner, repo)}/${type}-${state}.json`; // e.g. pull-open.json
}

function saveCache(type, state, data, owner, repo) {
  const path = cachePath(type, state, owner, repo);
  try {
    const file = nova.fs.open(path, "w+t");
    file.write(JSON.stringify(data));
    file.close();
  } catch (e) {
    console.warn("[Cache] write failed:", e);
  }
}

function loadCache(type, state, owner, repo) {
  const path = cachePath(type, state, owner, repo);
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

function saveCommentCache(type, number, etag, data, owner, repo) {
  const path = commentCachePath(type, number, owner, repo);
  const payload = { etag, data };
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
    const { etag, data } = JSON.parse(text);
    return { etag, data, count: data.length };
  } catch {
    return { etag: null, data: [], count: 0 };
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
};
