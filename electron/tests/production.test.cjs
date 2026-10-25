"use strict";
const {test} = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
test("the normal app keeps its existing identity, stable port and profile behaviour", () => {
  const main=fs.readFileSync(path.join(__dirname,"../main.cjs"),"utf8"), pkg=require("../package.json");
  assert.equal(pkg.productName,"Tagcast"); assert.equal(pkg.build.appId,"nl.cyberdelia.tagcast");
  assert.doesNotMatch(main,/validationOptions|TAGCAST_PLAYBACK_VALIDATION|TAGCAST_PORT:\s*["']0/);
  assert.match(main,/TAGCAST_ELECTRON_PROFILE/);
});
