// lib/cache.js
// Disk cache for issues/PRs and comments, stored per owner/repo
// under the extension's global storage.

const { loadConfig } = require("./config.js");

const cacheDir = `${nova.extension.globalStoragePath}/cache`;

function ensureDirExists(dir) {
  try {
    nova.fs.mkdir(dir);
  } catch (err) {
    // if it already exists, mkdir will throw; ignore that
    // any other error you’d probably want to know about
  }
}

function cachePath(type, state) {
  const { owner, repo } = loadConfig();
  const repoDir = `${cacheDir}/${owner}-${repo}`;

  ensureDirExists(repoDir);

  return `${repoDir}/${type}-${state}.json`; // e.g. pull-open.json
}

function saveCache(type, state, data) {
  const path = cachePath(type, state);
  try {
    const file = nova.fs.open(path, "w+t");
    file.write(JSON.stringify(data));
    file.close();
  } catch (e) {
    console.warn("[Cache] write failed:", e);
  }
}

function loadCache(type, state) {
  const path = cachePath(type, state);
  try {
    const file = nova.fs.open(path, "r");
    const text = file.read();
    file.close();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function commentCachePath(type, number) {
  const { owner, repo } = loadConfig();
  const repoDir = `${cacheDir}/${owner}-${repo}`;
  ensureDirExists(repoDir);
  return `${repoDir}/comments-${type}-${number}.json`;
}

function saveCommentCache(type, number, etag, data) {
  const path = commentCachePath(type, number);
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

function loadCommentCache(type, number) {
  const path = commentCachePath(type, number);
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
  cachePath,
  saveCache,
  loadCache,
  commentCachePath,
  saveCommentCache,
  loadCommentCache,
};
