"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createNovaStub } = require("./helpers/nova-stub.js");
const { freshRequire } = require("./helpers/modules.js");

test("owner resolves from global setting alone", () => {
  const stub = createNovaStub({ globalValues: { "github.owner": "stonerl" } });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  assert.equal(cfg.loadConfig().owner, "stonerl");
});

test("workspace override wins over global", () => {
  const stub = createNovaStub({
    globalValues: { "github.owner": "stonerl" },
    workspaceValues: { "github.owner": "work-org" },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  assert.equal(cfg.loadConfig().owner, "work-org");
});

test("detection layer sits between workspace and global", () => {
  const stub = createNovaStub({
    globalValues: { "github.owner": "stonerl" },
    files: {
      "/novatest/globalStorage/detections.json": JSON.stringify({
        "/novatest/workspace": "detected-org/detected-repo",
      }),
    },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  cfg.loadDetections();
  assert.equal(cfg.resolveOwner(), "detected-org");
  assert.deepEqual(cfg.getConfiguredRepos(), ["detected-repo"]);
  assert.equal(cfg.resolveActiveRepo(), "detected-repo");

  // explicit workspace setting beats detection
  stub.workspaceValues["github.owner"] = "manual-org";
  cfg.invalidateConfigCache();
  assert.equal(cfg.resolveOwner(), "manual-org");
});

test("token resolves per owner from the Keychain", () => {
  const stub = createNovaStub({
    globalValues: { "github.owner": "stonerl" },
    credentials: { stonerl: "tok-1" },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  assert.equal(cfg.loadConfig().token, "tok-1");
});

test("isConfigReady requires token, owner, and repo", () => {
  const stub = createNovaStub({
    globalValues: { "github.owner": "stonerl" },
    credentials: { stonerl: "tok" },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  assert.equal(cfg.isConfigReady(), false, "no repo");
  stub.workspaceValues["github.repo"] = "repo-a";
  cfg.invalidateConfigCache();
  assert.equal(cfg.isConfigReady(), true);
});

test("numeric config coercion from enum strings", () => {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.refreshInterval": "30",
      "github.maxRecentItems": "50",
      "github.itemsPerPage": "100",
    },
    credentials: { stonerl: "tok" },
    workspaceValues: { "github.repo": "r" },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  const c = cfg.loadConfig();
  assert.strictEqual(c.refreshInterval, 30);
  assert.strictEqual(c.maxRecentItems, 50);
  assert.strictEqual(c.itemsPerPage, 100);
  assert.strictEqual(
    c.maxRecentItems <= c.itemsPerPage,
    true,
    "ETag condition",
  );
});

test("invalid numeric values fall back", () => {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.maxRecentItems": "bogus",
    },
    credentials: { stonerl: "tok" },
    workspaceValues: { "github.repo": "r" },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  assert.strictEqual(cfg.loadConfig().maxRecentItems, 50);
});

test("loadConfig caches: 1000 loads → one read burst", () => {
  const stub = createNovaStub({
    globalValues: { "github.owner": "stonerl" },
    credentials: { stonerl: "tok" },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  const before = stub.captures.configGets.length;
  for (let i = 0; i < 1000; i++) cfg.loadConfig();
  const reads = stub.captures.configGets.length - before;
  assert.ok(reads <= 10, `expected ~1 burst, got ${reads}`);
});

test("incomplete configs are cached too (no read storm)", () => {
  const stub = createNovaStub({}); // nothing configured
  stub.install();
  const cfg = freshRequire("lib/config.js");
  const before = stub.captures.configGets.length;
  for (let i = 0; i < 100; i++) cfg.loadConfig();
  const reads = stub.captures.configGets.length - before;
  assert.ok(reads <= 10, `expected ~1 burst, got ${reads}`);
});

test("failing owner log is throttled to one line", () => {
  const stub = createNovaStub({});
  stub.install();
  stub.captureConsole();
  const cfg = freshRequire("lib/config.js");
  for (let i = 0; i < 100; i++) {
    cfg.invalidateConfigCache();
    cfg.loadConfig();
  }
  const errors = stub.captures.consoleLogs.filter(
    (l) =>
      l.level === "error" &&
      String(l.args[0]).includes("github.owner must be set"),
  );
  assert.equal(errors.length, 1, `got ${errors.length}`);
});

test("context.set only fires on value change", () => {
  const stub = createNovaStub({
    globalValues: { "github.owner": "stonerl" },
    credentials: { stonerl: "tok" },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  cfg.updateContextAvailability(); // prime (null → false)
  const sets = () => stub.captures.contextSets.length;
  const baseline = sets();
  for (let i = 0; i < 10; i++) cfg.updateContextAvailability();
  assert.equal(sets() - baseline, 0, "steady state → no writes");

  stub.credentialsMap["stonerl"] = "tok";
  stub.workspaceValues["github.repo"] = "r";
  cfg.invalidateConfigCache();
  cfg.updateContextAvailability();
  assert.equal(sets() - baseline, 1, "flip → exactly one write");
});

test("skipInitialCall swallows the first fire, forwards the rest", () => {
  const cfg = freshRequire("lib/config.js");
  let calls = 0;
  const fn = cfg.skipInitialCall(() => calls++);
  fn();
  fn();
  fn();
  assert.equal(calls, 2);
});

test("config writes are audit-logged", () => {
  const stub = createNovaStub({});
  stub.install();
  stub.captureConsole();
  const cfg = freshRequire("lib/config.js");
  cfg.setGlobalConfig("github.token", "***");
  cfg.setWorkspaceConfig("github.repo", "r");
  const audits = stub.captures.consoleLogs.filter((l) =>
    String(l.args[0]).includes("[SetAudit]"),
  );
  assert.equal(audits.length, 2);
});

test("per-repo freshness: unknown repo is stale, marking makes it fresh", () => {
  const cfg = freshRequire("lib/config.js");
  cfg.resetRefreshTracking();

  assert.equal(cfg.isRepoFresh("stonerl", "repo-a", 30 * 60_000), false);
  cfg.markRepoRefreshed("stonerl", "repo-a");
  assert.equal(cfg.isRepoFresh("stonerl", "repo-a", 30 * 60_000), true);
  // freshness is scoped per repo — another repo of the same owner is
  // still unknown (the old global timestamp masked exactly this)
  assert.equal(cfg.isRepoFresh("stonerl", "repo-b", 30 * 60_000), false);
  assert.equal(cfg.isRepoFresh("other-org", "repo-a", 30 * 60_000), false);
});

test("per-repo freshness: non-positive interval and missing args are stale", () => {
  const cfg = freshRequire("lib/config.js");
  cfg.resetRefreshTracking();
  cfg.markRepoRefreshed("stonerl", "repo-a");

  assert.equal(cfg.isRepoFresh("stonerl", "repo-a", 0), false);
  assert.equal(cfg.isRepoFresh("stonerl", "repo-a", -1), false);
  assert.equal(cfg.isRepoFresh(null, "repo-a", 60_000), false);
  assert.equal(cfg.isRepoFresh("stonerl", null, 60_000), false);
  cfg.markRepoRefreshed(null, "repo-a"); // no-op, must not throw
});

test("per-repo freshness: reset clears all marks", () => {
  const cfg = freshRequire("lib/config.js");
  cfg.markRepoRefreshed("stonerl", "repo-a");
  cfg.resetRefreshTracking();
  assert.equal(cfg.isRepoFresh("stonerl", "repo-a", 60_000), false);
});
