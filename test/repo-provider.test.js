"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createNovaStub } = require("./helpers/nova-stub.js");
const { freshRequire } = require("./helpers/modules.js");

function setup({ globalRepos, workspace = {}, detected = null } = {}) {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.repos": globalRepos,
    },
    workspaceValues: workspace,
    ...(detected
      ? {
          files: {
            "/novatest/globalStorage/detections.json": JSON.stringify({
              "/novatest/workspace": detected,
            }),
          },
        }
      : {}),
  });
  stub.install();
  const path = require("node:path");
  const { SCRIPTS_DIR } = require("./helpers/modules.js");
  const cfg = freshRequire("lib/config.js");
  cfg.loadDetections();
  // plain require: shares the config instance that holds the loaded
  // detection — another freshRequire would bust it and lose the state
  const { GitHubRepoProvider } = require(
    path.join(SCRIPTS_DIR, "lib/tree/repo-provider.js"),
  );
  const provider = new GitHubRepoProvider();
  provider.updateRepoList();
  return { stub, cfg, provider };
}

const ids = (provider) => provider.rootItems.map((i) => i.identifier);
const titles = (provider) => provider.rootItems.map((i) => i.title ?? i.name);
const contextValues = (provider) =>
  provider.rootItems.map((i) => i.contextValue);

test("single repo: no divider row, canonical identifier", () => {
  const { provider } = setup({
    globalRepos: ["repo-a"],
    workspace: { "github.repo": "repo-a" },
  });
  assert.equal(provider.rootItems.length, 1);
  assert.deepEqual(ids(provider), ["stonerl/repo-a"]);
  assert.deepEqual(titles(provider), ["repo-a"], "own-account row is bare");
  assert.deepEqual(contextValues(provider), ["repo-item"]);
});

test("multiple repos: divider sits between the current repo and the rest", () => {
  const { provider } = setup({
    globalRepos: ["repo-a", "repo-b"],
    workspace: { "github.repo": "repo-a" },
  });
  assert.deepEqual(contextValues(provider), [
    "repo-item",
    "separator",
    "repo-item",
  ]);
  assert.deepEqual(ids(provider), ["stonerl/repo-a", null, "stonerl/repo-b"]);
});

test("divider position follows the selection when it is not the first repo", () => {
  const { provider } = setup({
    globalRepos: ["repo-a", "repo-b", "repo-c"],
    workspace: { "github.repo": "repo-b" },
  });
  assert.deepEqual(ids(provider), [
    "stonerl/repo-b",
    null,
    "stonerl/repo-a",
    "stonerl/repo-c",
  ]);
});

test("org repo rows show the owner prefix, own-account rows stay bare", () => {
  const { provider } = setup({
    globalRepos: ["crankboy-app", "CrankBoyHQ/crankboy-app"],
    workspace: { "github.repo": "stonerl/crankboy-app" },
  });
  assert.deepEqual(titles(provider), [
    "crankboy-app",
    "",
    "CrankBoyHQ/crankboy-app",
  ]);
  assert.deepEqual(ids(provider), [
    "stonerl/crankboy-app",
    null,
    "CrankBoyHQ/crankboy-app",
  ]);
});

test("stale selection falls back to the first repo, persisted canonical", () => {
  const { stub, provider } = setup({
    globalRepos: ["repo-a"],
    workspace: { "github.repo": "ghost" },
  });
  assert.deepEqual(ids(provider), ["stonerl/repo-a"]);
  assert.ok(
    stub.captures.workspaceSets.some(
      (s) => s.key === "github.repo" && s.value === "stonerl/repo-a",
    ),
    "fallback persisted as a canonical owner/repo ref",
  );
});

