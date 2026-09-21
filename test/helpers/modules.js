// test/helpers/modules.js
// Fresh module loading: the extension's modules keep state at module
// scope (dataStore caches, detection memory, throttle timestamps), so
// every test that requires them gets virgin state by busting the
// require cache for everything under Scripts/.

"use strict";

const path = require("node:path");

const SCRIPTS_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "GitHub.novaextension",
  "Scripts",
);

function bustExtensionModuleCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SCRIPTS_DIR + path.sep)) {
      delete require.cache[key];
    }
  }
}

function freshRequire(relPath) {
  bustExtensionModuleCache();
  return require(path.join(SCRIPTS_DIR, relPath));
}

module.exports = { freshRequire, SCRIPTS_DIR };
