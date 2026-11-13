"use strict";

const fs = require("node:fs");

// Desktop texts for menus, window titles and native dialogs. Each name mirrors the key
// `desktop.<name>` in src/tagcast/static/i18n/en.json (a test keeps them identical). The main
// window sends its active language and these texts after every language change; they are kept in
// userData/interface.json so menus and startup dialogs use the same language from the next start.
// English always uses these built-in texts, and English menus keep Electron's own role labels.
const ENGLISH = Object.freeze({
  "menu.file": "File",
  "menu.edit": "Edit",
  "menu.view": "View",
  "menu.window": "Window",
  "menu.help": "Help",
  "menu.about": "About Tagcast",
  "menu.hide": "Hide Tagcast",
  "menu.hideOthers": "Hide Others",
  "menu.showAll": "Show All",
  "menu.quitApp": "Quit Tagcast",
  "menu.exit": "Exit",
  "menu.quit": "Quit",
  "menu.undo": "Undo",
  "menu.redo": "Redo",
  "menu.cut": "Cut",
  "menu.copy": "Copy",
  "menu.paste": "Paste",
  "menu.pasteAndMatchStyle": "Paste and Match Style",
  "menu.delete": "Delete",
  "menu.selectAll": "Select All",
  "menu.speech": "Speech",
  "menu.startSpeaking": "Start Speaking",
  "menu.stopSpeaking": "Stop Speaking",
  "menu.openMiniPlayer": "Open Mini Player",
  "menu.reload": "Reload",
  "menu.actualSize": "Actual Size",
  "menu.zoomIn": "Zoom In",
  "menu.zoomOut": "Zoom Out",
  "menu.toggleFullScreen": "Toggle Full Screen",
  "menu.toggleDevTools": "Toggle Developer Tools",
  "menu.minimize": "Minimize",
  "menu.zoom": "Zoom",
  "menu.bringAllToFront": "Bring All to Front",
  "menu.closeWindow": "Close Window",
  "menu.helpDocs": "Tagcast Help",
  "menu.website": "Tagcast Website",
  "menu.reddit": "Tagcast on Reddit",
  "menu.github": "Tagcast on GitHub",
  "about.credits": "Independent app by Cyberdelia · Powered by iBroadcast",
  "window.miniPlayer": "Tagcast · Mini Player",
  "window.signIn": "Sign in to iBroadcast",
  "close.keepOpen": "Keep Tagcast open",
  "close.close": "Close Tagcast",
  "close.title": "Close Tagcast?",
  "close.message": "There are unsaved changes, active music transfers or a save is still running.",
  "close.detail": "Closing loses unsaved drafts and stops downloads/uploads. Files already sent may still arrive in iBroadcast. Accepted library writes finish before the local server stops.",
  "shutdown.title": "Finishing Tagcast",
  "shutdown.message": "Tagcast is finishing active operations.",
  "shutdown.phase.writes": "Finishing accepted changes or sign-in renewal…",
  "shutdown.phase.reads": "Stopping connections and finishing current reads…",
  "shutdown.phase.checking": "Verifying accepted changes with iBroadcast…",
  "shutdown.phase.services": "Stopping transfers and local tasks…",
  "shutdown.phase.cache": "Finishing local storage…",
  "shutdown.phase.ready": "Finished. Closing Tagcast…",
  "shutdown.elapsed": "Elapsed seconds:",
  "shutdown.detail": "Accepted library writes are never force-stopped. Transfers and cleanup stay stopped if you keep Tagcast open. Files already sent may still arrive in iBroadcast.",
  "shutdown.reopen": "Keep Tagcast open",
  "shutdown.reopened": "Tagcast stayed open. Playback, transfers and cleanup remain stopped; accepted changes continue to be checked.",
  "shutdown.uncertain": "Some changes could not be confirmed. Check iBroadcast before reviewing another change. No request will be retried automatically.",
  "shutdown.interrupted": "The local server stopped unexpectedly. Some changes may have been sent without confirmation. Check iBroadcast before another review; nothing will be retried automatically.",
  "update.title": "Install Tagcast update",
  "update.install": "Restart and install",
  "update.confirm": "Restart Tagcast to install the downloaded update? Accepted saves and verification must finish first.",
  "update.failed": "The update could not be installed. Start Tagcast again or use the official release download.",
  "error.linkTitle": "Could not open link",
  "error.linkText": "Open this HTTPS link in your browser instead.",
  "error.windowStoppedTitle": "Tagcast's window stopped",
  "error.windowStoppedText": "Restart Tagcast Desktop. The local server will finish accepted requests before closing.",
  "error.openTitle": "Could not open Tagcast",
  "error.openText": "The local interface could not be loaded. Restart Tagcast Desktop.",
  "error.serverStoppedTitle": "Tagcast's server stopped",
  "error.serverStoppedText": "Restart Tagcast Desktop. No requests will be retried automatically.",
  "error.startTitle": "Could not start Tagcast Desktop",
  "error.startHint": "See tagcast.log in your Tagcast settings folder.",
  "startup.versionMismatch": "The desktop server does not match this Tagcast version.",
  "startup.invalidAddress": "Invalid desktop server address.",
  "startup.notReady": "Tagcast's local server did not become ready.",
  "startup.couldNotStart": "Could not start Tagcast's local server.",
  "startup.stoppedEarly": "Tagcast's local server stopped before it was ready.",
  "startup.portBusy": "The server port is occupied or another Tagcast version is running. Close that instance and try again.",
  "startup.invalidResponse": "Invalid response from Tagcast's local server.",
  "startup.pageMissing": "Tagcast did not return its interface.",
  "startup.pageTooLarge": "The application page is too large.",
  "startup.pageTimeout": "Tagcast's interface timed out.",
  "picker.chooseFolder": "Choose music folder",
  "picker.chooseFiles": "Choose music files",
  "picker.audioFiles": "Audio files",
  "picker.allFiles": "All files"
});
const NAMES = Object.freeze(Object.keys(ENGLISH));
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const MAX_LENGTH = 400;

