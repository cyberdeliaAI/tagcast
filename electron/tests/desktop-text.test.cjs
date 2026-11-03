"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {ENGLISH, NAMES, sanitizeInterface, createDesktopText, menuTemplate} = require("../desktop-text.cjs");
const {helpMenu} = require("../help-menu.cjs");
const {installUploadPicker} = require("../upload-picker.cjs");
const {EventEmitter} = require("node:events");

const catalog = name => JSON.parse(fs.readFileSync(path.join(__dirname, `../../src/tagcast/static/i18n/${name}.json`), "utf8"));
const dutch = Object.fromEntries(Object.entries(catalog("nl")).filter(([key]) => key.startsWith("desktop.")).map(([key, value]) => [key.slice(8), value]));
const plain = items => JSON.parse(JSON.stringify(items));

// The menus as they were before translations existed (click handlers left out).
function originalTemplate(platform, packaged) {
  return [
    ...(platform === "darwin" ? [{label: "Tagcast", submenu: [{role: "about"}, {type: "separator"}, {role: "hide"}, {role: "hideOthers"}, {role: "unhide"}, {type: "separator"}, {role: "quit"}]}] : [{label: "File", submenu: [{role: "quit"}]}]),
    {role: "editMenu"},
    {label: "View", submenu: [{label: "Open Mini Player", accelerator: "CmdOrCtrl+Shift+M"}, {type: "separator"}, {role: "reload"}, {role: "resetZoom"}, {role: "zoomIn"}, {role: "zoomOut"}, {type: "separator"}, {role: "togglefullscreen"}, ...(!packaged ? [{role: "toggleDevTools"}] : [])]},
    {role: "windowMenu"},
    {role: "help", submenu: [{label: "Tagcast Help"}, {label: "Tagcast Website"}, {label: "Tagcast on Reddit"}, {label: "Tagcast on GitHub"}]}
  ];
}
function build(platform, packaged, text, english) {
  return menuTemplate({platform, packaged, appName: "Tagcast", text, english, openMiniPlayer: () => {}, help: helpMenu(() => {}, {text, english})});
}
function labelsOf(items, out = []) {
  for (const item of items) {
    if (item.type !== "separator") out.push(item);
    if (Array.isArray(item.submenu)) labelsOf(item.submenu, out);
  }
  return out;
}

test("English menus are exactly the existing menus with Electron's own role labels", () => {
  const english = name => ENGLISH[name];
  for (const platform of ["darwin", "win32", "linux"]) for (const packaged of [true, false]) {
    assert.deepEqual(plain(build(platform, packaged, english, true)), originalTemplate(platform, packaged), `${platform} packaged=${packaged}`);
  }
});

test("Dutch labels every menu item, spells out the Edit and Window menus and keeps every role and shortcut", () => {
  const text = name => dutch[name];
  for (const platform of ["darwin", "win32", "linux"]) {
    const menu = build(platform, false, text, false);
    for (const item of labelsOf(menu)) assert.ok(item.label && !Object.values(ENGLISH).includes(item.label) || item.label === "Tagcast" || item.label === "Help", `${platform}: ${JSON.stringify(item)}`);
    const roles = labelsOf(menu).map(item => item.role).filter(Boolean);
    const expected = platform === "darwin"
      ? ["about", "hide", "hideOthers", "unhide", "quit", "undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll", "startSpeaking", "stopSpeaking",
        "reload", "resetZoom", "zoomIn", "zoomOut", "togglefullscreen", "toggleDevTools", "windowMenu", "minimize", "zoom", "front", "help"]
      : ["quit", "undo", "redo", "cut", "copy", "paste", "delete", "selectAll", "reload", "resetZoom", "zoomIn", "zoomOut", "togglefullscreen", "toggleDevTools", "windowMenu", "minimize", "close", "help"];
    assert.deepEqual(roles, expected, platform);
    assert.equal(menu[2].submenu[0].accelerator, "CmdOrCtrl+Shift+M");
  }
  assert.equal(build("win32", true, text, false)[0].submenu[0].label, "Afsluiten");
  assert.equal(build("darwin", true, text, false)[0].label, "Tagcast", "the app menu keeps the app name");
});

