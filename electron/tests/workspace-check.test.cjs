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

test("workspace pointer targeting measures after scroll/resize layout instead of clicking old player coordinates", async () => {
  let y = 700, pendingY = null;
  const clicks = [], module = {exports: {}}, before = {tab:"playlist",screen:"albums",sort:"artist",filter:"all",collapsed:false,queueSync:false};
  const contents = {
    executeJavaScript(code) {
      if (code.includes("workspaceSmokeAudio=audio")) return Promise.resolve(before);
      if (code === "state.mode") return Promise.resolve("demo");
      if (code.includes("lastElementChild") || code.includes("contains($('#devices-button'))")) return Promise.resolve(true);
      if (code.includes("scrollIntoView")) {
        // Scrolling an element within a sticky toolbar settles on the next frame.
        pendingY = 200;
        return Promise.resolve({x:60,y:y+22});
      }
      if (code.includes("requestAnimationFrame")) {
        if (pendingY !== null) {y=pendingY;pendingY=null;}
        return Promise.resolve();
      }
      if (code.includes("elementFromPoint")) {
        const point = code.match(/elementFromPoint\((\d+),(\d+)\)/);
        return Promise.resolve({ok:Number(point[2])===y+22,hit:"player-track"});
      }
      if (code.includes("getBoundingClientRect")) return Promise.resolve({x:60,y:y+22});
      return Promise.resolve();
    },
    sendInputEvent(event) {
      if (event.type === "mouseDown") clicks.push(event);
      if (event.type === "mouseUp") throw Error("test stopped after pointer");
    },
  };
  vm.runInNewContext(readFileSync(require.resolve("../workspace-smoke.cjs"), "utf8"), {
    module, require: name => {if(name==="node:assert/strict")return assert;throw Error(name);},
  });
  const window = {webContents:contents,getBounds:()=>({width:1280,height:900}),setBounds(){},setContentSize(){}};
  await assert.rejects(module.exports.checkWorkspace(window), /test stopped after pointer/);
  assert.equal(clicks.length,1);
  assert.equal(clicks[0].y,222,"The real input uses the final control position, never the old footer coordinate");
});
