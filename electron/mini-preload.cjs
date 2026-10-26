"use strict";
const {contextBridge, ipcRenderer} = require("electron");
contextBridge.exposeInMainWorld("tagcastMini", {
  command: value => ipcRenderer.invoke("mini:command", value),
  openMain: () => ipcRenderer.send("mini:main"),
  pin: value => ipcRenderer.invoke("mini:pin", value),
  ready: () => ipcRenderer.send("mini:ready"),
  onState: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("mini:state", listener);
    return () => ipcRenderer.removeListener("mini:state", listener);
  }
});
