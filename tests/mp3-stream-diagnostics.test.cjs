"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function page() {
  const mediaEvents = {}, documentEvents = {}, requests = [], downloads = [];
  const noRanges = {length: 0};
  const audio = {
    src: "", currentSrc: "", duration: NaN, currentTime: 0, readyState: 0, networkState: 2,
    seeking: false, paused: false, error: null, seekable: noRanges, buffered: noRanges,
    addEventListener(name, callback) { mediaEvents[name] = [...(mediaEvents[name] ?? []), callback]; },
  };
  const button = {disabled: true};
  let seq = 0;
  const context = vm.createContext({
    audio, player: {}, state: {connection: {playback_session: "private-session"}},
    document: {
      addEventListener(name, callback) { documentEvents[name] = callback; },
      createElement() { return {click() { downloads.push(context.lastBlob); }}; },
    },
    window: {addEventListener() {}},
    $: selector => selector === "#mp3-diagnostics-download" ? button : null,
    TagcastI18n: {html: key => key}, performance: {now: () => 0},
    navigator: {userAgent: "Chrome/160.0.0.0 Electron/44.11.0"},
    crypto: {randomUUID: () => `synthetic-playback-attempt-${++seq}`},
    URL: {createObjectURL(blob) { context.lastBlob = blob; return "blob:test"; }, revokeObjectURL() {}},
    URLSearchParams, AbortSignal, Blob, setTimeout() {},
    fetch(url) {
      requests.push(url);
      return Promise.resolve({ok: true, json: async () => ({
        state: "available", first_response: {status: 200, content_length: null},
      })});
    },
  });
  const run = source => vm.runInContext(source, context);
  for (const file of ["playback-recovery.js", "mp3-stream-diagnostics.js"]) {
    run(readFileSync(path.join(__dirname, "../src/tagcast/static", file), "utf8"));
  }
  function start(quality = "192") {
    const url = run(`normalStreamUrl({id: "private-track", length: 289}, ${JSON.stringify(quality)})`);
    audio.currentSrc = audio.src = "http://127.0.0.1:8912" + url;
    return url;
  }
  return {audio, button, requests, downloads, context, start, run,
    enable(checked) { documentEvents.change({target: {id: "mp3-diagnostics-enabled", checked}}); },
    emit(name) { for (const callback of mediaEvents[name] ?? []) callback(); },
    async report() { await run("downloadMp3StreamDiagnostics()"); return JSON.parse(await downloads.at(-1).text()); }};
}

test("MP3 diagnostics are off on launch, opt in for new MP3 attempts, and use the existing status route", async () => {
  const p = page();
  assert.doesNotMatch(p.start(), /diagnostic/);
  p.emit("loadedmetadata");
  assert.deepEqual(p.requests, []);
  p.enable(true);
  assert.doesNotMatch(p.start("orig"), /diagnostic/);
  p.emit("loadedmetadata");
  assert.deepEqual(p.requests, []);

  const url = p.start();
  const params = new URL(url, "http://localhost").searchParams;
  assert.equal(params.get("diagnostic"), "1");
  p.emit("waiting");
  assert.equal(p.button.disabled, false);
  assert.deepEqual(p.requests, []);
  p.audio.readyState = 1;
  p.audio.duration = Infinity;
  p.emit("durationchange");
  p.audio.currentTime = 29;
  p.emit("timeupdate");
  p.emit("timeupdate");
  p.audio.duration = 288.261208;
  p.emit("durationchange");
  assert.equal(p.button.disabled, false);
  assert.equal(p.requests.length, 1);
  assert.equal(new URL(p.requests[0], "http://localhost").searchParams.get("request"), params.get("request"));
  const report = await p.report();
  const [attempt] = report.attempts;
  assert.equal(attempt.quality_kbps, 192);
  assert.equal(attempt.library_duration_s, 289);
  assert.deepEqual(attempt.first_http_response, {status: 200, content_length: null});
  assert.equal(attempt.problem.position_s, 29);
  assert.deepEqual(attempt.events.map(event => event.duration_s), ["NaN", "Infinity", "Infinity", 288.261]);
  assert.doesNotMatch(JSON.stringify(report), /private-session|private-track|synthetic-playback-attempt|127\.0\.0\.1/);
});

test("recent observations stay bounded and a later working track cannot replace the last bad start", async () => {
  const p = page();
  p.enable(true);
  p.start();
  p.audio.duration = Infinity;
  p.audio.currentTime = 19;
  p.emit("timeupdate");
  for (let i = 0; i < 10; i++) {
    p.start();
    p.audio.duration = 5;
    p.emit("playing");
  }
  for (let i = 0; i < 40; i++) p.emit("waiting");
  p.enable(false);
  const report = await p.report();
  assert.equal(report.attempts.length, 9);
  assert.equal(report.attempts[0].problem.duration_s, "Infinity");
  assert.equal(report.attempts.at(-1).events.length, 24);
  assert.equal(report.attempts.at(-1).events[0].event, "playing");
});

test("a stale source cannot write observations and a session change during export discards the report", async () => {
  const p = page();
  p.enable(true);
  p.start();
  p.audio.currentSrc = "http://127.0.0.1:8912/previous-attempt";
  p.emit("loadedmetadata");
  assert.equal(p.button.disabled, true);
  assert.deepEqual(p.requests, []);
  p.audio.currentSrc = p.audio.src;
  p.audio.readyState = 1;
  let finish;
  p.context.fetch = () => new Promise(resolve => { finish = resolve; });
  p.emit("loadedmetadata");
  const pending = p.run("downloadMp3StreamDiagnostics()");
  p.context.state.connection.playback_session = "replacement";
  finish({ok: true, json: async () => ({state: "available", first_response: {status: 200}})});
  await pending;
  assert.deepEqual(p.downloads, []);
  p.emit("emptied");
  assert.equal(p.button.disabled, true);
});
