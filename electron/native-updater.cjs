"use strict";

// Pinned adapter: our immutable full-release feeds do not use staged rollouts.
// Do not create or transmit electron-updater's per-installation staging UUID.
function secureUpdateSession(session) {
  session.webRequest.onBeforeRequest((details, callback) => {
    try { callback({cancel: new URL(details.url).protocol !== "https:"}); }
    catch { callback({cancel: true}); }
  });
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = {...details.requestHeaders};
    for (const key of Object.keys(headers)) if (["cookie", "authorization", "proxy-authorization", "x-user-staging-id"].includes(key.toLowerCase())) delete headers[key];
    callback({requestHeaders: headers});
  });
}

function createNativeUpdater(platform, app) {
  const native = require("electron-updater");
  const Updater = platform === "darwin" ? native.MacUpdater : platform === "win32" ? native.NsisUpdater : native.DebUpdater;
  class PrivateUpdater extends Updater {
    async getOrCreateStagingUserId() { return "00000000-0000-4000-8000-000000000000"; }
    computeFinalHeaders(headers) {
      const result = super.computeFinalHeaders({...headers});
      for (const key of Object.keys(result)) if (key.toLowerCase() === "x-user-staging-id") delete result[key];
      return result;
    }
  }
  const updater = new PrivateUpdater(undefined, app);
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.isUserWithinRollout = () => true;
  updater.disableWebInstaller = true;
  updater.disableDifferentialDownload = true;
  if (app === undefined) secureUpdateSession(updater.netSession);
  return updater;
}
module.exports = {createNativeUpdater, secureUpdateSession};
