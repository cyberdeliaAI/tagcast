"use strict";

const {app, BrowserWindow, Menu, dialog, session, shell} = require("electron");
const http = require("node:http");
const path = require("node:path");
const {Backend, backendCommand} = require("./backend.cjs");
const {applicationUrl, externalUrl, permissionAllowed, contentPolicy} = require("./security.cjs");
const {helpMenu} = require("./help-menu.cjs");
const packageInfo = require("./package.json");
const {validationOptions} = require("./validation.cjs");
const validation = validationOptions({home: app.getPath("home"), appData: app.getPath("appData"), env: process.env});

app.setName("Tagcast Gapless Test");
app.setPath("userData", validation.profile);
app.enableSandbox();
let window, backend, origin, stopping, finished = false;

function readPage(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let page = "";
      if (response.statusCode !== 200 || !response.headers["content-type"]?.startsWith("text/html")) { response.resume(); reject(new Error("Tagcast did not return its interface.")); return; }
      response.setEncoding("utf8");
      response.on("data", chunk => { page += chunk; if (page.length > 2_000_000) request.destroy(new Error("The application page is too large.")); });
      response.on("end", () => resolve(page));
      response.on("error", reject);
    });
    request.setTimeout(10000, () => request.destroy(new Error("Tagcast's interface timed out.")));
    request.on("error", reject);
  });
}

function openExternal(value) {
  const safe = externalUrl(value);
  if (safe) shell.openExternal(safe).catch(() => dialog.showErrorBox("Could not open link", "Open this HTTPS link in your browser instead."));
}

function installSession(ses, policy) {
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    permissionAllowed(contents, permission, details.requestingUrl || requestingOrigin, details, origin));
  ses.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(permissionAllowed(contents, permission, details.requestingUrl || contents?.getURL(), details, origin)));
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onHeadersReceived({urls: [origin + "/*"]}, (details, callback) => {
    callback({responseHeaders: {...details.responseHeaders, "Content-Security-Policy": [policy]}});
  });
}

function createWindow() {
  const icon = app.isPackaged ? path.join(process.resourcesPath, "tagcast-icon.png") : path.join(__dirname, "../assets/tagcast-icon-512.png");
  window = new BrowserWindow({width: 1420, height: 960, minWidth: 420, minHeight: 600, show: false,
    title: "Tagcast Gapless Test", icon, backgroundColor: "#192516",
    webPreferences: {partition: "persist:tagcast", nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      devTools: !app.isPackaged, backgroundThrottling: false}});
  const contents = window.webContents;
  contents.setWindowOpenHandler(({url}) => { openExternal(url); return {action: "deny"}; });
  contents.on("will-navigate", (event, url) => {
    if (!applicationUrl(url, origin)) { event.preventDefault(); openExternal(url); }
  });
  contents.on("will-redirect", (event, url) => { if (!applicationUrl(url, origin)) event.preventDefault(); });
  contents.on("will-attach-webview", event => event.preventDefault());
  contents.on("will-prevent-unload", event => {
    const choice = dialog.showMessageBoxSync(window, {type: "question", buttons: ["Keep Tagcast open", "Close Tagcast"],
      defaultId: 0, cancelId: 0, title: "Close Tagcast?", message: "There are unsaved changes or a save is still running.",
      detail: "Closing loses unsaved drafts. Accepted requests finish before the local server stops."});
    if (choice === 1) event.preventDefault();
  });
  contents.on("render-process-gone", () => { if (!stopping) dialog.showErrorBox("Tagcast's window stopped", "Restart Tagcast Desktop. The local server will finish accepted requests before closing."); app.quit(); });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => { window = null; app.quit(); });
  window.loadURL(origin).catch(() => { dialog.showErrorBox("Could not open Tagcast", "The local interface could not be loaded. Restart Tagcast Desktop."); window?.destroy(); app.quit(); });
}

function installMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{label: app.name, submenu: [{role: "about"}, {type: "separator"}, {role: "hide"}, {role: "hideOthers"}, {role: "unhide"}, {type: "separator"}, {role: "quit"}]}] : [{label: "File", submenu: [{role: "quit"}]}]),
    {role: "editMenu"},
    {label: "View", submenu: [{role: "reload"}, {role: "resetZoom"}, {role: "zoomIn"}, {role: "zoomOut"}, {type: "separator"}, {role: "togglefullscreen"}, ...(!app.isPackaged ? [{role: "toggleDevTools"}] : [])]},
    {role: "windowMenu"},
    helpMenu(openExternal)
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.setAboutPanelOptions({applicationName: "Tagcast Gapless Test", applicationVersion: packageInfo.version,
    copyright: "Independent app by Cyberdelia · Powered by iBroadcast"});
}

app.on("before-quit", event => {
  if (finished) return;
  event.preventDefault();
  if (window && !window.isDestroyed()) { window.close(); return; }
  stopping ||= (async () => { await backend?.stop(); finished = true; app.quit(); })();
});
app.on("window-all-closed", () => app.quit());
if (!app.requestSingleInstanceLock()) { finished = true; app.quit(); }
else {
  app.on("second-instance", () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    const sourceRoot = app.isPackaged ? null : path.resolve(__dirname, "..");
    backend = new Backend(backendCommand({packaged: app.isPackaged, resourcesPath: process.resourcesPath, sourceRoot, python: process.env.TAGCAST_PYTHON}),
      {version: packageInfo.version.replace(/-beta\.(\d+)$/, "b$1"), sourceRoot, env: validation.env, onExit: () => {
        if (!stopping) { dialog.showErrorBox("Tagcast's server stopped", "Restart Tagcast Desktop. No requests will be retried automatically."); window?.destroy(); app.quit(); }
      }});
    const ready = await backend.start();
    if (stopping) return;
    origin = ready.url;
    const policy = contentPolicy(await readPage(origin));
    if (stopping) return;
    installSession(session.fromPartition("persist:tagcast"), policy);
    installMenu();
    createWindow();
    if (process.env.TAGCAST_ELECTRON_SMOKE_REPORT) require("./smoke.cjs").check({app, window, origin, backend});
  }).catch(error => { dialog.showErrorBox("Could not start Tagcast Desktop", error.message + "\nSee tagcast.log in your Tagcast settings folder."); app.quit(); });
}
