"use strict";

const {writeFileSync} = require("node:fs");

// Keep each complete viewport matrix independent of earlier smoke-suite runtime/state.
// The existing matrix functions, real pointer assertions and 45s deadline are unchanged.
function check({app, window, origin}) {
  const report = process.env.TAGCAST_WORKSPACE_SMOKE_REPORT;
  const kind = process.env.TAGCAST_WORKSPACE_SMOKE_CASE;
  if (!process.env.TAGCAST_HOME || !process.env.TAGCAST_ELECTRON_PROFILE
      || !["workspace", "setup"].includes(kind)) throw Error("Workspace checks require isolated settings/profile and a known case");
  const started = performance.now(), errors = [];
  let completed = false, phase = "startup";
  const finish = result => {
    if (completed) return;
    completed = true;
    clearTimeout(timer);
    writeFileSync(report, JSON.stringify({...result, kind, phase, elapsed_ms: Math.round(performance.now() - started)}, null, 2));
    window.close(); app.quit();
  };
  const timer = setTimeout(() => finish({ok: false, error: "Workspace check timed out"}), 45000);
  window.webContents.on("console-message", (_event, ...args) => {
    const details = typeof args[0] === "object" ? args[0] : {level: args[0], message: args[1]};
    if ((details.level === "error" || details.level === 3) && errors.length < 10) errors.push(details.message);
  });
  window.webContents.once("did-finish-load", async () => {
    try {
      const run = code => window.webContents.executeJavaScript(code);
      const until = Date.now() + 10000;
      while (!await run("state.mode==='demo'&&!state.loading&&state.albums.length>0&&firstSetup.initialized&&firstSetup.statusReady")) {
        if (Date.now() > until) throw Error("Isolated demo did not become ready");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const identity = await (await fetch(origin + "/api/app")).json();
      const status = await (await fetch(origin + "/api/status")).json();
      if (status.connected || !identity.version) throw Error("Workspace check requires a disconnected production server");
      phase = kind;
      const samples = kind === "workspace"
        ? await require("./workspace-smoke.cjs").checkWorkspace(window)
        : await require("./setup-smoke.cjs").checkSetup(window);
      if (errors.length) throw Error("Renderer runtime or CSP error: " + errors.join("; "));
      finish({ok: true, version: identity.version, origin, samples});
    } catch (error) { finish({ok: false, error: error.message}); }
  });
}

module.exports = {check};
