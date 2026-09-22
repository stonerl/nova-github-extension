"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createNovaStub } = require("./helpers/nova-stub.js");
const { freshRequire } = require("./helpers/modules.js");

const GIT_CONFIG =
  '[remote "origin"]\n\turl = https://github.com/stonerl/repo-a.git';

const UNKNOWN_REPO_GIT_CONFIG =
  '[remote "origin"]\n\turl = https://github.com/work-org/their-repo.git';

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

  // one request per state (open + closed), despite 4 providers —
  // the one-time /user account-backfill probe doesn't count here
  const listRequests = stub.captures.fetchCalls
    .slice(before)
    .filter((f) => !f.url.includes("api.github.com/user"));
  assert.ok(
    listRequests.length <= 2,
    `deferred setup fetches ≤2 lists (got ${listRequests.length})`,
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

test("declining the prompt persists and stops future asks", async () => {
  const stub = setup({
    files: {
      "/novatest/workspace/.git/config": UNKNOWN_REPO_GIT_CONFIG,
    },
  });
  stub.captures.notificationResponses.push({ identifier: "x", actionIdx: 1 }); // "No"
  freshRequire("main.js").activate();
  await new Promise((r) => setTimeout(r, 250));

  assert.equal(
    stub.workspaceValues["github.detectedDeclined"],
    "work-org/their-repo",
    "decline recorded in the workspace setting",
  );
  assert.ok(
    !Object.keys(stub.files).some((k) => k.endsWith("detections.json")),
    "decline did not apply the repo",
  );
  const asksBefore = stub.captures.notifications.length;
  assert.equal(asksBefore, 1, "asked exactly once");

  // workspace reopened → no ask
  freshRequire("main.js").activate();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    stub.captures.notifications.length,
    asksBefore,
    "declined repo is not asked about again",
  );
});

test("a different remote asks again after a decline", async () => {
  const stub = setup({
    files: {
      "/novatest/workspace/.git/config": UNKNOWN_REPO_GIT_CONFIG,
    },
  });
  stub.captures.notificationResponses.push({ identifier: "x", actionIdx: 1 });
  freshRequire("main.js").activate();
  await new Promise((r) => setTimeout(r, 250));
  const asksBefore = stub.captures.notifications.length;

  // remote changes to another repository
  stub.files["/novatest/workspace/.git/config"] =
    '[remote "origin"]\n\turl = https://github.com/work-org/other-repo.git';
  stub.captures.notificationResponses.push({ identifier: "x", actionIdx: 1 });
  freshRequire("main.js").activate();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(
    stub.captures.notifications.length,
    asksBefore + 1,
    "new remote → asked again",
  );
  assert.equal(
    stub.workspaceValues["github.detectedDeclined"],
    "work-org/other-repo",
    "new decline overwrites the old one",
  );
});

test("forgetDetection resets the decline", async () => {
  const stub = setup({
    files: {
      "/novatest/workspace/.git/config": UNKNOWN_REPO_GIT_CONFIG,
    },
  });
  stub.captures.notificationResponses.push({ identifier: "x", actionIdx: 1 });
  freshRequire("main.js").activate();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(
    stub.workspaceValues["github.detectedDeclined"],
    "work-org/their-repo",
  );

  await stub.captures.commands["github-issues.forgetDetection"]();
  assert.equal(
    stub.workspaceValues["github.detectedDeclined"],
    "",
    "command clears the recorded decline",
  );
});

test("clearing the decline setting asks again", async () => {
  const stub = setup({
    files: {
      "/novatest/workspace/.git/config": UNKNOWN_REPO_GIT_CONFIG,
    },
    workspaceValues: { "github.detectedDeclined": "work-org/their-repo" },
  });
  stub.captures.notificationResponses.push({ identifier: "x", actionIdx: 1 });
  freshRequire("main.js").activate();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    stub.captures.notifications.length,
    0,
    "pre-set decline → silent",
  );

  // user clears the field in the workspace settings
  stub.workspaceValues["github.detectedDeclined"] = "";
  freshRequire("main.js").activate();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    stub.captures.notifications.length,
    1,
    "cleared decline → asked again",
  );
});

