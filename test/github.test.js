"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createNovaStub } = require("./helpers/nova-stub.js");
const { freshRequire } = require("./helpers/modules.js");

function setup(stubOptions = {}) {
  const stub = createNovaStub({
    globalValues: {
      "github.owner": "stonerl",
      "github.refreshInterval": 30,
      "github.maxRecentItems": "50",
      "github.itemsPerPage": "100",
      ...(stubOptions.globalValues || {}),
    },
    credentials: { stonerl: "tok" },
    workspaceValues: { "github.repo": "r" },
    ...stubOptions,
  });
  stub.install();
  return { stub, github: freshRequire("lib/github.js") };
}

function apiResponse(items, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (h) => headers[h] ?? (h === "x-ratelimit-remaining" ? "4999" : null),
      has: (h) => headers[h] !== undefined,
    },
    json: async () => items,
  };
}

const makeItem = (id, isPR = false, updated = "2026-01-01T00:00:00Z") => ({
  id,
  number: id,
  title: `item-${id}`,
  state: "open",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: updated,
  user: { login: "x" },
  comments: 0,
  ...(isPR ? { pull_request: {} } : {}),
});

test("concurrent fetchState calls for the same state share one request", async () => {
  const { stub, github } = setup();
  stub.fetchImpl = async () => apiResponse([makeItem(1)]);
  await Promise.all([
    github.dataStore.fetchState("open", "tok", "o", "r"),
    github.dataStore.fetchState("open", "tok", "o", "r"),
    github.dataStore.fetchState("open", "tok", "o", "r"),
  ]);
  assert.equal(stub.captures.fetchCalls.length, 1);
  assert.equal(github.wasLiveFetch("open"), true, "network success → live");
});

test("in-flight entry is cleaned up after settling", async () => {
  const { stub, github } = setup();
  stub.fetchImpl = async () => apiResponse([makeItem(1)]);
  await github.dataStore.fetchState("open", "tok", "o", "r");
  assert.equal(github.dataStore._inFlight["open"], undefined);
});

test("ETag: second fetch sends If-None-Match; 304 serves disk cache", async () => {
  const { stub, github } = setup({
    files: {}, // allow disk writes
  });
  const items = [makeItem(1)];
  stub.fetchImpl = async (url, opts) => {
    if (opts?.headers?.["If-None-Match"]) {
      return {
        ok: false,
        status: 304,
        headers: { get: () => null, has: () => false },
        json: async () => [],
      };
    }
    return apiResponse(items, { etag: '"abc"' });
  };

  const first = await github.dataStore.fetchState("open", "tok", "o", "r");
  assert.equal(first.length, 1);
  assert.equal(github.dataStore.etags["open"], '"abc"');

  const second = await github.dataStore.fetchState("open", "tok", "o", "r");
  assert.deepEqual(second, items, "304 → disk cache");
  assert.equal(
    github.wasLiveFetch("open"),
    true,
    "304 is server-confirmed fresh → live",
  );
  const calls = stub.captures.fetchCalls;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers["If-None-Match"], '"abc"');
});

test("rate-limit: flag held (no fetch), one log, one alert", async () => {
  const { stub, github } = setup({ files: {} });
  stub.fetchImpl = async () => ({
    ok: false,
    status: 403,
    headers: { get: () => null, has: () => false }, // no reset headers
    json: async () => [],
  });

  await github.dataStore.fetchState("open", "tok", "o", "r");
  const after = stub.captures.fetchCalls.length;

  await github.dataStore.fetchState("closed", "tok", "o", "r");
  await github.dataStore.fetchState("open", "tok", "o", "r");
  assert.equal(
    stub.captures.fetchCalls.length,
    after,
    "rate-limited → no further fetches",
  );
  assert.equal(
    github.wasLiveFetch("closed"),
    false,
    "rate-limit fallback is not live",
  );
  assert.equal(
    github.wasLiveFetch("open"),
    false,
    "403 error fallback is not live",
  );

  const rateLogs = stub.captures.consoleLogs.filter((l) =>
    String(l.args[0]).includes("rate-limited"),
  );
  assert.equal(rateLogs.length, 1, "one log per label");
  const alerts = stub.captures.consoleLogs.filter(
    (l) =>
      l.level === "alert-warning" && String(l.args[0]).includes("rate limit"),
  );
  assert.equal(alerts.length, 1, "one throttled alert");
});

test("budget low: auto fetch skips + serves disk cache; manual fetches", async () => {
  const { stub, github } = setup({ files: {} });
  stub.fetchImpl = async () =>
    apiResponse([makeItem(1)], {
      "x-ratelimit-remaining": "50",
      "x-ratelimit-reset": "9999999999",
    });

  // one real fetch records the low budget
  await github.dataStore.fetchState("closed", "tok", "o", "r", {
    allowBudgetSkip: false,
  });
  const after = stub.captures.fetchCalls.length;

  const data = await github.dataStore.fetchState("closed", "tok", "o", "r");
  assert.equal(stub.captures.fetchCalls.length, after, "auto → no network");
  assert.ok(Array.isArray(data) && data.length > 0, "disk cache served");
  assert.equal(
    github.wasLiveFetch("closed"),
    false,
    "budget-low fallback is not live",
  );

  await github.dataStore.fetchState("closed", "tok", "o", "r", {
    allowBudgetSkip: false,
  });
  assert.equal(
    stub.captures.fetchCalls.length,
    after + 1,
    "manual overrides gate",
  );
  assert.equal(github.wasLiveFetch("closed"), true, "manual fetch is live");
});

test("wasLiveFetch: never-fetched and network-error fallbacks are not live", async () => {
  const { stub, github } = setup({ files: {} });

  assert.equal(github.wasLiveFetch("open"), false, "never fetched → not live");

  stub.fetchImpl = async () => {
    throw new Error("offline");
  };
  await github.dataStore.fetchState("open", "tok", "o", "r");
  assert.equal(
    github.wasLiveFetch("open"),
    false,
    "network error fallback → not live",
  );
});

test("HTTP classification: 401 → auth alert, 403 → forbidden alert", async () => {
  const { stub, github } = setup({ files: {} });
  stub.fetchImpl = async () => ({
    ok: false,
    status: 401,
    headers: {
      get: (h) => (h === "x-ratelimit-remaining" ? "4999" : null),
      has: () => false,
    },
    json: async () => [],
  });
  await github.dataStore.fetchState("open", "tok", "o", "r");
  const alerts = stub.captures.consoleLogs.filter(
    (l) => l.level === "alert-error",
  );
  assert.equal(alerts.length, 1);
  assert.match(String(alerts[0].args[0]), /401/);

  stub.fetchImpl = async () => ({
    ok: false,
    status: 403,
    headers: {
      get: (h) => (h === "x-ratelimit-remaining" ? "4999" : null),
      has: () => false,
    },
    json: async () => [],
  });
  await github.dataStore.fetchState("closed", "tok", "o", "r");
  const warnings = stub.captures.consoleLogs.filter(
    (l) => l.level === "alert-warning",
  );
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0].args[0]), /403/);
});

test("fetch writes a state-named disk cache file", async () => {
  const { stub, github } = setup({ files: {} });
  stub.fetchImpl = async () => apiResponse([makeItem(1)]);
  await github.dataStore.fetchState("open", "tok", "o", "r");
  const written = Object.keys(stub.files).find((k) => k.endsWith("/open.json"));
  assert.ok(written, "state-named cache file written");
});
