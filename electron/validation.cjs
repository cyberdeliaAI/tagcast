"use strict";

const path = require("node:path");
const os = require("node:os");

// This branch's listening build never inherits the normal app's profile or credentials.
function validationOptions({home, appData, env, temporary = os.tmpdir()}) {
  const insideTemporary = value => value && path.resolve(value).startsWith(path.resolve(temporary) + path.sep);
  const check = Boolean(env.TAGCAST_ELECTRON_SMOKE_REPORT && insideTemporary(env.TAGCAST_HOME)
    && insideTemporary(env.TAGCAST_ELECTRON_PROFILE));
  const profile = check ? path.resolve(env.TAGCAST_ELECTRON_PROFILE) : path.join(appData, "Tagcast Gapless Validation");
  const settings = check ? path.resolve(env.TAGCAST_HOME) : path.join(home, ".tagcast-gapless-validation");
  return {profile, settings, env: {...env, TAGCAST_HOME: settings, TAGCAST_PORT: "0",
    TAGCAST_PLAYBACK_VALIDATION: "1", TAGCAST_DEBUG: ""}};
}

module.exports = {validationOptions};