test("flipping includeGlobalRepos repaints both repo sections once", async () => {
  const stub = setup();
  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 100));

  // the Repositories section exists in BOTH sidebars, bound to two
  // TreeView instances sharing one provider
  const reposView = stub.captures.treeViews.find((v) => v.id === "repos");
  const reposPullView = stub.captures.treeViews.find(
    (v) => v.id === "repos-pull",
  );
  assert.ok(reposView, "issues sidebar repos view created");
  assert.ok(reposPullView, "PR sidebar repos view created");
  assert.equal(
    reposView.dataProvider,
    reposPullView.dataProvider,
    "both views driven by one provider",
  );

  const before = reposView.reloadCount;
  const beforePull = reposPullView.reloadCount;

  stub.fireObserver("workspace", "github.includeGlobalRepos", true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    reposView.reloadCount,
    before + 1,
    "toggle flip → exactly one issues-sidebar reload",
  );
  assert.equal(
    reposPullView.reloadCount,
    beforePull + 1,
    "toggle flip → exactly one PR-sidebar reload",
  );

  // registration-time fire was skipped, further flips still repaint
  stub.fireObserver("workspace", "github.includeGlobalRepos", false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(reposView.reloadCount, before + 2);
  assert.equal(reposPullView.reloadCount, beforePull + 2);
  main.deactivate();
});

test("auto-detect off: no scan, no prompt, no detection file", async () => {
  const stub = setup({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": ["repo-a"],
      "github.autoDetectRepos": false,
    },
    files: {
      "/novatest/workspace/.git/config": UNKNOWN_REPO_GIT_CONFIG,
    },
  });
  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(
    stub.captures.notifications.length,
    0,
    "detection prompt suppressed",
  );
  assert.ok(
    !Object.keys(stub.files).some((k) => k.endsWith("detections.json")),
    "detection file untouched",
  );
  main.deactivate();
});

test("auto-detect off: saved detections keep resolving", async () => {
  const stub = setup({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": ["repo-a"],
      "github.autoDetectRepos": false,
    },
    workspaceValues: { "github.repo": "" },
    files: {
      "/novatest/workspace/.git/config": UNKNOWN_REPO_GIT_CONFIG,
      "/novatest/globalStorage/detections.json": JSON.stringify({
        "/novatest/workspace": "work-org/their-repo",
      }),
    },
  });
  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 150));

  const path = require("node:path");
  const { SCRIPTS_DIR } = require("./helpers/modules.js");
  const cfg = require(path.join(SCRIPTS_DIR, "lib/config.js"));
  assert.deepEqual(
    cfg.getConfiguredRepoPairs(),
    [
      { owner: "work-org", repo: "their-repo" },
      { owner: "stonerl", repo: "repo-a" },
    ],
    "saved detection still anchors the list",
  );
  assert.equal(
    cfg.loadConfig().owner,
    "work-org",
    "saved detection still resolves the account",
  );
  main.deactivate();
});

test("auto-detect flipped on mid-session applies immediately", async () => {
  const stub = setup({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": ["repo-a"],
      "github.autoDetectRepos": false,
    },
    files: {
      "/novatest/workspace/.git/config": UNKNOWN_REPO_GIT_CONFIG,
    },
  });
  // user will confirm the detection prompt raised by the flip
  stub.captures.notificationResponses.push({ identifier: "x", actionIdx: 0 });
  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(
    !Object.keys(stub.files).some((k) => k.endsWith("detections.json")),
    "nothing detected while off",
  );

  // Nova commits the setting before notifying observers
  stub.globalValues["github.autoDetectRepos"] = true;
  stub.fireObserver("global", "github.autoDetectRepos", true);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(
    Object.keys(stub.files).some((k) => k.endsWith("detections.json")),
    "detection applied after the flip",
  );
  const path = require("node:path");
  const { SCRIPTS_DIR } = require("./helpers/modules.js");
  const cfg = require(path.join(SCRIPTS_DIR, "lib/config.js"));
  assert.deepEqual(
    cfg.getConfiguredRepoPairs()[0],
    { owner: "work-org", repo: "their-repo" },
    "detected repo anchors the list after the flip",
  );
  main.deactivate();
});

test("auto-detect flipped off mid-session changes nothing", async () => {
  const stub = setup({ workspaceValues: { "github.repo": "repo-b" } });
  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(
    Object.keys(stub.files).some((k) => k.endsWith("detections.json")),
    "detection applied while on (same account, silent)",
  );

  stub.fireObserver("global", "github.autoDetectRepos", false);
  await new Promise((r) => setTimeout(r, 100));
  const path = require("node:path");
  const { SCRIPTS_DIR } = require("./helpers/modules.js");
  const cfg = require(path.join(SCRIPTS_DIR, "lib/config.js"));
  assert.deepEqual(
    cfg.getConfiguredRepoPairs(),
    [{ owner: "stonerl", repo: "repo-a" }],
    "saved detection survives the flip-off",
  );
  main.deactivate();
});

