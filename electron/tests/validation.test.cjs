"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {validationOptions} = require("../validation.cjs");
const home = path.resolve("test-home"), appData = path.join(home, "app-data"), temporary = path.resolve("temporary");
test("listening build always separates credentials/profile and asks for a fresh server port", () => {
  const result = validationOptions({home, appData, temporary, env: {TAGCAST_HOME: path.join(home, ".tagcast"), TAGCAST_ELECTRON_PROFILE: appData, TAGCAST_PORT: "8912", TAGCAST_DEBUG: "1"}});
  assert.equal(result.settings, path.join(home, ".tagcast-gapless-validation"));
  assert.equal(result.profile, path.join(appData, "Tagcast Gapless Validation"));
  assert.equal(result.env.TAGCAST_PLAYBACK_VALIDATION, "1");
  assert.equal(result.env.TAGCAST_PORT, "0"); assert.equal(result.env.TAGCAST_DEBUG, "");
});
test("packaged checks can use explicitly temporary profiles, never a normal home override", () => {
  const env = {TAGCAST_ELECTRON_SMOKE_REPORT: path.join(temporary, "report.json"), TAGCAST_HOME: path.join(temporary, "settings"), TAGCAST_ELECTRON_PROFILE: path.join(temporary, "profile")};
  const result = validationOptions({home, appData, temporary, env});
  assert.equal(result.settings, env.TAGCAST_HOME); assert.equal(result.profile, env.TAGCAST_ELECTRON_PROFILE);
  const normal = validationOptions({home, appData, temporary, env: {...env, TAGCAST_HOME: path.join(home, ".tagcast")}});
  assert.equal(normal.settings, path.join(home, ".tagcast-gapless-validation"));
});
test("two validation servers run concurrently on distinct owned loopback ports", async () => {
  const {mkdtempSync, rmSync, mkdirSync} = require("node:fs"), os = require("node:os");
  const {Backend, backendCommand} = require("../backend.cjs");
  const temporaryHome = mkdtempSync(path.join(os.tmpdir(), "tagcast-validation-servers-"));
  const root = path.resolve(__dirname, "../.."), version = require("../package.json").version;
  const servers = [0, 1].map(index => {
    const home = path.join(temporaryHome, String(index)); mkdirSync(home);
    const options = validationOptions({home, appData: home, env: process.env});
    return new Backend(backendCommand({packaged:false,sourceRoot:root,python:process.env.TAGCAST_PYTHON}), {version, sourceRoot:root, env:options.env});
  });
  try {
    const [a,b] = await Promise.all(servers.map(server => server.start()));
    assert.notEqual(a.url,b.url); assert.ok(a.owned && b.owned);
    for (const ready of [a,b]) {
      assert.equal((await (await fetch(ready.url + "/api/status")).json()).playback_validation, true);
      assert.equal((await fetch(ready.url + "/api/save", {method:"POST",headers:{"X-Tagcast":"1"},body:"{}"})).status,403);
    }
  } finally { await Promise.all(servers.map(server => server.stop())); rmSync(temporaryHome, {recursive:true,force:true}); }
});
