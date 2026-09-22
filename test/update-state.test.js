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

function setup() {
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
  return stub;
}

// GitHub list endpoints lag behind PATCHes — the scripted lists flip
// only when the PATCH lands, mimicking that lag. The optimistic move
// must make the views correct BEFORE the lists do.
function scriptFetch(stub, { patchCalls, listCalls, startIn, gate }) {
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
      patchCalls.count++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null, has: () => false },
        json: async () => ({}),
      };
    }
    listCalls.count++;
    const done = patchCalls.count > 0 && (!gate || gate.allowFlip);
    const isClosedList = url.includes("state=closed");
    const closedItem = issue(1, {
      state: "closed",
      state_reason: "completed",
    });
    const openItem = issue(1, {});
    let items;
    if (startIn === "open") {
      items = isClosedList === done ? [done ? closedItem : openItem] : [];
    } else {
      items = isClosedList === done ? [] : [done ? openItem : closedItem];
    }
    return {
      ok: true,
      status: 200,
      headers: {
        get: (h) => (h === "x-ratelimit-remaining" ? "4999" : null),
        has: () => false,
      },
      json: async () => items,
    };
  };
}

test("closing an issue moves it optimistically, then reconciles", async () => {
  const stub = setup();
  const patchCalls = { count: 0 };
  const listCalls = { count: 0 };
  scriptFetch(stub, { patchCalls, listCalls, startIn: "open" });

  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 100));

  const { IssueItem } = freshRequire("lib/tree/item.js");
  const wrapper = new IssueItem(issue(1, { state: "open" }));
  stub.captures.treeViews
    .find((v) => v.id === "issues")
    .fireSelection([wrapper]);
  await new Promise((r) => setTimeout(r, 50));

  const listsBefore = listCalls.count;
  await stub.captures.commands["github-issues.closeIssue"]();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(patchCalls.count, 1, "PATCH sent");
  assert.equal(
    listCalls.count,
    listsBefore,
    "no immediate list refetch — optimistic move instead",
  );
  const openProvider = stub.captures.treeViews.find(
    (v) => v.id === "issues",
  ).dataProvider;
  const closedProvider = stub.captures.treeViews.find(
    (v) => v.id === "closed-issues",
  ).dataProvider;
  assert.equal(
    openProvider.rootItems.length,
    0,
    "moved out of the open section instantly",
  );
  assert.equal(
    closedProvider.rootItems.length,
    1,
    "moved into the closed section instantly",
  );
  assert.equal(closedProvider.rootItems[0].issue.state, "closed");
  assert.equal(closedProvider.rootItems[0].issue.state_reason, "completed");

  // reconciliation: lists refetched, server truth keeps the move
  await new Promise((r) => setTimeout(r, 3300));
  assert.ok(
    listCalls.count > listsBefore,
    "delayed reconciliation refetched both states",
  );
  assert.equal(closedProvider.rootItems.length, 1);
  assert.equal(openProvider.rootItems.length, 0);
  main.deactivate();
});

test("reopening an issue moves it back optimistically", async () => {
  const stub = setup();
  const patchCalls = { count: 0 };
  const listCalls = { count: 0 };
  scriptFetch(stub, { patchCalls, listCalls, startIn: "closed" });

  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 100));

  const { IssueItem } = freshRequire("lib/tree/item.js");
  const wrapper = new IssueItem(
    issue(1, { state: "closed", state_reason: "completed" }),
  );
  stub.captures.treeViews
    .find((v) => v.id === "closed-issues")
    .fireSelection([wrapper]);
  await new Promise((r) => setTimeout(r, 50));

  const listsBefore = listCalls.count;
  await stub.captures.commands["github-issues.reopenIssue"]();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(patchCalls.count, 1);
  assert.equal(listCalls.count, listsBefore, "optimistic, no refetch");
  const closedProvider = stub.captures.treeViews.find(
    (v) => v.id === "closed-issues",
  ).dataProvider;
  const openProvider = stub.captures.treeViews.find(
    (v) => v.id === "issues",
  ).dataProvider;
  assert.equal(closedProvider.rootItems.length, 0);
  assert.equal(openProvider.rootItems.length, 1);
  assert.equal(openProvider.rootItems[0].issue.state, "open");
  assert.equal(openProvider.rootItems[0].issue.closed_at, null);

  await new Promise((r) => setTimeout(r, 3300));
  assert.equal(openProvider.rootItems.length, 1);
  assert.equal(closedProvider.rootItems.length, 0);
  main.deactivate();
});

test("deactivate cancels the pending reconciliation", async () => {
  const stub = setup();
  const patchCalls = { count: 0 };
  const listCalls = { count: 0 };
  scriptFetch(stub, { patchCalls, listCalls, startIn: "open" });

  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 100));

  const { IssueItem } = freshRequire("lib/tree/item.js");
  const wrapper = new IssueItem(issue(1, { state: "open" }));
  stub.captures.treeViews
    .find((v) => v.id === "issues")
    .fireSelection([wrapper]);
  await new Promise((r) => setTimeout(r, 50));

  const listsBefore = listCalls.count;
  await stub.captures.commands["github-issues.closeIssue"]();
  await new Promise((r) => setTimeout(r, 100));
  main.deactivate();

  await new Promise((r) => setTimeout(r, 3300));
  assert.equal(
    listCalls.count,
    listsBefore,
    "reconciliation timer cleared on deactivate",
  );
});

test("reconciliation with a lagging server keeps the item in place, then lands", async () => {
  const stub = setup();
  const patchCalls = { count: 0 };
  const listCalls = { count: 0 };
  const gate = { allowFlip: false };
  scriptFetch(stub, { patchCalls, listCalls, startIn: "open", gate });

  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 100));

  const { IssueItem } = freshRequire("lib/tree/item.js");
  const wrapper = new IssueItem(issue(1, { state: "open" }));
  stub.captures.treeViews
    .find((v) => v.id === "issues")
    .fireSelection([wrapper]);
  await new Promise((r) => setTimeout(r, 50));

  await stub.captures.commands["github-issues.closeIssue"]();
  await new Promise((r) => setTimeout(r, 100));

  const openProvider = stub.captures.treeViews.find(
    (v) => v.id === "issues",
  ).dataProvider;
  const closedProvider = stub.captures.treeViews.find(
    (v) => v.id === "closed-issues",
  ).dataProvider;
  assert.equal(closedProvider.rootItems.length, 1, "moved optimistically");

  // reconciliation fires while the server lists STILL show the old
  // state — the pending-move enforcement must keep the item in the
  // closed section instead of letting it jump back
  await new Promise((r) => setTimeout(r, 3300));
  assert.equal(
    closedProvider.rootItems.length,
    1,
    "no jump-back while GitHub lags",
  );
  assert.equal(openProvider.rootItems.length, 0);

  // server catches up → the next refresh lands the move for real and
  // the pending entry is consumed
  gate.allowFlip = true;
  await stub.captures.commands["github-issues.refresh"]();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(closedProvider.rootItems.length, 1);
  assert.equal(openProvider.rootItems.length, 0);
  assert.equal(
    closedProvider.rootItems[0].issue.state,
    "closed",
    "landed — server version in the right section",
  );

  // landed: further refreshes neither duplicate nor jump
  await stub.captures.commands["github-issues.refresh"]();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(closedProvider.rootItems.length, 1);
  assert.equal(openProvider.rootItems.length, 0);
  main.deactivate();
});
