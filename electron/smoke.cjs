"use strict";

const {writeFileSync} = require("node:fs");
const {Menu} = require("electron");

// Build checks opt in from the command line with isolated settings and profile folders.
// Native presentation checks use the disconnected demo only; no live account or writes.
function check({app, window, origin, backend, miniPlayer}) {
  const report = process.env.TAGCAST_ELECTRON_SMOKE_REPORT;
  if (!process.env.TAGCAST_HOME || !process.env.TAGCAST_ELECTRON_PROFILE) throw new Error("Smoke checks require isolated settings and profile folders.");
  const errors = [];
  window.webContents.on("console-message", (_event, ...args) => {
    const details = typeof args[0] === "object" ? args[0] : {level: args[0], message: args[1]};
    if (details.level === "error" || details.level === 3) errors.push(details.message);
  });
  const timer = setTimeout(() => done({ok: false, error: "The application window did not load."}), process.env.TAGCAST_MINI_VISUAL_PREVIEW ? 600000 : 45000);
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
      const help = Menu.getApplicationMenu().items.find(item => item.role === "help");
      const helpLabels = help?.submenu.items.map(item => item.label);
      if (JSON.stringify(helpLabels) !== JSON.stringify(["Tagcast Help", "Tagcast Website", "Tagcast on Reddit", "Tagcast on GitHub"])) throw new Error("Help links are missing.");
      const restart = process.env.TAGCAST_ELECTRON_SMOKE_PHASE === "restart";
      const beforeSettings = await (await fetch(origin + "/api/settings")).json();
      if ("playback_validation" in status || "playback_validation" in beforeSettings) throw new Error("Isolated listening policy leaked into the production app.");
      if (restart && (beforeSettings.stream_quality !== "orig" || !beforeSettings.record_plays || !beforeSettings.queue_sync)) throw new Error("Saved server preferences were lost on restart.");
      const saved = await fetch(origin + "/api/settings", {method:"POST", headers:{"X-Tagcast":"1"}, body:JSON.stringify({stream_quality:"orig",record_plays:true,queue_sync:true})});
      if (saved.status !== 200) throw new Error("Production playback preferences are restricted.");
      const persistence = await window.webContents.executeJavaScript(`(async () => {
        await loadSettings(); openSettings('playback');
        const before = {gapless:gaplessTrial.enabled,quality:playerDisplay.quality,view:visualPlayerMode,theme:document.documentElement.dataset.theme,palette:document.documentElement.dataset.palette};
        if (${restart}) {
          const expected=${process.env.TAGCAST_ELECTRON_RESTART_EXPECTED || 'null'};
          if (JSON.stringify(before)!==JSON.stringify(expected)) throw Error('Browser preferences were lost on restart');
        } else {
          if(gaplessTrial.enabled||gaplessDiagnostics.enabled)throw Error('Experimental controls must default off');
          const gapless=document.querySelector('#gapless-test-enabled');if(!gapless.disabled)gapless.click();
          document.querySelector('[data-player-display="quality"]').click();
          for(const selector of ['[data-appearance-choice][value="light"]','[data-palette-choice][value="warm"]']){
            const input=document.querySelector(selector);input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));
          }
        }
        if(gaplessDiagnostics.enabled)throw Error('Diagnostics must not restart automatically');
        return {before,supported:gaplessSupported(),after:{gapless:gaplessTrial.enabled,quality:playerDisplay.quality,view:'window',theme:document.documentElement.dataset.theme,palette:document.documentElement.dataset.palette}};
      })()`);
      const presentation = await window.webContents.executeJavaScript(`(() => {
        openSettings();
        const choice = document.querySelector('#player-view-mode');
        const defaultMode = choice.value;
        choice.value = 'window'; choice.dispatchEvent(new Event('change', {bubbles:true}));
        closeSettings();
        const album = state.details.values().next().value;
        player.queue = [{...album.tracks[0], album}]; player.index = 0; state.mode = 'live';
        document.querySelector('#player').hidden = false;
        document.querySelector('#player-fullscreen').focus();
        const originalAudio = document.querySelector('#audio');
        openVisualPlayer();
        const result = {defaultMode, mode:visualPlayerMode, stored:localStorage.getItem('tagcast-player-view'),
          open:visualPlayer.open, native:Boolean(document.fullscreenElement),
          sameAudio:originalAudio === document.querySelector('#audio'), queue:player.queue.length};
        return result;
      })()`);
      if (presentation.defaultMode !== (restart ? "window" : "fullscreen") || presentation.mode !== "window" || presentation.stored !== "window"
          || !presentation.open || presentation.native || !presentation.sameAudio || presentation.queue !== 1 || window.isFullScreen()) throw new Error("In-window Now playing failed.");
      if (process.env.TAGCAST_ELECTRON_SMOKE_SCREENSHOT) {
        await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        writeFileSync(process.env.TAGCAST_ELECTRON_SMOKE_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
      }
      const mini = await require("./mini-smoke.cjs").checkMini({window, miniPlayer});
      await window.webContents.executeJavaScript('closeVisualPlayer(); state.mode = "demo"; player.queue = []; player.index = -1;');
      if (errors.length) throw new Error("The renderer reported a runtime or CSP error: " + errors.join("; "));
      done({ok: true, version: identity.version, electron: process.versions.electron,
        chromium: process.versions.chrome, origin, pid: backend.child.pid, sandbox: true,
        contextIsolation: true, nodeIntegration: false, sharedInterface: true, helpLabels, presentation, persistence, mini, normalSettingsAllowed: true, restarted: restart});
    } catch (error) { done({ok: false, error: error.message}); }
  });
}

module.exports = {check};
