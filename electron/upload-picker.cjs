"use strict";

const {applicationUrl} = require("./security.cjs");

// Native file selection only. No renderer-supplied dialog options or file reads.
function installUploadPicker(owner, origin, deps = require("electron")) {
  const {ipcMain, dialog} = deps, contents = owner.webContents;
  let busy = false, generation = 0;
  const allowed = event => !contents.isDestroyed() && event.sender === contents
    && event.senderFrame === contents.mainFrame && applicationUrl(contents.getURL(), origin);
  ipcMain.handle("uploads:choose", async (event, kind) => {
    if (!allowed(event) || busy || !["files", "folder"].includes(kind)) return {error: "File selection is not available."};
    const captured = generation;
    busy = true;
    try {
      const result = await dialog.showOpenDialog(owner, {
        title: kind === "folder" ? "Choose music folder" : "Choose music files",
        properties: kind === "folder" ? ["openDirectory"] : ["openFile", "multiSelections"],
        ...(kind === "files" ? {filters: [{name: "Audio files", extensions: ["flac", "mp3", "m4a", "ogg", "opus", "wav", "wma", "aiff", "aif", "ape"]}, {name: "All files", extensions: ["*"]}]} : {}),
      });
      if (captured !== generation || !allowed(event)) return {paths: []};
      if (result.canceled) return {paths: []};
      const paths = result.filePaths;
      if (!Array.isArray(paths) || paths.length > 100 || paths.some(p => typeof p !== "string" || p.length > 4096 || /[\r\n\0]/.test(p))) return {error: "Choose at most 100 paths without line breaks."};
      return {paths};
    } catch { return {error: "The file chooser could not open. Enter complete paths instead."}; }
    finally { busy = false; }
  });
  contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) generation++; });
  owner.once("closed", () => { generation++; ipcMain.removeHandler("uploads:choose"); });
}

module.exports = {installUploadPicker};
