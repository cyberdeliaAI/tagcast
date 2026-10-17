"use strict";

const {writeFileSync} = require("node:fs");

// Build checks opt in from the command line with isolated settings and profile folders.
// No renderer API, browser automation, live account or automatic iBroadcast write.
function check({app, window, origin, backend}) {
  const report = process.env.TAGCAST_ELECTRON_SMOKE_REPORT;
  if (!process.env.TAGCAST_HOME || !process.env.TAGCAST_ELECTRON_PROFILE) throw new Error("Smoke checks require isolated settings and profile folders.");
  const errors = [];
  window.webContents.on("console-message", (_event, ...args) => {
    const details = typeof args[0] === "object" ? args[0] : {level: args[0], message: args[1]};
    if (details.level === "error" || details.level === 3) errors.push(details.message);
  });
  const timer = setTimeout(() => done({ok: false, error: "The application window did not load."}), 20000);
  let completed = false;
  function done(result) {
    if (completed) return;
    completed = true; clearTimeout(timer);
    writeFileSync(report, JSON.stringify(result, null, 2));
    window.close();
    app.quit();
  }
  window.webContents.once("did-finish-load", async () => {
    try {
      const response = await fetch(origin + "/api/app");
      const identity = await response.json();
      const status = await (await fetch(origin + "/api/status")).json();
      const page = await (await fetch(origin)).text();
      const preferences = window.webContents.getLastWebPreferences();
      if (status.connected || !identity.version || !page.includes('src="playback.js"')) throw new Error("The shared interface or isolated server is invalid.");
      if (!preferences.sandbox || !preferences.contextIsolation || preferences.nodeIntegration || !preferences.webSecurity) throw new Error("The renderer's security settings are invalid.");
      if (errors.length) throw new Error("The renderer reported a runtime or CSP error: " + errors.join("; "));
      done({ok: true, version: identity.version, electron: process.versions.electron,
        chromium: process.versions.chrome, origin, pid: backend.child.pid, sandbox: true,
        contextIsolation: true, nodeIntegration: false, sharedInterface: true});
    } catch (error) { done({ok: false, error: error.message}); }
  });
}

module.exports = {check};
