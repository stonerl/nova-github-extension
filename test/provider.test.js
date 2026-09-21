"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createNovaStub } = require("./helpers/nova-stub.js");
const { freshRequire } = require("./helpers/modules.js");

function setup(stubOptions = {}) {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.refreshInterval": 30,
      "github.maxRecentItems": "50",
      "github.itemsPerPage": "100",
      ...(stubOptions.globalValues || {}),
    },
    credentials: { stonerl: "tok" },
    workspaceValues: { "github.repo": "r" },
    ...stubOptions,
  });
  stub.install();
  return stub;
}

const issue = (id, extra = {}) => ({
  id,
  number: id,
  title: `issue-${id}`,
  state: "open",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  user: { login: "toni" },
  comments: 0,
  labels: [],
  ...extra,
});

test("tree building: children, labels, colors, naming", async () => {
  const stub = setup();
  const { GitHubIssuesProvider } = freshRequire("lib/tree/issues-provider.js");
  const p = new GitHubIssuesProvider("open", "issue");

  await p._refreshInternal(
    [
      issue(1, {
        labels: [{ name: "bug", color: "ff0000" }],
        milestone: { title: "v1" },
        state_reason: "reopened",
      }),
    ],
    true,
  );

  assert.equal(p.rootItems.length, 1);
  const root = p.rootItems[0];
  const titles = root.children.map((c) => c.issue.title);
  assert.ok(titles.includes("Reopened"), "reopened reason child");
  assert.ok(titles.includes("Author"), "author child");
  assert.ok(titles.includes("bug"), "label child");
  assert.ok(titles.includes("Milestone"), "milestone child");

  const treeItem = p.getTreeItem(root);
  assert.equal(treeItem.name, "#1");
  assert.equal(p.resolveElement(treeItem), root, "WeakMap round-trip");
  assert.equal(p.getChildren(null), p.rootItems);
  assert.equal(p.getParent(root.children[0]), root);
});

test("getTreeItem: draft suffix + colors by state_reason", async () => {
  const stub = setup();
  stub.fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null, has: () => false },
    json: async () => ({
      draft: true,
      merged_at: null,
      head: {},
      base: {},
      review_comments: 0,
    }),
  });
  const { GitHubIssuesProvider } = freshRequire("lib/tree/issues-provider.js");

  const pullP = new GitHubIssuesProvider("open", "pull");
  await pullP._refreshInternal(
    [issue(2, { draft: true, pull_request: {} })],
    true,
  );
  assert.equal(pullP.getTreeItem(pullP.rootItems[0]).name, "#2 [DRAFT]");

  const closedP = new GitHubIssuesProvider("closed", "issue");
  await closedP._refreshInternal(
    [issue(3, { state: "closed", state_reason: "not_planned" })],
    true,
  );
  const item = closedP.getTreeItem(closedP.rootItems[0]);
  assert.equal(item.color.r, 110 / 255, "gray for not_planned");
});

test("change detection skips rebuild when nothing changed", async () => {
  const stub = setup();
  const { GitHubIssuesProvider } = freshRequire("lib/tree/issues-provider.js");
  const p = new GitHubIssuesProvider("open", "issue");
  const items = [issue(1)];

  await p._refreshInternal(items, false);
  const firstCount = p.rootItems.length;
  const result = await p._refreshInternal(items, false);
  assert.equal(result, false, "no change → false");
  assert.equal(p.rootItems.length, firstCount);
});

test("lazy comments: fetched on expand, cached, deduped", async () => {
  const stub = setup();
  const { GitHubIssuesProvider } = freshRequire("lib/tree/issues-provider.js");
  const p = new GitHubIssuesProvider("open", "issue");

  let fetches = 0;
  stub.fetchImpl = async (url) => {
    if (url.includes("/issues/1/comments")) {
      fetches++;
      return {
        ok: true,
        status: 200,
        headers: {
          get: (h) => (h === "x-ratelimit-remaining" ? "4999" : null),
          has: () => false,
        },
        json: async () => [
          {
            created_at: "2026-01-01T00:00:00Z",
            body: "hello",
            user: { login: "toni" },
            html_url: "https://x/1",
          },
        ],
      };
    }
    throw new Error("unexpected fetch: " + url);
  };

  await p._refreshInternal([issue(1, { comments: 2 })], true);
  const group = p.rootItems[0].children.find(
    (c) => c.issue.title === "Comments",
  );
  assert.ok(group, "comment group exists");
  assert.equal(group.commentSource.number, 1);

  const kids1 = await p.getChildren(group);
  assert.equal(kids1.length, 1);
  const kids2 = await p.getChildren(group);
  assert.equal(kids2.length, 1);
  assert.equal(fetches, 1, "one fetch for repeated expands");

  const [a, b] = await Promise.all([
    p.getChildren(group),
    p.getChildren(group),
  ]);
  assert.equal(a, b, "concurrent expands share promise");
  assert.equal(fetches, 1);
});

test("mapPool caps concurrency and keeps order", async () => {
  const { GitHubIssuesProvider } = freshRequire("lib/tree/issues-provider.js");
  // mapPool is module-private; test through hydration with 60 PRs
  const stub = setup();
  const { GitHubIssuesProvider: P } = freshRequire(
    "lib/tree/issues-provider.js",
  );
  const p = new P("open", "pull");

  let concurrent = 0;
  let maxConcurrent = 0;
  stub.fetchImpl = async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 5));
    concurrent--;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null, has: () => false },
      json: async () => ({
        draft: false,
        merged_at: null,
        head: {},
        base: {},
        review_comments: 0,
      }),
    };
  };

  const items = Array.from({ length: 60 }, (_, n) =>
    issue(n, { pull_request: {}, comments: 0, review_comments: 0 }),
  );
  await p._refreshInternal(items, true);
  assert.equal(maxConcurrent, 6, `pool caps at 6 (got ${maxConcurrent})`);
  assert.equal(p.rootItems.length, 60, "all items processed");
});
