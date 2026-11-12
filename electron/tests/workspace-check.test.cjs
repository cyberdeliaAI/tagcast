"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const {readFileSync} = require("node:fs");
const vm = require("node:vm");

function harness(kind = "workspace", isolated = true) {
  const reports = [], timers = [], app = {quit() {}}, contents = new EventEmitter();
  const module = {exports: {}};
  const env = {TAGCAST_WORKSPACE_SMOKE_CASE: kind, TAGCAST_WORKSPACE_SMOKE_REPORT: "/report"};
  if (isolated) Object.assign(env, {TAGCAST_HOME: "/settings", TAGCAST_ELECTRON_PROFILE: "/profile"});
  vm.runInNewContext(readFileSync(require.resolve("../workspace-check.cjs"), "utf8"), {
    module, process: {env}, performance: {now: () => 100},
    setTimeout(fn, ms) {timers.push({fn, ms}); return 1;}, clearTimeout() {},
    require(name) {if (name === "node:fs") return {writeFileSync: (_path, data) => reports.push(JSON.parse(data))}; throw Error(name);},
  });
  return {start: () => module.exports.check({app, window: {webContents: contents, close() {}}, origin: "http://127.0.0.1"}), reports, timers};
}

test("a stalled native UI matrix fails at the unchanged 45s deadline and cannot overwrite its result", () => {
  for (const kind of ["workspace", "setup"]) {
    const h = harness(kind); h.start();
    assert.equal(h.timers[0].ms, 45000);
    h.timers[0].fn(); h.timers[0].fn();
    assert.equal(h.reports.length, 1);
    assert.equal(h.reports[0].ok, false);
    assert.equal(h.reports[0].kind, kind);
    assert.equal(h.reports[0].phase, "startup");
  }
});

test("unknown matrices or nonisolated profiles cannot activate the native test route", () => {
  for (const h of [harness("unknown"), harness("setup", false)]) {
    assert.throws(h.start, /isolated settings/);
    assert.equal(h.timers.length, 0);
  }
});
