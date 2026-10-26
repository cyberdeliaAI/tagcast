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
