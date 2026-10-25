"use strict";

const {writeFileSync} = require("node:fs");
const {Menu} = require("electron");

// Build checks opt in from the command line with isolated settings and profile folders.
// Native presentation checks use the disconnected demo only; no live account or writes.
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
      const help = Menu.getApplicationMenu().items.find(item => item.role === "help");
      const helpLabels = help?.submenu.items.map(item => item.label);
      if (JSON.stringify(helpLabels) !== JSON.stringify(["Tagcast Help", "Tagcast on Reddit", "Tagcast on GitHub"])) throw new Error("Help links are missing.");
      const settings = await (await fetch(origin + "/api/settings")).json();
      const writeStatus = (await fetch(origin + "/api/save", {method: "POST", headers: {"X-Tagcast": "1"}, body: "{}"})).status;
      const recordingStatus = (await fetch(origin + "/api/settings", {method: "POST", headers: {"X-Tagcast": "1"}, body: JSON.stringify({record_plays: true})})).status;
      if (!status.playback_validation || !settings.playback_validation || settings.record_plays || settings.queue_sync
          || writeStatus !== 403 || recordingStatus !== 400) throw new Error("The listening build's read-only protections failed.");
      const diagnostics = await window.webContents.executeJavaScript(`(async () => {
        await loadSettings(); openSettings('playback');
        const originalAudio = audio, originalPrepare = gaplessPrepare;
        const defaultGapless = gaplessTrial.enabled, defaultDiagnostics = gaplessDiagnostics.enabled;
        const disabledControls = ['record_plays','queue_sync'].every(name => document.querySelector('[name="'+name+'"]').disabled);
        const diagnosticChoice = document.querySelector('#gapless-diagnostics-enabled');
        diagnosticChoice.click(); gaplessDiagnosticEvent('prepare-start', {slot:1, title:'PRIVATE', url:'SECRET'});
        diagnosticChoice.click();
        const report = gaplessDiagnosticsReport();
        return {defaultGapless, defaultDiagnostics, disabledControls, sameAudio: audio === originalAudio,
          restored: gaplessPrepare === originalPrepare, events: report.events.length,
          private: /PRIVATE|SECRET/.test(JSON.stringify(report)), panel: Boolean(document.querySelector('#gapless-diagnostics-enabled'))};
      })()`);
      if (diagnostics.defaultGapless || diagnostics.defaultDiagnostics || !diagnostics.disabledControls || !diagnostics.sameAudio
          || !diagnostics.restored || diagnostics.events < 3 || diagnostics.private || !diagnostics.panel) throw new Error("Optional diagnostics or listening defaults failed.");
      if (process.env.TAGCAST_ELECTRON_VALIDATION_SCREENSHOT) {
        const settle = `(() => { const details = document.querySelector('#gapless-diagnostics-enabled').closest('details'); details.open = true; details.closest('section').scrollIntoView({block:'start'}); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()`;
        await window.webContents.executeJavaScript(settle);
        writeFileSync(process.env.TAGCAST_ELECTRON_VALIDATION_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
        window.setContentSize(420, 800);
        await window.webContents.executeJavaScript(settle);
        diagnostics.narrowOverflow = await window.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth');
        writeFileSync(process.env.TAGCAST_ELECTRON_VALIDATION_SCREENSHOT.replace(/\.png$/, '-narrow.png'), (await window.webContents.capturePage()).toPNG());
        window.setContentSize(1420, 960);
        if (diagnostics.narrowOverflow) throw new Error("The diagnostics section overflows the narrow window.");
      }
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
      if (presentation.defaultMode !== "fullscreen" || presentation.mode !== "window" || presentation.stored !== "window"
          || !presentation.open || presentation.native || !presentation.sameAudio || presentation.queue !== 1 || window.isFullScreen()) throw new Error("In-window Now playing failed.");
      if (process.env.TAGCAST_ELECTRON_SMOKE_SCREENSHOT) {
        await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        writeFileSync(process.env.TAGCAST_ELECTRON_SMOKE_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
      }
      await window.webContents.executeJavaScript('closeVisualPlayer(); state.mode = "demo"; player.queue = []; player.index = -1;');
      if (errors.length) throw new Error("The renderer reported a runtime or CSP error: " + errors.join("; "));
      done({ok: true, version: identity.version, electron: process.versions.electron,
        chromium: process.versions.chrome, origin, pid: backend.child.pid, sandbox: true,
        contextIsolation: true, nodeIntegration: false, sharedInterface: true, helpLabels, presentation, diagnostics, validation: {writeStatus, recordingStatus, ownProfile: app.getPath("userData") === process.env.TAGCAST_ELECTRON_PROFILE}});
    } catch (error) { done({ok: false, error: error.message}); }
  });
}

module.exports = {check};
