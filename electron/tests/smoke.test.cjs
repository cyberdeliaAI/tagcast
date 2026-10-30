"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const {readFileSync} = require("node:fs");
const vm = require("node:vm");

function harness() {
  const reports = [], timers = [], app = new EventEmitter(), contents = new EventEmitter();
  let quits = 0;
  app.quit = () => quits++;
  contents.getLastWebPreferences = () => ({sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true});
  contents.executeJavaScript = () => new Promise(() => {});
  const window = {webContents: contents, close() {}};
  const module = {exports: {}};
  const context = {
    module, performance: {now: () => 100},
    process: {env: {TAGCAST_HOME: "/isolated/settings", TAGCAST_ELECTRON_PROFILE: "/isolated/profile", TAGCAST_ELECTRON_SMOKE_REPORT: "/test/report"}},
    setTimeout: fn => {timers.push(fn); return timers.length;}, clearTimeout() {},
    fetch: async url => ({status: 200, json: async () => url.endsWith("/api/app") ? {version: "1.1.0"} : {}, text: async () => 'src="playback.js"'}),
    require: name => {
      if (name === "node:fs") return {writeFileSync: (_file, value) => reports.push(JSON.parse(value))};
      if (name === "electron") return {Menu: {getApplicationMenu: () => ({items: [{role: "help", submenu: {items: ["Tagcast Help", "Tagcast Website", "Tagcast on Reddit", "Tagcast on GitHub"].map(label => ({label}))}}]})}};
      throw Error("Unexpected module " + name);
    },
  };
  vm.runInNewContext(readFileSync(require.resolve("../smoke.cjs"), "utf8"), context);
  module.exports.check({app, window, origin: "http://127.0.0.1:12345", backend: {child: {pid: 1}}});
  return {reports, timers, app, contents, quits: () => quits};
}

test("an unloaded renderer has a distinct navigation timeout", () => {
  const h = harness();
  assert.equal(h.reports.at(-1).pending, true);
  h.timers[0]();
  const report = h.reports.at(-1);
  assert.equal(report.ok, false);
  assert.equal(report.error, "Electron check timed out during navigation.");
  assert.equal(report.diagnostics.loaded, false);
  assert.equal(report.pending, undefined);
  assert.equal(h.quits(), 1);
  assert.equal(h.app.listenerCount("child-process-gone"), 0);
});

test("a later stalled check does not misreport that the application failed to load", async () => {
  const h = harness();
  h.contents.emit("did-finish-load");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.reports.at(-1).diagnostics.phase, "renderer-preferences");
  h.timers[0]();
  assert.equal(h.reports.at(-1).error, "Electron check timed out during renderer-preferences.");
  assert.equal(h.reports.at(-1).diagnostics.loaded, true);
});

test("process diagnostics are bounded and do not retain names, URLs or error text", () => {
  const h = harness();
  for (let i = 0; i < 15; i++) h.app.emit("child-process-gone", {}, {reason: "crashed", exitCode: 9, name: "private account", serviceName: "https://secret.example/token"});
  h.timers[0]();
  const report = h.reports.at(-1);
  assert.equal(report.diagnostics.failures.length, 10);
  assert.deepEqual(report.diagnostics.failures[0], {type: "child", reason: "crashed", exitCode: 9});
  assert.doesNotMatch(JSON.stringify(report), /private|secret|token/);
  const count = h.reports.length;
  h.contents.emit("render-process-gone", {}, {reason: "crashed", exitCode: 5});
  h.timers[0]();
  assert.equal(h.reports.length, count, "late events cannot overwrite the final report");
  assert.equal(h.quits(), 1);
});
