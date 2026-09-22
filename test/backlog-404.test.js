"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createNovaStub } = require("./helpers/nova-stub.js");
const { freshRequire } = require("./helpers/modules.js");

test("404 warns once per session, falls back to cache, keeps retrying", async () => {
  const stub = createNovaStub({
    globalValues: { "github.owner": "stonerl", "github.repos": ["r"] },
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
      ok: false,
      status: 404,
      headers: {
        get: (h) => (h === "x-ratelimit-remaining" ? "4999" : null),
        has: () => false,
      },
      json: async () => [],
    };
  };

  // 4 refresh cycles worth of 404s (configured repo — alert applies)
  await github.dataStore.fetchState("open", "tok", "stonerl", "r");
  await github.dataStore.fetchState("open", "tok", "stonerl", "r");
  await github.dataStore.fetchState("open", "tok", "stonerl", "r");
  await github.dataStore.fetchState("closed", "tok", "stonerl", "r");

  assert.equal(
    fetches,
    4,
    "keeps retrying every cycle (self-heals on scope fix)",
  );

  const notFoundAlerts = stub.captures.consoleLogs.filter(
    (l) => l.level === "alert-warning" && String(l.args[0]).includes("404"),
  );
  assert.equal(
    notFoundAlerts.length,
    1,
    `exactly one 404 alert (got ${notFoundAlerts.length})`,
  );

  // a fresh module state = a new session → shows again
  const github2 = freshRequire("lib/github.js");
  await github2.dataStore.fetchState("open", "tok", "stonerl", "r");
  const alerts2 = stub.captures.consoleLogs.filter(
    (l) => l.level === "alert-warning" && String(l.args[0]).includes("404"),
  );
  assert.equal(alerts2.length, 2, "new session → warns again once");
});

test("404 for an unconfigured repo stays console-only", async () => {
  const stub = createNovaStub({
    globalValues: { "github.owner": "stonerl", "github.repos": ["r"] },
    credentials: { stonerl: "tok" },
    workspaceValues: { "github.repo": "r" },
    files: {},
  });
  stub.install();
  const github = freshRequire("lib/github.js");
  stub.fetchImpl = async () => ({
    ok: false,
    status: 404,
    headers: {
      get: (h) => (h === "x-ratelimit-remaining" ? "4999" : null),
      has: () => false,
    },
    json: async () => [],
  });

  // wrong owner (detection pending — the add-prompt is up) and a repo
  // name that only exists under the detected account
  await github.dataStore.fetchState("open", "tok", "org-x", "their-repo");
  await github.dataStore.fetchState("open", "tok", "stonerl", "other-repo");

  const notFoundAlerts = stub.captures.consoleLogs.filter(
    (l) => l.level === "alert-warning" && String(l.args[0]).includes("404"),
  );
  assert.equal(
    notFoundAlerts.length,
    0,
    "no user-facing alert for unconfigured repos",
  );
  const ignoredLogs = stub.captures.consoleLogs.filter(
    (l) =>
      l.level === "warn" && String(l.args[0]).includes("unconfigured repo"),
  );
  assert.equal(
    ignoredLogs.length,
    2,
    "console keeps the diagnostic (one per fetch)",
  );
});
