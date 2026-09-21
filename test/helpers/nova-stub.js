// test/helpers/nova-stub.js
// Simulates the Nova extension runtime: configuration scopes with
// Nova-like observer semantics (one immediate fire at registration),
// Keychain, injectable filesystem, scriptable fetch, TreeView/TreeItem,
// notifications, and a command registry — all with capture surfaces
// so tests can assert on interactions.

"use strict";

// Keep the TRUE console originals across all stub instances so repeated
// installs never stack capture wrappers.
const consoleOriginals = {};

function createNovaStub(options = {}) {
  // seeds survive reset()
  const seeds = {
    global: options.globalValues || {},
    workspace: options.workspaceValues || {},
    credentials: options.credentials || {},
    files: options.files || {},
  };

  const stub = {
    // ── state ────────────────────────────────────────────────
    globalValues: options.globalValues || {},
    workspaceValues: options.workspaceValues || {},
    credentialsMap: options.credentials || {},
    files: options.files || {}, // path → string content (or undefined = missing)
    // directories that "exist" for fs.mkdir; others throw (Nova-like)
    existingDirs: new Set(options.existingDirs || []),
    fetchImpl: options.fetchImpl || null, // async (url, opts) => response

    // ── capture surfaces ─────────────────────────────────────
    captures: {
      configGets: [],
      configSets: [],
      workspaceGets: [],
      workspaceSets: [],
      contextSets: [],
      keychainReads: [],
      keychainWrites: [],
      fetchCalls: [], // { url, options }
      treeViews: [], // TreeView instances
      notifications: [], // NotificationRequest instances
      notificationResponses: [], // queued responses for add()
      commands: {}, // name → handler
      clipboard: null,
      openedURLs: [],
      consoleLogs: [], // { level, args }
    },

    reset() {
      stub.globalValues = { ...seeds.global };
      stub.workspaceValues = { ...seeds.workspace };
      stub.credentialsMap = { ...seeds.credentials };
      stub.files = { ...seeds.files };
      stub.existingDirs = new Set();
      stub.fetchImpl = null;
      stub.captures.configGets = [];
      stub.captures.configSets = [];
      stub.captures.workspaceGets = [];
      stub.captures.workspaceSets = [];
      stub.captures.contextSets = [];
      stub.captures.keychainReads = [];
      stub.captures.keychainWrites = [];
      stub.captures.fetchCalls = [];
      stub.captures.treeViews = [];
      stub.captures.notifications = [];
      stub.captures.notificationResponses = [];
      stub.captures.commands = {};
      stub.captures.clipboard = null;
      stub.captures.openedURLs = [];
      stub.captures.consoleLogs = [];
      stub._observers = { global: {}, workspace: {} };
      stub._registerObserversQuiet = false;
      stub._silentConsole = false;
    },

    // Nova fires each observer once with the current value at
    // registration. Set to false in tests that assert on registration
    // behavior itself.
    _observers: { global: {}, workspace: {} },
    _registerObserversQuiet: false,
    _silentConsole: false,

    fireObserver(scope, key, value) {
      for (const fn of stub._observers[scope][key] || []) fn(value);
    },

    captureConsole() {
      stub._silentConsole = true;
    },
  };

  function wrapConsole(level) {
    if (!consoleOriginals[level]) consoleOriginals[level] = console[level];
    console[level] = (...args) => {
      stub.captures.consoleLogs.push({ level, args });
      if (!stub._silentConsole) consoleOriginals[level](...args);
    };
  }

  stub.install = function install() {
    // restore originals first so installs never stack wrappers
    for (const level of ["log", "warn", "error"]) {
      if (consoleOriginals[level]) console[level] = consoleOriginals[level];
    }
    global.__stub = stub; // tests assert on captures via this handle
    global.nova = {
      extension: {
        globalStoragePath: "/novatest/globalStorage",
        get globalStorageExists() {
          return true;
        },
      },
      config: {
        get(key) {
          stub.captures.configGets.push(key);
          return stub.globalValues[key] ?? null;
        },
        set(key, value) {
          stub.captures.configSets.push({ key, value });
          stub.globalValues[key] = value;
        },
        remove(key) {
          delete stub.globalValues[key];
        },
        observe(key, fn) {
          (stub._observers.global[key] ??= []).push(fn);
          if (!stub._registerObserversQuiet) fn(stub.globalValues[key] ?? null);
          return { dispose() {} };
        },
      },
      workspace: {
        path: stub.workspacePath ?? "/novatest/workspace",
        config: {
          get(key) {
            stub.captures.workspaceGets.push(key);
            return stub.workspaceValues[key] ?? null;
          },
          set(key, value) {
            stub.captures.workspaceSets.push({ key, value });
            stub.workspaceValues[key] = value;
          },
          observe(key, fn) {
            (stub._observers.workspace[key] ??= []).push(fn);
            if (!stub._registerObserversQuiet)
              fn(stub.workspaceValues[key] ?? null);
            return { dispose() {} };
          },
        },
        context: {
          set(key, value) {
            stub.captures.contextSets.push({ key, value });
          },
        },
        onDidChangePath(fn) {
          stub.onDidChangePathHandler = fn;
          return { dispose() {} };
        },
        showErrorMessage(msg) {
          stub.captures.consoleLogs.push({ level: "alert-error", args: [msg] });
          return Promise.resolve();
        },
        showWarningMessage(msg) {
          stub.captures.consoleLogs.push({
            level: "alert-warning",
            args: [msg],
          });
          return Promise.resolve();
        },
        showInformativeMessage(msg) {
          stub.captures.consoleLogs.push({ level: "alert-info", args: [msg] });
          return Promise.resolve();
        },
        showChoicePalette(choices, opts, cb) {
          stub.captures.choicePalettes = stub.captures.choicePalettes || [];
          stub.captures.choicePalettes.push(choices);
          return Promise.resolve(null);
        },
      },
      credentials: {
        getPassword(service, account) {
          stub.captures.keychainReads.push(account);
          return stub.credentialsMap[account] ?? null;
        },
        setPassword(service, account, value) {
          stub.captures.keychainWrites.push({ account, value });
          stub.credentialsMap[account] = value;
        },
        removePassword(service, account) {
          stub.captures.keychainWrites.push({ account, removed: true });
          delete stub.credentialsMap[account];
        },
      },
      fs: {
        mkdir(dir) {
          stub.captures.mkdirAttempts = (stub.captures.mkdirAttempts || 0) + 1;
          if (!stub.existingDirs.has(dir)) {
            stub.existingDirs.add(dir);
            return;
          }
          throw new Error("File exists");
        },
        listdir(dir) {
          const prefix = dir.endsWith("/") ? dir : dir + "/";
          const names = new Set();
          for (const p of Object.keys(stub.files)) {
            if (p.startsWith(prefix))
              names.add(p.slice(prefix.length).split("/")[0]);
          }
          for (const d of stub.existingDirs) {
            if (d.startsWith(prefix))
              names.add(d.slice(prefix.length).split("/")[0]);
          }
          if (names.size === 0 && !stub.existingDirs.has(dir)) {
            throw new Error("No such directory");
          }
          return [...names];
        },
        remove(path) {
          delete stub.files[path]; // Nova: missing file = no-op
        },
        rmdir(path) {
          stub.existingDirs.delete(path);
          for (const p of Object.keys(stub.files)) {
            if (p.startsWith(path + "/")) delete stub.files[p];
          }
        },
        open(path, mode) {
          if (String(mode).includes("w")) {
            return {
              write(text) {
                stub.files[path] = String(text);
              },
              close() {},
            };
          }
          const content = stub.files[path];
          if (content === undefined) throw new Error("No such file");
          return {
            read() {
              return content;
            },
            close() {},
          };
        },
      },
      subscriptions: {
        add(...disposables) {
          stub.captures.subscriptions ??= [];
          stub.captures.subscriptions.push(...disposables);
        },
      },
      commands: {
        register(name, fn) {
          stub.captures.commands[name] = fn;
        },
        async invoke(name, ...args) {
          const fn = stub.captures.commands[name];
          if (!fn) throw new Error(`No command: ${name}`);
          return fn(global.nova.workspace, ...args);
        },
      },
      clipboard: {
        writeText(text) {
          stub.captures.clipboard = text;
        },
      },
      openURL(url) {
        stub.captures.openedURLs.push(url);
      },
      notifications: {
        add(request) {
          stub.captures.notifications.push(request);
          const queued = stub.captures.notificationResponses.shift() ?? {
            identifier: request.identifier,
            actionIdx: null,
          };
          return Promise.resolve(queued);
        },
      },
      versionString: "14.1 (810813)",
    };

    global.TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
    global.TreeItem = class TreeItem {
      constructor(name, state) {
        this.name = name;
        this.collapsibleState = state;
        this.identifier = null;
        this.contextValue = null;
      }
    };
    global.TreeView = class TreeView {
      constructor(id, opts) {
        this.id = id;
        this.dataProvider = opts?.dataProvider ?? null;
        this.reloadCount = 0;
        stub.captures.treeViews.push(this);
      }
      reload() {
        this.reloadCount++;
      }
      onDidChangeSelection(fn) {
        (this._selectionHandlers ??= []).push(fn);
      }
      fireSelection(items) {
        for (const fn of this._selectionHandlers || []) fn(items);
      }
      onDidChangeVisibility(fn) {
        (this._visibilityHandlers ??= []).push(fn);
      }
      fireVisibility(visible) {
        for (const fn of this._visibilityHandlers || []) fn(visible);
      }
    };
    global.Color = { rgb: (r, g, b) => ({ r, g, b }) };
    global.NotificationRequest = class NotificationRequest {
      constructor(id) {
        this.identifier = id;
        this.actions = [];
      }
    };

    global.fetch = async (url, opts) => {
      stub.captures.fetchCalls.push({ url, options: opts });
      if (stub.fetchImpl) return stub.fetchImpl(url, opts);
      throw new Error("offline (no fetchImpl configured)");
    };

    wrapConsole("log");
    wrapConsole("warn");
    wrapConsole("error");
    stub._consoleWrapped = true;

    return stub;
  };

  stub.reset();

  // Seed console wrappers so pre-install logging is captured too.
  stub.captureConsole();

  return stub;
}

module.exports = { createNovaStub };
