"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createNovaStub } = require("./helpers/nova-stub.js");
const { freshRequire } = require("./helpers/modules.js");

const GIT_CONFIG = [
  "[core]",
  "\trepositoryformatversion = 0",
  '[remote "origin"]',
  "\turl = git@github.com:stonerl/repo-a.git",
  "\tfetch = +refs/heads/*:refs/remotes/origin/*",
  '[branch "main"]',
  "\tremote = origin",
].join("\n");

test("parseRemoteUrl handles all GitHub URL shapes", () => {
  const detect = freshRequire("lib/detect.js");
  const p = detect.parseRemoteUrl;
  assert.deepEqual(p("https://github.com/o/r.git"), { owner: "o", repo: "r" });
  assert.deepEqual(p("https://github.com/o/r"), { owner: "o", repo: "r" });
  assert.deepEqual(p("https://github.com/o/r.git/"), { owner: "o", repo: "r" });
  assert.deepEqual(p("git@github.com:o/r.git"), { owner: "o", repo: "r" });
  assert.deepEqual(p("ssh://git@github.com/o/r.git"), {
    owner: "o",
    repo: "r",
  });
  assert.deepEqual(p("https://github.com/my.org/my-repo.name.git"), {
    owner: "my.org",
    repo: "my-repo.name",
  });
  assert.equal(p("https://gitlab.com/o/r.git"), null);
  assert.equal(p("https://bitbucket.org/o/r.git"), null);
});

test("parseGitConfig prefers origin, falls back to first GitHub remote", () => {
  const detect = freshRequire("lib/detect.js");
  assert.deepEqual(detect.parseGitConfig(GIT_CONFIG), {
    owner: "stonerl",
    repo: "repo-a",
  });

  const originSecond = [
    '[remote "upstream"]',
    "\turl = https://github.com/someone/upstream.git",
    '[remote "origin"]',
    "\turl = https://github.com/me/mine.git",
  ].join("\n");
  assert.deepEqual(detect.parseGitConfig(originSecond), {
    owner: "me",
    repo: "mine",
  });

  const originNotGitHub = [
    '[remote "origin"]',
    "\turl = https://gitlab.com/o/r.git",
    '[remote "work"]',
    "\turl = https://github.com/work-org/work-repo.git",
  ].join("\n");
  assert.deepEqual(detect.parseGitConfig(originNotGitHub), {
    owner: "work-org",
    repo: "work-repo",
  });

  assert.equal(
    detect.parseGitConfig(
      '[remote "origin"]\n\turl = https://gitlab.com/o/r.git',
    ),
    null,
  );
  assert.equal(detect.parseGitConfig(""), null);
  assert.equal(detect.parseGitConfig(null), null);
});

test("decideDetection matrix", () => {
  const detect = freshRequire("lib/detect.js");
  const base = {
    owner: "stonerl",
    repos: [
      { owner: "stonerl", repo: "repo-a" },
      { owner: "stonerl", repo: "repo-b" },
    ],
    activeRepo: { owner: "stonerl", repo: "repo-a" },
  };

  assert.deepEqual(decide(detect, null, base), { type: "none" });
  assert.deepEqual(decide(detect, { owner: "stonerl", repo: "repo-a" }, base), {
    type: "none",
  });
  assert.deepEqual(decide(detect, { owner: "stonerl", repo: "repo-b" }, base), {
    type: "setActiveRepo",
    owner: "stonerl",
    repo: "repo-b",
  });
  assert.deepEqual(
    decide(detect, { owner: "work-org", repo: "work-repo" }, base),
    { type: "confirmNewAccount", owner: "work-org", repo: "work-repo" },
  );
  assert.deepEqual(decide(detect, { owner: "stonerl", repo: "other" }, base), {
    type: "confirmNewAccount",
    owner: "stonerl",
    repo: "other",
  });
  // pair membership: a same-named repo of ANOTHER owner is not "in
  // the list" for this account
  assert.deepEqual(
    decide(detect, { owner: "other-org", repo: "repo-a" }, base),
    { type: "confirmNewAccount", owner: "other-org", repo: "repo-a" },
  );
});

test("decideDetection: prefixed list entries count as configured", () => {
  const detect = freshRequire("lib/detect.js");
  const base = {
    owner: "stonerl",
    repos: [{ owner: "CrankBoyHQ", repo: "crankboy-app" }],
    activeRepo: null,
  };
  assert.deepEqual(
    decide(detect, { owner: "CrankBoyHQ", repo: "crankboy-app" }, base),
    { type: "confirmNewAccount", owner: "CrankBoyHQ", repo: "crankboy-app" },
    "in list, but a different account than the home one → still asks",
  );
});

test("decideDetection: a matching decline short-circuits to none", () => {
  const detect = freshRequire("lib/detect.js");
  const base = {
    owner: "stonerl",
    repos: ["repo-a"],
    activeRepo: "repo-a",
    declined: "work-org/their-repo",
  };

  // the declined repo — silent, regardless of account state
  assert.deepEqual(
    decide(detect, { owner: "work-org", repo: "their-repo" }, base),
    { type: "none" },
  );
  // a different unconfirmed repo from the same account still asks
  assert.deepEqual(
    decide(detect, { owner: "work-org", repo: "other-repo" }, base),
    { type: "confirmNewAccount", owner: "work-org", repo: "other-repo" },
  );
  // declined value for one repo doesn't suppress others
  const declinedOther = { ...base, declined: "stonerl/repo-b" };
  assert.deepEqual(
    decide(detect, { owner: "work-org", repo: "their-repo" }, declinedOther),
    { type: "confirmNewAccount", owner: "work-org", repo: "their-repo" },
  );
  // no decline recorded → unchanged matrix
  const noDecline = {
    owner: "stonerl",
    repos: ["repo-a"],
    activeRepo: "repo-a",
  };
  assert.deepEqual(
    decide(detect, { owner: "work-org", repo: "their-repo" }, noDecline),
    { type: "confirmNewAccount", owner: "work-org", repo: "their-repo" },
  );
});

function decide(detect, detected, current) {
  return detect.decideDetection(detected, current);
}

test("detection persists per workspace path and survives reload", () => {
  const stub = createNovaStub({ globalValues: { "github.owner": "stonerl" } });
  stub.install();
  const cfg = freshRequire("lib/config.js");

  cfg.saveDetectionForWorkspace("CrankBoyHQ", "crankboy-app");
  assert.equal(cfg.detectedOverride().owner, "CrankBoyHQ");
  assert.equal(cfg.detectedOverride().repo, "crankboy-app");

  // fresh module state (simulates restart) + reload from disk
  const cfg2 = freshRequire("lib/config.js");
  cfg2.loadDetections();
  assert.equal(cfg2.detectedOverride().owner, "CrankBoyHQ");
  assert.equal(cfg2.detectedOverride().repo, "crankboy-app");
});

test("forgetDetectionForWorkspace removes entry and clears memory", () => {
  const stub = createNovaStub({ globalValues: { "github.owner": "stonerl" } });
  stub.install();
  const cfg = freshRequire("lib/config.js");

  cfg.saveDetectionForWorkspace("stonerl", "repo-a");
  assert.notEqual(cfg.detectedOverride(), null);

  cfg.forgetDetectionForWorkspace();
  assert.equal(cfg.detectedOverride(), null);

  // reload from disk: gone
  const cfg2 = freshRequire("lib/config.js");
  cfg2.loadDetections();
  assert.equal(cfg2.detectedOverride(), null);
});
