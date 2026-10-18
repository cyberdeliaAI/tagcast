"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {mkdtempSync, rmSync} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {Backend, backendCommand, readyMessage} = require("../backend.cjs");
const {applicationUrl, externalUrl, permissionAllowed, contentPolicy} = require("../security.cjs");

const origin = "http://127.0.0.1:8912";

test("only the shared app's own entry pages are navigable", () => {
  for (const url of [origin + "/", origin + "/#/album/73", origin + "/index.html#/tags"]) assert.equal(applicationUrl(url, origin), true);
  for (const url of ["https://127.0.0.1:8912/", "http://127.0.0.1:8913/", "http://127.0.0.1:8912.evil.test/", origin + "/api/status", origin + "/?redirect=x", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello"]) assert.equal(applicationUrl(url, origin), false, url);
});

test("external links are HTTPS only, without credentials or native protocols", () => {
  assert.equal(externalUrl("https://github.com/cyberdeliaAI/tagcast"), "https://github.com/cyberdeliaAI/tagcast");
  assert.equal(externalUrl("https://github.com/cyberdeliaAI/tagcast/wiki"), "https://github.com/cyberdeliaAI/tagcast/wiki");
  for (const value of ["file:///Applications/Calculator.app", "javascript:alert(1)", "http://example.com", "https://user:secret@example.com", "ms-settings:test", "not a URL"]) assert.equal(externalUrl(value), null);
});

test("permissions are scoped to the main app and never grant camera/microphone or capture", () => {
  const contents = {getURL: () => origin + "/#/album/73"};
  for (const permission of ["fullscreen", "speaker-selection", "clipboard-sanitized-write"]) assert.equal(permissionAllowed(contents, permission, origin, {isMainFrame: true}, origin), true);
  for (const permission of ["media", "display-capture", "geolocation", "notifications", "unknown"]) assert.equal(permissionAllowed(contents, permission, origin, {}, origin), false);
  assert.equal(permissionAllowed(contents, "speaker-selection", "https://example.com", {}, origin), false);
  assert.equal(permissionAllowed(contents, "fullscreen", origin, {isMainFrame: false}, origin), false);
  assert.equal(permissionAllowed(null, "fullscreen", origin, {}, origin), false);
});

test("CSP hashes existing theme code without allowing arbitrary inline scripts or eval", () => {
  const policy = contentPolicy('<script>const a = 1;</script><script src="app.js"></script>');
  assert.match(policy, /script-src 'self' 'sha256-/);
  assert.doesNotMatch(policy.match(/script-src[^;]+/)[0], /unsafe-inline|unsafe-eval/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /object-src 'none'; frame-src 'none'/);
  assert.notEqual(policy, contentPolicy('<script>const a = 2;</script>'));
});

test("readiness rejects foreign addresses, versions and malformed ownership", () => {
  const ready = {event: "ready", protocol: 1, version: "0.50.0", url: origin, owned: true};
  assert.equal(readyMessage(ready, "0.50.0").url, origin);
  for (const change of [{url: "https://example.com"}, {url: origin + "/api/status"}, {url: origin + "/?x=y"}, {version: "0.42.0"}, {protocol: 2}, {owned: "true"}]) assert.throws(() => readyMessage({...ready, ...change}, "0.50.0"));
});

test("source and packaged launches use the same backend module without a shell", () => {
  const root = path.resolve(__dirname, "../..");
  assert.deepEqual(backendCommand({packaged: false, sourceRoot: root, python: "/test/python"}), {file: "/test/python", args: ["-m", "tagcast.electron_host"]});
  const bundled = backendCommand({packaged: true, resourcesPath: "/resources"});
  assert.match(bundled.file, /backend[/\\]tagcast-server/);
  assert.deepEqual(bundled.args, []);
});

test("the real child serves the existing interface and exits on a graceful stop", async () => {
  const root = path.resolve(__dirname, "../..");
  const home = mkdtempSync(path.join(os.tmpdir(), "tagcast-electron-node-"));
  const command = backendCommand({packaged: false, sourceRoot: root, python: process.env.TAGCAST_PYTHON});
  const version = require("../package.json").version.replace(/-beta\.(\d+)$/, "b$1");
  const backend = new Backend(command, {version, sourceRoot: root, env: {...process.env, TAGCAST_HOME: home, TAGCAST_PORT: "0"}});
  try {
    const ready = await backend.start();
    assert.equal(ready.owned, true);
    const response = await fetch(ready.url + "/api/app");
    assert.equal((await response.json()).application, "Tagcast");
    const page = await (await fetch(ready.url)).text();
    assert.match(page, /src="album.js"/);
    assert.match(page, /src="playback.js"/);
    await backend.stop();
    await assert.rejects(fetch(ready.url + "/api/app"));
  } finally { await backend.stop(); rmSync(home, {recursive: true, force: true}); }
});

test("a missing interpreter fails promptly and can be stopped safely", async () => {
  const backend = new Backend({file: path.join(os.tmpdir(), "missing-tagcast-python"), args: []}, {version: "0.50.0", timeout: 1000});
  await assert.rejects(backend.start(), /Could not start/);
  await backend.stop();
});
