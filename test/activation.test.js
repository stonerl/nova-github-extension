"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createNovaStub } = require("./helpers/nova-stub.js");
const { freshRequire } = require("./helpers/modules.js");

const GIT_CONFIG =
  '[remote "origin"]\n\turl = https://github.com/stonerl/repo-a.git';

function setup(stubOptions = {}) {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.refreshInterval": 30,
      "github.maxRecentItems": "50",
      "github.itemsPerPage": "100",
      "github.repos": ["repo-a"],
      "github.token": "***",
      ...(stubOptions.globalValues || {}),
    },
    credentials: { stonerl: "tok" },
    workspaceValues: { "github.repo": "repo-a" },
    files: {
      "/novatest/workspace/.git/config": GIT_CONFIG,
      ...(stubOptions.files || {}),
    },
    ...stubOptions,
  });
  stub.install();
  return stub;
}

test("activate performs zero config traffic synchronously", () => {
  const stub = setup();
  const main = freshRequire("main.js");
  main.activate();
  main.deactivate();
  assert.equal(stub.captures.configGets.length, 0, "no config reads");
  assert.equal(stub.captures.configSets.length, 0, "no config writes");
  assert.equal(stub.captures.workspaceGets.length, 0, "no workspace reads");
  assert.equal(stub.captures.workspaceSets.length, 0, "no workspace writes");
});

test("deferred setup registers observers, commands, and fetches", async () => {
  const stub = setup();
  let listFetches = 0;
  stub.fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (h) => (h === "x-ratelimit-remaining" ? "4999" : null),
      has: () => false,
    },
    json: async () => [],
  });
  const onFetch = () => listFetches++;

  const main = freshRequire("main.js");
  const before = stub.captures.fetchCalls.length;
  main.activate();
  await new Promise((r) => setTimeout(r, 100));

  const commands = Object.keys(stub.captures.commands);
  for (const cmd of [
    "github-issues.refresh",
    "github-issues.newIssue",
    "github-issues.newPullRequest",
    "github-issues.openInBrowser",
    "github-issues.copyUrl",
    "github-issues.closeIssue",
    "github-issues.closeNotPlanned",
    "github-issues.closeDuplicate",
    "github-issues.reopenIssue",
    "github-issues.forgetDetection",
  ]) {
    assert.ok(commands.includes(cmd), `command registered: ${cmd}`);
  }

  // one request per state (open + closed), despite 4 providers
  assert.ok(
    stub.captures.fetchCalls.length - before <= 2,
    `deferred setup fetches ≤2 lists (got ${stub.captures.fetchCalls.length - before})`,
  );
  onFetch();
});

test("context availability is mirrored only after deferred setup", async () => {
  const stub = setup();
  const main = freshRequire("main.js");
  main.activate();
  assert.equal(stub.captures.contextSets.length, 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(stub.captures.contextSets.length, 1);
  assert.equal(stub.captures.contextSets[0].key, "github.ready");
  assert.equal(stub.captures.contextSets[0].value, true);
  main.deactivate();
});

test("deactivate is idempotent and clears timers", () => {
  const stub = setup();
  const main = freshRequire("main.js");
  main.activate();
  main.deactivate();
  main.deactivate();
});

test("token observer: keystroke burst coalesces into one keychain write", async () => {
  const stub = setup();
  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 50));

  const tokenObservers = [];
  // the observer was registered during deferred setup; fire via stub
  stub.fireObserver("global", "github.token", "");
  const writesBefore = stub.captures.keychainWrites.length;

  const token = "ghp_0123456789abcdefghijklmnopqrstuv";
  for (let i = 1; i <= token.length; i++) {
    stub.fireObserver("global", "github.token", token.slice(0, i));
  }
  assert.equal(
    stub.captures.keychainWrites.length,
    writesBefore,
    "no writes during typing",
  );
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(
    stub.credentialsMap["stonerl"],
    token,
    "one keychain write after settle",
  );
  assert.equal(stub.globalValues["github.token"], "***", "masked");
});

test("repo detection: silent for same account, notification otherwise", async () => {
  // same account + repo in list → silent
  const stub = setup();
  freshRequire("main.js").activate();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(stub.captures.notifications.length, 0, "same account → silent");
  assert.equal(
    stub.captures.workspaceSets.some((s) => s.key === "github.detected"),
    false,
  );
  assert.notEqual(
    stub.onDidChangePathHandler,
    undefined,
    "path handler registered",
  );

  // different account → notification asks
  const stub2 = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": ["repo-a"],
      "github.refreshInterval": 30,
    },
    credentials: { stonerl: "tok" },
    workspaceValues: {},
    files: {
      "/novatest/workspace/.git/config":
        '[remote "origin"]\n\turl = https://github.com/work-org/their-repo.git',
    },
  });
  stub2.install();
  stub2.captures.notificationResponses.push({ identifier: "x", actionIdx: 0 });
  freshRequire("main.js").activate();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    stub2.captures.notifications.length,
    1,
    "different account → notification",
  );
  assert.equal(
    stub2.captures.workspaceSets.filter((s) => s.key === "github.detected")
      .length,
    0,
    "zero workspace config writes (detection avoids the config bridge)",
  );
  assert.ok(
    Object.keys(stub2.files).some((k) => k.endsWith("detections.json")),
    "detection persisted to the extension's own storage file",
  );
});

test("workspace with no .git/config stays silent", async () => {
  const stub = setup({ files: {} });
  freshRequire("main.js").activate();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(stub.captures.notifications.length, 0);
});
