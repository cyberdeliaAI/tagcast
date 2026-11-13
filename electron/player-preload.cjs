"use strict";
const {contextBridge, ipcRenderer} = require("electron");
const listen = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld("tagcastMiniOwner", {
  open: () => ipcRenderer.send("mini:open"),
  ready: () => ipcRenderer.send("mini:owner-ready"),
  publish: value => ipcRenderer.send("mini:publish", value),
  respond: value => ipcRenderer.send("mini:result", value),
  onActive: callback => listen("mini:active", callback),
  onCommand: callback => listen("mini:request", callback)
});

// No URL, token or general-purpose IPC access is exposed to the renderer.
contextBridge.exposeInMainWorld("tagcastSignIn", {
  open: requestId => ipcRenderer.invoke("signin:open", requestId),
  close: requestId => ipcRenderer.send("signin:close", requestId),
  onClosed: callback => listen("signin:closed", callback)
});

// Menus, window titles and native dialogs follow the interface language: plain texts for fixed names only.
contextBridge.exposeInMainWorld("tagcastDesktop", {
  setInterface: value => ipcRenderer.send("desktop:interface", value)
});

// Presentation only, even when Mini Player is closed. Report resolved CSS colours,
// never browser storage, account data or an executable stylesheet.
window.addEventListener("DOMContentLoaded", () => {
  let previous = "";
  const system = matchMedia("(prefers-color-scheme: dark)");
  const publish = () => {
    const root = document.documentElement, style = getComputedStyle(root);
    const colour = name => style.getPropertyValue(name).trim();
    const value = {theme: root.dataset.theme === "dark" || (!root.dataset.theme && system.matches) ? "dark" : "light", colours: {
      paper: colour("--paper"), ink: colour("--ink"), muted: colour("--muted"),
      surface: colour("--white"), line: colour("--line"),
      focus: colour("--palette-focus") || colour("--green"),
      tint: colour("--palette-tint") || colour("--white")
    }};
    const next = JSON.stringify(value);
    if (next !== previous) { previous = next; ipcRenderer.send("desktop:appearance", value); }
  };
  new MutationObserver(publish).observe(document.documentElement,
    {attributes: true, attributeFilter: ["data-theme", "data-palette", "style"]});
  document.addEventListener("tagcast-theme-change", publish);
  system.addEventListener("change", publish);
  publish();
});

contextBridge.exposeInMainWorld("tagcastUploads", {
  choose: kind => ipcRenderer.invoke("uploads:choose", kind)
});

// Fixed updater actions only. No URL, local path or installer command crosses IPC.
contextBridge.exposeInMainWorld("tagcastUpdates", {
  status: () => ipcRenderer.invoke("updates:status"),
  offer: (version, automatic) => ipcRenderer.invoke("updates:offer", {version, automatic}),
  download: version => ipcRenderer.invoke("updates:download", version),
  install: version => ipcRenderer.invoke("updates:install", version),
  skip: version => ipcRenderer.invoke("updates:skip", version),
  configure: autoDownload => ipcRenderer.invoke("updates:configure", autoDownload),
  onStatus: callback => listen("updates:status", callback)
});
