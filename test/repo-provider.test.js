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

function contextValues(provider) {
  return provider.rootItems.map((i) => i.contextValue);
}

test("single repo: no divider row", () => {
  const { provider } = setup({
    globalRepos: ["repo-a"],
    workspace: { "github.repo": "repo-a" },
  });
  assert.equal(provider.rootItems.length, 1);
  assert.deepEqual(contextValues(provider), ["repo-item"]);
  assert.equal(provider.rootItems[0].identifier, "repo-a");
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
  assert.deepEqual(
    provider.rootItems.map((i) => i.identifier),
    ["repo-a", null, "repo-b"],
  );
});

test("divider position follows the selection when it is not the first repo", () => {
  const { provider } = setup({
    globalRepos: ["repo-a", "repo-b", "repo-c"],
    workspace: { "github.repo": "repo-b" },
  });
  assert.deepEqual(
    provider.rootItems.map((i) => i.identifier),
    ["repo-b", null, "repo-a", "repo-c"],
  );
});

test("stale selection falls back to the first repo, still no divider", () => {
  const { stub, provider } = setup({
    globalRepos: ["repo-a"],
    workspace: { "github.repo": "ghost" },
  });
  assert.deepEqual(contextValues(provider), ["repo-item"]);
  assert.equal(provider.rootItems[0].identifier, "repo-a");
  assert.ok(
    stub.captures.workspaceSets.some(
      (s) => s.key === "github.repo" && s.value === "repo-a",
    ),
    "fallback persisted",
  );
});

test("detected-only repo is forgettable, configured rows are not", () => {
  const { provider } = setup({
    globalRepos: ["repo-a"],
    workspace: { "github.repo": "repo-a" },
    detected: "org-x/repo-x",
  });
  // detection anchors: repo-x, then the global list. The current
  // selection (repo-a) leads the rows.
  assert.deepEqual(contextValues(provider), [
    "repo-item",
    "separator",
    "detected-repo-item",
  ]);
  assert.deepEqual(
    provider.rootItems.map((i) => i.identifier),
    ["repo-a", null, "repo-x"],
  );
});

test("detected repo that is also configured explicitly is a plain row", () => {
  const { provider } = setup({
    globalRepos: ["repo-a", "repo-x"],
    workspace: { "github.repo": "repo-x" },
    detected: "org-x/repo-x",
  });
  assert.deepEqual(contextValues(provider), [
    "repo-item",
    "separator",
    "repo-item",
  ]);
  assert.deepEqual(
    provider.rootItems.map((i) => i.identifier),
    ["repo-x", null, "repo-a"],
  );
});