test("stale prefixed selection falls back, not to a same-named other-owner repo", () => {
  const { provider } = setup({
    globalRepos: ["crankboy-app", "CrankBoyHQ/crankboy-app"],
    workspace: { "github.repo": "CrankBoyHQ/ghost" },
  });
  // ghost is unknown → the first pair becomes current, and it's the
  // stonerl one; both rows still render
  assert.deepEqual(ids(provider), [
    "stonerl/crankboy-app",
    null,
    "CrankBoyHQ/crankboy-app",
  ]);
  assert.deepEqual(titles(provider), [
    "crankboy-app",
    "",
    "CrankBoyHQ/crankboy-app",
  ]);
});

test("legacy bare selection is rewritten in canonical form once", () => {
  const { stub, provider } = setup({
    globalRepos: ["repo-a"],
    workspace: { "github.repo": "repo-a" },
  });
  // rows unchanged — this is a pure reformat
  assert.deepEqual(ids(provider), ["stonerl/repo-a"]);
  assert.ok(
    stub.captures.workspaceSets.some(
      (s) => s.key === "github.repo" && s.value === "stonerl/repo-a",
    ),
    "bare legacy value normalized to owner/repo",
  );
});

test("canonical selection causes no github.repo write churn", () => {
  const { stub } = setup({
    globalRepos: ["repo-a"],
    workspace: { "github.repo": "stonerl/repo-a" },
  });
  assert.equal(
    stub.captures.workspaceSets.filter((s) => s.key === "github.repo").length,
    0,
    "already canonical → nothing to write",
  );
});

test("detection-context bare selection normalizes to the detected pair", () => {
  const { stub, provider } = setup({
    globalRepos: ["repo-a"],
    workspace: { "github.repo": "repo-x" },
    detected: "org-x/repo-x",
  });
  // bare "repo-x" resolves against the detected account, so the
  // canonical form is org-x/repo-x — not the first list row
  assert.deepEqual(
    provider.rootItems[0].identifier,
    "org-x/repo-x",
    "active repo unchanged",
  );
  assert.ok(
    stub.captures.workspaceSets.some(
      (s) => s.key === "github.repo" && s.value === "org-x/repo-x",
    ),
    "normalized to the resolved pair",
  );
});

test("detected-only repo is forgettable, configured rows are not", () => {
  const { provider } = setup({
    globalRepos: ["repo-a"],
    workspace: { "github.repo": "stonerl/repo-a" },
    detected: "org-x/repo-x",
  });
  // detection anchors: org-x/repo-x, then the global list. The current
  // selection (stonerl/repo-a) leads the rows; the org row is prefixed.
  assert.deepEqual(contextValues(provider), [
    "repo-item",
    "separator",
    "detected-repo-item",
  ]);
  assert.deepEqual(ids(provider), ["stonerl/repo-a", null, "org-x/repo-x"]);
  // display rule keys off the user's own (global) account: stonerl
  // rows are bare, the detected org's repo shows prefixed
  assert.deepEqual(titles(provider), ["repo-a", "", "org-x/repo-x"]);
});

test("detection-anchored org repo shows the owner prefix", () => {
  const { provider } = setup({
    globalRepos: [],
    workspace: { "github.repo": "CrankBoyHQ/crankboy-app" },
    detected: "CrankBoyHQ/crankboy-app",
  });
  // the workspace's account is an org, not the user's own account —
  // the row must carry the prefix even though it is the active repo
  assert.deepEqual(ids(provider), ["CrankBoyHQ/crankboy-app"]);
  assert.deepEqual(titles(provider), ["CrankBoyHQ/crankboy-app"]);
  assert.deepEqual(contextValues(provider), ["detected-repo-item"]);
});

test("detected repo that is also configured explicitly is a plain row", () => {
  const { provider } = setup({
    globalRepos: ["repo-a", "org-x/repo-x"],
    workspace: { "github.repo": "org-x/repo-x" },
    detected: "org-x/repo-x",
  });
  assert.deepEqual(contextValues(provider), [
    "repo-item",
    "separator",
    "repo-item",
  ]);
  assert.deepEqual(ids(provider), ["org-x/repo-x", null, "stonerl/repo-a"]);
});