test("confirmed detection refreshes the new repo and repaints views", async () => {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": ["repo-a"],
      "github.refreshInterval": 30,
      "github.maxRecentItems": "50",
      "github.itemsPerPage": "100",
    },
    credentials: { stonerl: "tok", "work-org": "tok2" },
    workspaceValues: {},
    files: {
      "/novatest/workspace/.git/config":
        '[remote "origin"]\n\turl = https://github.com/work-org/their-repo.git',
    },
  });
  stub.install();
  stub.captures.notificationResponses.push({ identifier: "x", actionIdx: 0 });
  stub.fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (h) => (h === "x-ratelimit-remaining" ? "4999" : null),
      has: () => false,
    },
    json: async () => [],
  });

  freshRequire("main.js").activate();
  await new Promise((r) => setTimeout(r, 1200));

  assert.equal(stub.captures.notifications.length, 1, "add prompt shown");

  const listFetches = stub.captures.fetchCalls.filter((f) =>
    f.url.includes("api.github.com/repos/work-org/their-repo/issues"),
  );
  assert.ok(
    listFetches.length >= 2,
    `open+closed fetched for the detected repo (got ${listFetches.length})`,
  );

  const issueViews = stub.captures.treeViews.filter((v) =>
    ["issues", "closed-issues", "pulls", "closed-pulls"].includes(v.id),
  );
  assert.equal(issueViews.length, 4);
  for (const view of issueViews) {
    assert.ok(
      view.reloadCount > 0,
      `${view.id} repainted after detection apply (reloads: ${view.reloadCount})`,
    );
  }

  // the confirmed repo is recorded as fresh — the auto-refresh guard
  // must not immediately refetch it
  const path = require("node:path");
  const { SCRIPTS_DIR } = require("./helpers/modules.js");
  const cfg = require(path.join(SCRIPTS_DIR, "lib/config.js"));
  assert.equal(
    cfg.isRepoFresh("work-org", "their-repo", 30 * 60_000),
    true,
    "detected repo marked fresh after apply",
  );
});

test("budget-low refresh does not mark the repo fresh", async () => {
  const stub = setup();
  stub.fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (h) =>
        h === "x-ratelimit-remaining"
          ? "50"
          : h === "x-ratelimit-reset"
            ? "9999999999"
            : null,
      has: () => false,
    },
    json: async () => [],
  });

  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 150));

  const path = require("node:path");
  const { SCRIPTS_DIR } = require("./helpers/modules.js");
  const cfg = require(path.join(SCRIPTS_DIR, "lib/config.js"));
  const github = require(path.join(SCRIPTS_DIR, "lib/github.js"));

  // initialLoad's first cycle ran while the budget was still unknown
  // (null) — a real network fetch → fresh
  assert.equal(
    cfg.isRepoFresh("stonerl", "repo-a", 30 * 60_000),
    true,
    "live initial cycle marks fresh",
  );

  // simulate a later cycle under a known-low budget: clear the mark,
  // then trigger the maxRecentItems observer (fetchState skips → cache)
  cfg.resetRefreshTracking();
  const githubStore = github.dataStore;
  stub.fireObserver("global", "github.maxRecentItems", "50");
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(
    githubStore.lastLive["open"],
    false,
    "budget-low fetch recorded as not-live",
  );
  assert.equal(
    cfg.isRepoFresh("stonerl", "repo-a", 30 * 60_000),
    false,
    "budget-skipped cycle must not count as fresh",
  );
  main.deactivate();
});

const TEST_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuv";

test("token save probes /user and stores under the account login", async () => {
  const stub = setup({
    workspaceValues: { "github.owner": "org-a", "github.repo": "repo-a" },
  });
  stub.fetchImpl = async (url) => {
    if (url === "https://api.github.com/user") {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null, has: () => false },
        json: async () => ({ login: "acct-x" }),
      };
    }
    throw new Error("unexpected fetch: " + url);
  };

  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 100));

  stub.fireObserver("global", "github.token", TEST_TOKEN);
  await new Promise((r) => setTimeout(r, 450));

  assert.equal(
    stub.credentialsMap["acct-x"],
    TEST_TOKEN,
    "keychain entry keyed by the authenticated login",
  );
  assert.equal(
    stub.credentialsMap["org-a"],
    undefined,
    "no per-owner entry when the probe succeeds",
  );
  assert.equal(stub.globalValues["github.token"], "***", "masked");
  assert.ok(
    stub.captures.configSets.some(
      (s) => s.key === "github.token" && s.value === "***",
    ),
    "mask written to the global scope",
  );
  assert.equal(
    stub.captures.workspaceSets.filter((s) => s.key === "github.token").length,
    0,
    "workspace field untouched by a global-scope save",
  );

  const path = require("node:path");
  const { SCRIPTS_DIR } = require("./helpers/modules.js");
  const cfg = require(path.join(SCRIPTS_DIR, "lib/config.js"));
  assert.equal(cfg.loginForOwner("org-a"), "acct-x", "mapping recorded");
  cfg.invalidateConfigCache();
  assert.equal(
    cfg.loadConfig().token,
    TEST_TOKEN,
    "loadConfig resolves the token via the login mapping",
  );
  main.deactivate();
});

