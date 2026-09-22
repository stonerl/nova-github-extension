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

test("account mapping: token resolves via the login, not the owner", () => {
  const stub = createNovaStub({
    globalValues: { "github.owner": "stonerl" },
    credentials: { "acct-a": "tok-account" },
    files: {
      "/novatest/globalStorage/accounts.json": JSON.stringify({
        orgToLogin: { stonerl: "acct-a" },
      }),
    },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  assert.equal(cfg.loginForOwner("stonerl"), "acct-a");
  assert.equal(
    cfg.loadConfig().token,
    "tok-account",
    "mapped login entry wins",
  );
});

test("account mapping: legacy per-owner entry is the fallback", () => {
  const stub = createNovaStub({
    globalValues: { "github.owner": "stonerl" },
    credentials: { stonerl: "tok-legacy" },
    files: {
      "/novatest/globalStorage/accounts.json": JSON.stringify({
        orgToLogin: { stonerl: "acct-gone" }, // entry no longer exists
      }),
    },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  assert.equal(cfg.loadConfig().token, "tok-legacy");
});

test("recordOwnerLogin persists to accounts.json", () => {
  const stub = createNovaStub({
    globalValues: { "github.owner": "stonerl" },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  cfg.recordOwnerLogin("stonerl", "acct-a");
  cfg.recordOwnerLogin("work-org", "acct-a");
  cfg.recordOwnerLogin("other", "acct-b");
  const written = Object.entries(stub.files).find(([k]) =>
    k.endsWith("accounts.json"),
  );
  assert.ok(written, "accounts.json written");
  assert.deepEqual(JSON.parse(written[1]).orgToLogin, {
    stonerl: "acct-a",
    "work-org": "acct-a",
    other: "acct-b",
  });
  cfg.forgetOwnerLogin("other");
  assert.equal(cfg.loginForOwner("other"), null);
  assert.equal(cfg.loginForOwner("stonerl"), "acct-a");
});

test("knownOwners collects global owner + detection owners", () => {
  const stub = createNovaStub({
    globalValues: { "github.owner": "stonerl" },
    files: {
      "/novatest/globalStorage/detections.json": JSON.stringify({
        "/ws/one": "org-a/repo-one",
        "/ws/two": "stonerl/repo-two",
        "/ws/bad": "garbage",
      }),
    },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  assert.deepEqual(cfg.knownOwners().sort(), ["org-a", "stonerl"]);
});

test("configured repos: detected repo anchors the global list", () => {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": ["repo-a", "repo-b"],
    },
    files: {
      "/novatest/globalStorage/detections.json": JSON.stringify({
        "/novatest/workspace": "org-x/repo-x",
      }),
    },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  cfg.loadDetections();
  assert.deepEqual(cfg.getConfiguredRepos(), ["repo-x", "repo-a", "repo-b"]);
});

test("configured repos: detected repo anchors the workspace list, global excluded", () => {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": ["global-1"],
    },
    workspaceValues: { "github.repos": ["ws-1", "ws-2"] },
    files: {
      "/novatest/globalStorage/detections.json": JSON.stringify({
        "/novatest/workspace": "org-x/repo-x",
      }),
    },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  cfg.loadDetections();
  assert.deepEqual(
    cfg.getConfiguredRepos(),
    ["repo-x", "ws-1", "ws-2"],
    "workspace override replaces global; only the detected repo joins",
  );
});

test("configured repos: detected repo present in the manual list is deduped", () => {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": ["repo-x", "repo-b"],
    },
    files: {
      "/novatest/globalStorage/detections.json": JSON.stringify({
        "/novatest/workspace": "stonerl/repo-x",
      }),
    },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  cfg.loadDetections();
  assert.deepEqual(cfg.getConfiguredRepos(), ["repo-x", "repo-b"]);
});

test("configured repos: empty manual list with detection still anchors", () => {
  const stub = createNovaStub({
    globalValues: { "github.owner": "stonerl" },
    workspaceValues: { "github.repos": [] },
    files: {
      "/novatest/globalStorage/detections.json": JSON.stringify({
        "/novatest/workspace": "org-x/repo-x",
      }),
    },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  cfg.loadDetections();
  assert.deepEqual(cfg.getConfiguredRepos(), ["repo-x"]);
});

test("configured repos: without detection, workspace override stays strict", () => {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": ["global-1", "global-2"],
    },
    workspaceValues: { "github.repos": ["ws-1"] },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  assert.deepEqual(
    cfg.getConfiguredRepos(),
    ["ws-1"],
    "no detection → no cross-scope mixing",
  );
});

test("configured repos: includeGlobalRepos appends global after workspace entries", () => {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": ["global-1", "global-2"],
    },
    workspaceValues: {
      "github.repos": ["ws-1", "ws-2"],
      "github.includeGlobalRepos": true,
    },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  assert.deepEqual(cfg.getConfiguredRepos(), [
    "ws-1",
    "ws-2",
    "global-1",
    "global-2",
  ]);
});

test("configured repos: includeGlobalRepos off keeps the override strict", () => {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": ["global-1"],
    },
    workspaceValues: { "github.repos": ["ws-1"] },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  assert.deepEqual(cfg.getConfiguredRepos(), ["ws-1"]);
});

test("configured repos: includeGlobalRepos dedupes, workspace entry wins", () => {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": ["shared", "global-1"],
    },
    workspaceValues: {
      "github.repos": ["ws-1", "shared"],
      "github.includeGlobalRepos": true,
    },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  assert.deepEqual(cfg.getConfiguredRepos(), ["ws-1", "shared", "global-1"]);
});

test("configured repos: includeGlobalRepos without a workspace list is a no-op", () => {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": ["global-1"],
    },
    workspaceValues: { "github.includeGlobalRepos": true },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  assert.deepEqual(cfg.getConfiguredRepos(), ["global-1"]);
});

test("configured repos: includeGlobalRepos is workspace-scoped, global value ignored", () => {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": ["global-1"],
      "github.includeGlobalRepos": true,
    },
    workspaceValues: { "github.repos": ["ws-1"] },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  assert.deepEqual(
    cfg.getConfiguredRepos(),
    ["ws-1"],
    "a global-scope toggle value must not enable merging",
  );
});

test("configured repos: toggle merges under the detected anchor too", () => {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": ["global-1"],
    },
    workspaceValues: {
      "github.repos": ["ws-1"],
      "github.includeGlobalRepos": true,
    },
    files: {
      "/novatest/globalStorage/detections.json": JSON.stringify({
        "/novatest/workspace": "org-x/repo-x",
      }),
    },
  });
  stub.install();
  const cfg = freshRequire("lib/config.js");
  cfg.loadDetections();
  assert.deepEqual(cfg.getConfiguredRepos(), ["repo-x", "ws-1", "global-1"]);
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

test("auto-detect toggle: on by default, only an explicit false disables it", () => {
  const stub = createNovaStub({});
  stub.install();
  const cfg = freshRequire("lib/config.js");
  assert.equal(cfg.isAutoDetectEnabled(), true, "unset → on");

  stub.globalValues["github.autoDetectRepos"] = false;
  assert.equal(cfg.isAutoDetectEnabled(), false, "explicit false → off");

  stub.globalValues["github.autoDetectRepos"] = true;
  assert.equal(cfg.isAutoDetectEnabled(), true);
});