const isEnglish = language => language === "en" || language.startsWith("en-");

// Only known names, plain one-line text, bounded length. English stores no texts.
function sanitizeInterface(value) {
  const language = typeof value?.language === "string" && LANGUAGE.test(value.language) ? value.language : "en";
  const labels = {};
  if (!isEnglish(language) && value?.labels && typeof value.labels === "object") {
    for (const name of NAMES) {
      const text = value.labels[name];
      if (typeof text !== "string") continue;
      const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LENGTH);
      if (clean) labels[name] = clean;
    }
  }
  return {language, labels};
}

function createDesktopText(file, files = fs) {
  let current = {language: "en", labels: {}};
  try {
    const data = files.readFileSync(file, "utf8");
    if (data.length < 65536) current = sanitizeInterface(JSON.parse(data));
  } catch { /* first start or unreadable: English */ }
  return {
    get language() { return current.language; },
    get english() { return isEnglish(current.language); },
    text(name) { return (!isEnglish(current.language) && current.labels[name]) || ENGLISH[name] || name; },
    // Returns true when menus should be rebuilt. Saving is best effort: this session follows anyway.
    update(value) {
      const next = sanitizeInterface(value);
      if (JSON.stringify(next) === JSON.stringify(current)) return false;
      current = next;
      try { files.writeFileSync(file + ".tmp", JSON.stringify(current)); files.renameSync(file + ".tmp", file); } catch { /* optional */ }
      return true;
    }
  };
}

// The same menus as always. In English every role keeps Electron's own label; other languages
// label each item, including the default Edit and Window submenus, which are spelled out.
function menuTemplate({platform, packaged, appName, text, english, openMiniPlayer, help}) {
  const mac = platform === "darwin";
  const role = (name, key) => english ? {role: name} : {role: name, label: text(key)};
  const separator = {type: "separator"};
  const appMenu = mac
    ? {label: appName, submenu: [role("about", "menu.about"), separator, role("hide", "menu.hide"), role("hideOthers", "menu.hideOthers"),
      role("unhide", "menu.showAll"), separator, role("quit", "menu.quitApp")]}
    : {label: text("menu.file"), submenu: [role("quit", platform === "win32" ? "menu.exit" : "menu.quit")]};
  const editMenu = english ? {role: "editMenu"} : {label: text("menu.edit"), submenu: [
    role("undo", "menu.undo"), role("redo", "menu.redo"), separator, role("cut", "menu.cut"), role("copy", "menu.copy"), role("paste", "menu.paste"),
    ...(mac ? [role("pasteAndMatchStyle", "menu.pasteAndMatchStyle"), role("delete", "menu.delete"), role("selectAll", "menu.selectAll"), separator,
      {label: text("menu.speech"), submenu: [role("startSpeaking", "menu.startSpeaking"), role("stopSpeaking", "menu.stopSpeaking")]}]
      : [role("delete", "menu.delete"), separator, role("selectAll", "menu.selectAll")])]};
  const viewMenu = {label: text("menu.view"), submenu: [
    {label: text("menu.openMiniPlayer"), accelerator: "CmdOrCtrl+Shift+M", click: openMiniPlayer}, separator,
    role("reload", "menu.reload"), role("resetZoom", "menu.actualSize"), role("zoomIn", "menu.zoomIn"), role("zoomOut", "menu.zoomOut"), separator,
    role("togglefullscreen", "menu.toggleFullScreen"), ...(!packaged ? [role("toggleDevTools", "menu.toggleDevTools")] : [])]};
  const windowMenu = english ? {role: "windowMenu"} : {role: "windowMenu", label: text("menu.window"), submenu: mac
    ? [role("minimize", "menu.minimize"), role("zoom", "menu.zoom"), separator, role("front", "menu.bringAllToFront")]
    : [role("minimize", "menu.minimize"), role("close", "menu.closeWindow")]};
  return [appMenu, editMenu, viewMenu, windowMenu, help];
}

module.exports = {ENGLISH, NAMES, sanitizeInterface, createDesktopText, menuTemplate};