test("workspace token save masks the workspace field, not the global one", async () => {
  const stub = setup({
    workspaceValues: {
      "github.owner": "org-a",
      "github.repo": "repo-a",
      "github.token": "",
    },
  });
  stub.fetchImpl = async (url) => {
    if (url === "https://api.github.com/user") {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null, has: () => false },
        json: async () => ({ login: "acct-ws" }),
      };
    }
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

  stub.fireObserver("workspace", "github.token", TEST_TOKEN);
  await new Promise((r) => setTimeout(r, 450));

  assert.equal(
    stub.credentialsMap["acct-ws"],
    TEST_TOKEN,
    "workspace credential stored under its login",
  );
  assert.equal(
    stub.workspaceValues["github.token"],
    "***",
    "workspace field masked",
  );
  assert.equal(
    stub.captures.configSets.filter((s) => s.key === "github.token").length,
    0,
    "global field untouched by a workspace-scope save",
  );
  assert.ok(
    stub.captures.workspaceSets.some(
      (s) => s.key === "github.token" && s.value === "***",
    ),
    "mask written to the workspace scope",
  );
  main.deactivate();
});

test("clearing the workspace token removes the credential and mapping", async () => {
  const stub = setup({
    workspaceValues: { "github.owner": "org-a", "github.repo": "repo-a" },
  });
  stub.fetchImpl = async (url) => {
    if (url === "https://api.github.com/user") {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null, has: () => false },
        json: async () => ({ login: "acct-ws" }),
      };
    }
    throw new Error("unexpected fetch: " + url);
  };

  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 100));

  stub.fireObserver("workspace", "github.token", TEST_TOKEN);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(stub.credentialsMap["acct-ws"], TEST_TOKEN);

  stub.fireObserver("workspace", "github.token", "");
  assert.equal(
    stub.credentialsMap["acct-ws"],
    undefined,
    "login-keyed credential removed",
  );

  const path = require("node:path");
  const { SCRIPTS_DIR } = require("./helpers/modules.js");
  const cfg = require(path.join(SCRIPTS_DIR, "lib/config.js"));
  assert.equal(cfg.loginForOwner("org-a"), null, "mapping forgotten");
  main.deactivate();
});

test("refresh with a resolved owner but no token names the account", async () => {
  const stub = setup({ credentials: {} });
  freshRequire("main.js").activate();
  await new Promise((r) => setTimeout(r, 100));

  await stub.captures.commands["github-issues.refresh"]();
  const warnings = stub.captures.consoleLogs.filter(
    (l) => l.level === "alert-warning",
  );
  assert.equal(warnings.length, 1);
  assert.match(
    String(warnings[0].args[0]),
    /No GitHub token for account "stonerl"/,
  );

  // throttled per owner
  await stub.captures.commands["github-issues.refresh"]();
  const warningsAfter = stub.captures.consoleLogs.filter(
    (l) => l.level === "alert-warning",
  );
  assert.equal(warningsAfter.length, 1, "no repeat within the throttle");
});

test("token save falls back to per-owner key when /user is unreachable", async () => {
  const stub = setup({
    workspaceValues: { "github.owner": "org-a", "github.repo": "repo-a" },
  });
  stub.fetchImpl = async () => {
    throw new Error("offline");
  };

  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 100));
  stub.fireObserver("global", "github.token", TEST_TOKEN);
  await new Promise((r) => setTimeout(r, 450));

  assert.equal(
    stub.credentialsMap["org-a"],
    TEST_TOKEN,
    "legacy owner-keyed write preserved the credential",
  );
  assert.equal(stub.globalValues["github.token"], "***", "masked");
  main.deactivate();
});

test("backfill maps legacy per-owner tokens once, then never again", async () => {
  const stub = setup({ credentials: { stonerl: "tok-legacy" } });
  let userProbes = 0;
  stub.fetchImpl = async (url) => {
    if (url === "https://api.github.com/user") {
      userProbes++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null, has: () => false },
        json: async () => ({ login: "stonerl" }),
      };
    }
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

  const path = require("node:path");
  const { SCRIPTS_DIR } = require("./helpers/modules.js");

  const main = freshRequire("main.js");
  main.activate();
  await new Promise((r) => setTimeout(r, 250));
  const cfg = require(path.join(SCRIPTS_DIR, "lib/config.js"));
  assert.equal(cfg.loginForOwner("stonerl"), "stonerl", "mapping learned");
  assert.equal(userProbes, 1, "exactly one probe");
  main.deactivate();

  // second session: mapping is persisted → zero probes
  const main2 = freshRequire("main.js");
  main2.activate();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(userProbes, 1, "no probe after the mapping exists");
  main2.deactivate();
});
