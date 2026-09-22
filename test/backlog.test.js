"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createNovaStub } = require("./helpers/nova-stub.js");
const { freshRequire } = require("./helpers/modules.js");

const issue = (id, extra = {}) => ({
  id,
  number: id,
  title: `issue-${id}`,
  state: "open",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  user: { login: "x" },
  comments: 0,
  labels: [],
  ...extra,
});

// ── B5: comment cache staleness ──────────────────────────────

test("comment cache: delete+add (same count, bumped updated_at) refetches", async () => {
  const stub = createNovaStub({
    globalValues: { "github.owner": "stonerl" },
    credentials: { stonerl: "tok" },
    workspaceValues: { "github.repo": "r" },
    files: {},
  });
  stub.install();
  const github = freshRequire("lib/github.js");

  let fetches = 0;
  let comments = [
    {
      id: 10,
      body: "old",
      user: { login: "a" },
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  stub.fetchImpl = async () => {
    fetches++;
    return {
      ok: true,
      status: 200,
      headers: {
        get: (h) => (h === "x-ratelimit-remaining" ? "4999" : null),
        has: () => false,
      },
      json: async () => comments,
    };
  };

  const cfg = { token: "tok", owner: "o", repo: "r" };

  // first load
  await github.fetchCommentsForIssue(1, 1, cfg, "2026-01-02T00:00:00Z");
  assert.equal(fetches, 1);

  // same count + same updated_at → cached
  await github.fetchCommentsForIssue(1, 1, cfg, "2026-01-02T00:00:00Z");
  assert.equal(fetches, 1, "cache hit");

  // delete+add: same count (1), NEW updated_at → must refetch
  comments = [
    {
      id: 11,
      body: "new",
      user: { login: "b" },
      created_at: "2026-01-03T00:00:00Z",
    },
  ];
  await github.fetchCommentsForIssue(1, 1, cfg, "2026-01-04T00:00:00Z");
  assert.equal(fetches, 2, "stale cache rejected via updated_at");
  const served = await github.fetchCommentsForIssue(
    1,
    1,
    cfg,
    "2026-01-04T00:00:00Z",
  );
  assert.equal(served[0].id, 11, "fresh comments served");
  assert.equal(fetches, 2, "new fingerprint cached");
});

test("review comment caches validate the same way", async () => {
  const stub = createNovaStub({
    globalValues: { "github.owner": "stonerl" },
    credentials: { stonerl: "tok" },
    workspaceValues: { "github.repo": "r" },
    files: {},
  });
  stub.install();
  const github = freshRequire("lib/github.js");
  let fetches = 0;
  stub.fetchImpl = async () => {
    fetches++;
    return {
      ok: true,
      status: 200,
      headers: {
        get: (h) => (h === "x-ratelimit-remaining" ? "4999" : null),
        has: () => false,
      },
      json: async () => [],
    };
  };
  const cfg = { token: "tok", owner: "o", repo: "r" };
  await github.fetchReviewComments(2, 0, cfg, "2026-01-01T00:00:00Z");
  await github.fetchReviewComments(2, 0, cfg, "2026-01-01T00:00:00Z");
  assert.equal(fetches, 1, "cached");
  await github.fetchReviewComments(2, 0, cfg, "2026-01-05T00:00:00Z");
  assert.equal(fetches, 2, "bumped updated_at refetches");
});

// ── B6: cache pruning ────────────────────────────────────────

test("pruneCaches removes orphaned comment caches + legacy files + -null dirs", () => {
  const stub = createNovaStub({
    files: {
      "/novatest/globalStorage/cache/o-r/comments-issue-1.json": "{}",
      "/novatest/globalStorage/cache/o-r/comments-pull-2.json": "{}",
      "/novatest/globalStorage/cache/o-r/comments-issue-999.json": "{}",
      "/novatest/globalStorage/cache/o-r/issue-open.json": "[]",
      "/novatest/globalStorage/cache/o-r/pull-closed.json": "[]",
      "/novatest/globalStorage/cache/o-r/open.json": "[]",
      "/novatest/globalStorage/cache/o-null/comments-issue-77.json": "{}",
      "/novatest/globalStorage/cache/other-open.json": "[]",
    },
  });
  stub.install();
  const cache = freshRequire("lib/cache.js");

  cache.pruneCaches("o", "r", [1, 2]); // keep 1 + 2; 999 vanished

  const dir = "/novatest/globalStorage/cache/o-r";
  assert.notEqual(
    stub.files[`${dir}/comments-issue-1.json`],
    undefined,
    "kept 1",
  );
  assert.notEqual(
    stub.files[`${dir}/comments-pull-2.json`],
    undefined,
    "kept 2",
  );
  assert.equal(
    stub.files[`${dir}/comments-issue-999.json`],
    undefined,
    "orphan removed",
  );
  assert.equal(
    stub.files[`${dir}/issue-open.json`],
    undefined,
    "legacy removed",
  );
  assert.equal(
    stub.files[`${dir}/pull-closed.json`],
    undefined,
    "legacy removed",
  );
  assert.notEqual(
    stub.files[`${dir}/open.json`],
    undefined,
    "current cache kept",
  );
  assert.equal(
    stub.files["/novatest/globalStorage/cache/o-null/comments-issue-77.json"],
    undefined,
    "-null dir pruned",
  );
  assert.notEqual(
    stub.files["/novatest/globalStorage/cache/other-open.json"],
    undefined,
    "other files untouched",
  );
});

// ── B7: updateIssueState simplification ──────────────────────

test("updateIssueState: PATCH → optimistic move, no immediate refetch", async () => {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.refreshInterval": 30,
      "github.maxRecentItems": "50",
      "github.itemsPerPage": "100",
      "github.repos": ["repo-a"],
      "github.token": "***",
    },
    credentials: { stonerl: "tok" },
    workspaceValues: { "github.repo": "repo-a" },
    files: {},
  });
  stub.install();

  let patchCalls = 0;
  let listCalls = 0;
  stub.fetchImpl = async (url, opts) => {
    if (url.includes("api.github.com/user")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "4999", has: () => false },
        json: async () => ({ login: "stonerl" }),
      };
    }
    if (opts?.method === "PATCH") {
      patchCalls++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null, has: () => false },
        json: async () => ({}),
      };
    }
    listCalls++;
    return {
      ok: true,
      status: 200,
      headers: {
        get: (h) => (h === "x-ratelimit-remaining" ? "4999" : null),
        has: () => false,
      },
      json: async () => [
        issue(1, { state: "closed", state_reason: "completed" }),
      ],
    };
  };

  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 100));

  // fake selection: root issue item, currently open
  const { IssueItem } = freshRequire("lib/tree/item.js");
  const wrapper = new IssueItem(issue(1, { state: "open" }));
  stub.captures.treeViews
    .find((v) => v.id === "issues")
    .fireSelection([wrapper]);
  await new Promise((r) => setTimeout(r, 50));

  const patchesBefore = patchCalls;
  const listsBefore = listCalls;
  await stub.captures.commands["github-issues.closeIssue"]();

  assert.equal(patchCalls, patchesBefore + 1, "PATCH sent");
  assert.equal(
    listCalls,
    listsBefore,
    "item moved optimistically — no immediate list refetch",
  );

  main.deactivate();
});