test("only known plain texts in a valid language are kept; English keeps none", () => {
  assert.deepEqual(sanitizeInterface({language: "en", labels: {"menu.file": "Bestand"}}), {language: "en", labels: {}});
  assert.deepEqual(sanitizeInterface(null), {language: "en", labels: {}});
  for (const language of ["", "NL", "nl;", "../x", 7, "nl-" + "x".repeat(20)]) assert.equal(sanitizeInterface({language}).language, "en", String(language));
  const result = sanitizeInterface({language: "nl", labels: {"menu.file": " Bes\ntand\u2028 ", "menu.view": "x".repeat(900), unknown: "x", "menu.edit": 5, "__proto__": "y"}});
  assert.deepEqual(Object.keys(result.labels).sort(), ["menu.file", "menu.view"]);
  assert.equal(result.labels["menu.file"], "Bes tand");
  assert.equal(result.labels["menu.view"].length, 400);
});

test("the language survives a restart, is written atomically and an unreadable file means English", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "tagcast-desktop-text-")), file = path.join(folder, "interface.json");
  try {
    const first = createDesktopText(file);
    assert.equal(first.english, true);
    assert.equal(first.text("menu.file"), "File");
    assert.equal(first.update({language: "en"}), false, "English on first start writes nothing");
    assert.equal(fs.existsSync(file), false);
    assert.equal(first.update({language: "nl", labels: Object.fromEntries(NAMES.map(name => [name, dutch[name]]))}), true);
    assert.equal(first.update({language: "nl", labels: Object.fromEntries(NAMES.map(name => [name, dutch[name]]))}), false, "an unchanged report rebuilds nothing");
    assert.equal(first.text("close.title"), "Tagcast sluiten?");
    assert.equal(fs.existsSync(file + ".tmp"), false);
    const second = createDesktopText(file);
    assert.equal(second.language, "nl");
    assert.equal(second.text("picker.allFiles"), "Alle bestanden");
    assert.equal(second.text("menu.file"), "Bestand");
    second.update({language: "nl", labels: {}});
    assert.equal(createDesktopText(file).text("menu.file"), "File", "a missing Dutch text falls back to English");
    fs.writeFileSync(file, "{not json");
    assert.equal(createDesktopText(file).text("close.title"), "Close Tagcast?");
  } finally { fs.rmSync(folder, {recursive: true, force: true}); }
});

test("every desktop text is translated in every complete language", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../src/tagcast/static/i18n/manifest.json"), "utf8"));
  for (const language of manifest.languages.filter(l => l.tag !== "en" && l.status === "complete")) {
    const messages = catalog(language.tag);
    for (const name of NAMES) assert.ok(messages[`desktop.${name}`]?.trim(), `${language.tag}: desktop.${name}`);
    const text = name => messages[`desktop.${name}`];
    for (const platform of ["darwin", "win32", "linux"]) {
      const menu = build(platform, false, text, false);
      for (const item of labelsOf(menu)) assert.ok(item.type === "separator" || item.label, `${language.tag} ${platform}: unlabelled ${JSON.stringify(item)}`);
    }
  }
});

test("the native file chooser uses the interface language for its title and filters", async () => {
  const handlers = new Map(), contents = Object.assign(new EventEmitter(), {isDestroyed: () => false, getURL: () => "http://127.0.0.1:8912/", mainFrame: {}});
  const owner = Object.assign(new EventEmitter(), {webContents: contents});
  let options;
  const deps = {ipcMain: {handle: (name, fn) => handlers.set(name, fn), removeHandler() {}},
    dialog: {showOpenDialog: async (_owner, value) => { options = value; return {canceled: true, filePaths: []}; }}};
  installUploadPicker(owner, "http://127.0.0.1:8912", deps, name => dutch[name]);
  const event = {sender: contents, senderFrame: contents.mainFrame};
  assert.deepEqual(await handlers.get("uploads:choose")(event, "files"), {paths: []});
  assert.equal(options.title, "Muziekbestanden kiezen");
  assert.deepEqual(options.filters.map(filter => filter.name), ["Audiobestanden", "Alle bestanden"]);
  await handlers.get("uploads:choose")(event, "folder");
  assert.equal(options.title, "Muziekmap kiezen");
  assert.deepEqual(await handlers.get("uploads:choose")({sender: {}, senderFrame: {}}, "files"),
    {error: "File selection is not available.", code: "desktop.picker_unavailable"});
});
