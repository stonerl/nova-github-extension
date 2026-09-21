"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createNovaStub } = require("./helpers/nova-stub.js");
const { freshRequire } = require("./helpers/modules.js");

test("404 warns once per session, falls back to cache, keeps retrying", async () => {
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
      ok: false,
      status: 404,
      headers: {
        get: (h) => (h === "x-ratelimit-remaining" ? "4999" : null),
        has: () => false,
      },
      json: async () => [],
    };
  };

  // 4 refresh cycles worth of 404s
  await github.dataStore.fetchState("open", "tok", "o", "r");
  await github.dataStore.fetchState("open", "tok", "o", "r");
  await github.dataStore.fetchState("open", "tok", "o", "r");
  await github.dataStore.fetchState("closed", "tok", "o", "r");

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
  await github2.dataStore.fetchState("open", "tok", "o", "r");
  const alerts2 = stub.captures.consoleLogs.filter(
    (l) => l.level === "alert-warning" && String(l.args[0]).includes("404"),
  );
  assert.equal(alerts2.length, 2, "new session → warns again once");
});