test("updateIssueState: item missing from cache → immediate refetch fallback", async () => {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.refreshInterval": 30,
      "github.maxRecentItems": "50",
      "github.itemsPerPage": "100",
      "github.repos": ["repo-a"],
      "github.token": "***",
    },
    credentials: { stonerl: "tok" },
    workspaceValues: { "github.repo": "repo-a" },
    files: {},
  });
  stub.install();

  let patchCalls = 0;
  let listCalls = 0;
  stub.fetchImpl = async (url, opts) => {
    if (url.includes("api.github.com/user")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "4999", has: () => false },
        json: async () => ({ login: "stonerl" }),
      };
    }
    if (opts?.method === "PATCH") {
      patchCalls++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null, has: () => false },
        json: async () => ({}),
      };
    }
    listCalls++;
    return {
      ok: true,
      status: 200,
      headers: {
        get: (h) => (h === "x-ratelimit-remaining" ? "4999" : null),
        has: () => false,
      },
      json: async () => [],
    };
  };

  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 100));

  // fake selection: root issue item that is NOT in the cached lists
  const { IssueItem } = freshRequire("lib/tree/item.js");
  const wrapper = new IssueItem(issue(99, { state: "open" }));
  stub.captures.treeViews
    .find((v) => v.id === "issues")
    .fireSelection([wrapper]);
  await new Promise((r) => setTimeout(r, 50));

  const patchesBefore = patchCalls;
  const listsBefore = listCalls;
  await stub.captures.commands["github-issues.closeIssue"]();

  assert.equal(patchCalls, patchesBefore + 1, "PATCH sent");
  assert.equal(
    listCalls,
    listsBefore + 2,
    "no optimistic move possible → both states refetched",
  );

  main.deactivate();
});
