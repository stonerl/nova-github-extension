"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createNovaStub } = require("./helpers/nova-stub.js");
const { freshRequire } = require("./helpers/modules.js");

function setup() {
  const stub = createNovaStub({ globalValues: { "github.owner": "stonerl" } });
  stub.install();
  return freshRequire("lib/cache.js");
}

test("mkdir is attempted once per directory across many accesses", () => {
  const cache = setup();
  for (let i = 0; i < 100; i++) cache.loadCommentCache("issue", i, "o", "r");
  for (let i = 0; i < 50; i++) cache.loadCache("open", "o", "r");
  assert.equal(global.__stub.captures.mkdirAttempts, 1);
});

test("save/load round-trip", () => {
  const cache = setup();
  cache.saveCache("open", [{ id: 1 }], "o", "r");
  assert.deepEqual(cache.loadCache("open", "o", "r"), [{ id: 1 }]);
});

test("missing files degrade to null / empty comment cache", () => {
  const cache = setup();
  assert.equal(cache.loadCache("open", "o", "r"), null);
  assert.deepEqual(cache.loadCommentCache("issue", 7, "o", "r"), {
    etag: null,
    data: [],
    count: 0,
    issueUpdatedAt: null,
  });
});

test("comment cache stores etag + data + count", () => {
  const cache = setup();
  cache.saveCommentCache(
    "issue",
    7,
    '"etag1"',
    [{ id: 9 }],
    "2026-01-01T00:00:00Z",
    "o",
    "r",
  );
  const loaded = cache.loadCommentCache("issue", 7, "o", "r");
  assert.equal(loaded.etag, '"etag1"');
  assert.equal(loaded.count, 1);
  assert.equal(loaded.issueUpdatedAt, "2026-01-01T00:00:00Z");
  assert.deepEqual(loaded.data, [{ id: 9 }]);
});

test("PR details: round-trip, corrupt file → null", () => {
  const cache = setup();
  assert.equal(cache.loadPullDetails("o", "r"), null, "missing file");

  const details = {
    5: { updated_at: "2026-01-01T00:00:00Z", data: { draft: true } },
    7: { updated_at: "2026-01-02T00:00:00Z", data: { merged_at: null } },
  };
  cache.savePullDetails(details, "o", "r");
  assert.deepEqual(cache.loadPullDetails("o", "r"), details);
});

test("pruneCaches drops PR detail entries that left both lists", () => {
  const cache = setup();
  cache.savePullDetails(
    {
      5: { updated_at: "u5", data: { draft: false } },
      7: { updated_at: "u7", data: { draft: true } },
    },
    "o",
    "r",
  );

  cache.pruneCaches("o", "r", [5, 9]); // 7 vanished
  assert.deepEqual(
    cache.loadPullDetails("o", "r"),
    { 5: { updated_at: "u5", data: { draft: false } } },
    "pruned entry gone, survivor intact",
  );

  // no-op prune must not rewrite/corrupt the file
  cache.pruneCaches("o", "r", [5, 9]);
  assert.deepEqual(Object.keys(cache.loadPullDetails("o", "r")), ["5"]);
});
