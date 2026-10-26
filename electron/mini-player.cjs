"use strict";
const {BrowserWindow, ipcMain, session, screen, app} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const {command, snapshot, bounds} = require("./mini-contract.cjs");

function installMiniPlayer(owner, origin) {
  const url = origin + "/mini-player/index.html", ownerContents = owner.webContents;
  const preferences = path.join(app.getPath("userData"), "mini-player.json");
  let mini = null, latest = null, saved = {}, serial = 0;
  const pending = new Map();
  const wayland = process.platform === "linux" && Boolean(process.env.WAYLAND_DISPLAY);
  try { const data = fs.readFileSync(preferences, "utf8"); if (data.length < 4096) saved = JSON.parse(data); } catch { /* first use */ }
  let pinned = !wayland && saved?.pinned === true;
  const from = (event, contents, expected) => contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame && expected(contents.getURL());
  const fromOwner = event => from(event, ownerContents, value => { try { const u = new URL(value); return u.origin === origin && ["/", "/index.html"].includes(u.pathname) && !u.search; } catch { return false; } });
  const fromMini = event => from(event, mini?.webContents, value => value === url);
  const sendOwner = (channel, value) => { if (!ownerContents.isDestroyed()) ownerContents.send(channel, value); };
  const publish = () => { if (mini && !mini.isDestroyed()) mini.webContents.send("mini:state", {playback: latest, pinned, canPin: !wayland}); };
  const cancelPending = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.resolve(false); } pending.clear(); };
  const restoreMain = () => { if (!owner.isDestroyed()) { if (owner.isMinimized()) owner.restore(); owner.show(); owner.focus(); } };
  function showMain() {
    // Closing this passive view must never close the renderer that owns audio.
    restoreMain();
    if (mini && !mini.isDestroyed()) mini.close();
  }
  function showMini() {
    if (!mini || mini.isDestroyed() || owner.isDestroyed()) return;
    owner.hide();
    if (mini.isMinimized()) mini.restore();
    mini.show(); mini.focus();
  }
  function persist() {
    if (!mini || mini.isDestroyed()) return;
    saved = {...mini.getBounds(), pinned};
    try { fs.writeFileSync(preferences + ".tmp", JSON.stringify(saved)); fs.renameSync(preferences + ".tmp", preferences); } catch { /* optional window preference */ }
  }
  function open() {
    if (owner.isDestroyed()) return;
    if (mini && !mini.isDestroyed()) { showMini(); return; }
    const candidate = bounds(saved, screen.getPrimaryDisplay().workArea);
    const area = screen.getDisplayMatching(candidate).workArea;
    mini = new BrowserWindow({...bounds(saved, area), minWidth: 420, minHeight: 210, show: false,
      title: "Tagcast · Mini Player", backgroundColor: "#192516", alwaysOnTop: pinned,
      webPreferences: {preload: path.join(__dirname, "mini-preload.cjs"), partition: "tagcast-mini", sandbox: true,
        contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, devTools: !app.isPackaged}});
    const view = mini, contents = view.webContents;
    // The passive window has neither audio nor API access; only artwork may use HTTPS.
    const ses = session.fromPartition("tagcast-mini");
    ses.setPermissionCheckHandler(() => false);
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setDevicePermissionHandler(() => false);
    ses.webRequest.onHeadersReceived({urls: [origin + "/*"]}, (details, callback) => callback({responseHeaders: {...details.responseHeaders,
      "Content-Security-Policy": ["default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src https:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"]}}));
    contents.setWindowOpenHandler(() => ({action: "deny"}));
    for (const name of ["will-navigate", "will-redirect"]) contents.on(name, (event, target) => { if (target !== url) event.preventDefault(); });
    contents.on("will-attach-webview", event => event.preventDefault());
    contents.on("render-process-gone", () => { if (!view.isDestroyed()) view.close(); });
    mini.once("ready-to-show", () => { if (mini === view) showMini(); });
    mini.on("close", persist);
    mini.on("closed", () => { mini = null; latest = null; cancelPending(); sendOwner("mini:active", false); restoreMain(); });
    sendOwner("mini:active", true);
    view.loadURL(url).catch(() => { if (!view.isDestroyed()) view.close(); });
  }
  ipcMain.on("mini:open", event => { if (fromOwner(event)) open(); });
  ipcMain.on("mini:owner-ready", event => { if (fromOwner(event)) sendOwner("mini:active", Boolean(mini)); });
  ipcMain.on("mini:publish", (event, value) => {
    if (!fromOwner(event) || !mini) return;
    const next = snapshot(value);
    if (!next || (latest?.document === next.document && next.sequence <= latest.sequence)) return;
    latest = next; publish();
  });
  ipcMain.on("mini:ready", event => { if (fromMini(event)) publish(); });
  ipcMain.on("mini:main", event => { if (fromMini(event)) showMain(); });
  ipcMain.handle("mini:pin", (event, value) => {
    if (!fromMini(event) || typeof value !== "boolean" || wayland) return false;
    pinned = value; mini.setAlwaysOnTop(pinned); persist(); publish(); return true;
  });
  ipcMain.handle("mini:command", (event, value) => {
    const next = command(value);
    if (!fromMini(event) || !next || !latest || next.document !== latest.document || pending.size >= 8) return false;
    return new Promise(resolve => {
      const id = ++serial, timer = setTimeout(() => { pending.delete(id); resolve(false); }, 5000);
      pending.set(id, {resolve, timer}); sendOwner("mini:request", {id, command: next});
    });
  });
  ipcMain.on("mini:result", (event, value) => {
    if (!fromOwner(event)) return;
    const item = pending.get(value?.id); if (!item) return;
    pending.delete(value.id); clearTimeout(item.timer); item.resolve(value.ok === true);
  });
  ownerContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) { latest = null; cancelPending(); publish(); }
  });
  // Dock, Window menu and second-instance activation return to the full view.
  const returnOnOwner = () => { if (owner.isVisible() && mini && !mini.isDestroyed()) mini.close(); };
  owner.on("show", returnOnOwner);
  owner.on("focus", returnOnOwner);
  owner.on("closed", () => { cancelPending(); mini?.destroy(); });
  screen.on("display-removed", () => { if (mini && !wayland) mini.setBounds(bounds(mini.getBounds(), screen.getDisplayMatching(mini.getBounds()).workArea)); });
  return {open, showMain, get window() { return mini; }};
}
module.exports = {installMiniPlayer};
