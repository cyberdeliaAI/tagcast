"use strict";

const {app, BrowserWindow, Menu, dialog, ipcMain, session, shell, screen} = require("electron");
const http = require("node:http");
const path = require("node:path");
const {Backend, backendCommand, startupError} = require("./backend.cjs");
const {applicationUrl, externalUrl, permissionAllowed, contentPolicy} = require("./security.cjs");
const {helpMenu} = require("./help-menu.cjs");
const {createDesktopText, menuTemplate} = require("./desktop-text.cjs");
const {installMiniPlayer} = require("./mini-player.cjs");
const {installSignIn} = require("./sign-in.cjs");
const {installUploadPicker} = require("./upload-picker.cjs");
const {installShutdownWindow} = require("./shutdown-window.cjs");
const {windowSize, rememberWindowSize} = require("./window-size.cjs");
const packageInfo = require("./package.json");

app.setName("Tagcast");
if (process.env.TAGCAST_ELECTRON_PROFILE) app.setPath("userData", path.resolve(process.env.TAGCAST_ELECTRON_PROFILE));
app.enableSandbox();
let window, backend, origin, miniPlayer, signIn, stopping, closeChecking, rendererFailed = false, finished = false;
// Menus, titles and dialogs in the interface language the main window last reported.
const desktop = createDesktopText(path.join(app.getPath("userData"), "interface.json"));
const t = name => desktop.text(name);
const errorText = error => error?.textKey ? t(error.textKey) : error?.message;

const shutdownView = installShutdownWindow(t, () => backend?.resume());
const canReopen = () => Boolean(backend?.control && backend.child?.stdin.writable && !backend.child.stdin.writableEnded && !backend.resuming);
async function bounded(work, fallback) {
  let timer;
  try { return await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), 1500); })]); }
  finally { clearTimeout(timer); }
}
async function finishRenderer(status) {
  // The backend has finished all mutations/read-backs. Let existing job polling
  // persist History before closing; a stalled renderer never holds this safe phase.
  if(window&&!window.isDestroyed())await bounded(window.webContents.executeJavaScript(`new Promise(resolve=>{
    const check=()=>{if(!saving&&!checking)resolve();else {
      window.dispatchEvent(new Event('tagcast-shutdown-ready'));setTimeout(check,50);
    }};check();})`).catch(()=>{}),undefined);
  if(status.uncertain){
    const choice=dialog.showMessageBoxSync(shutdownView.window,{type:"warning",buttons:[t("shutdown.reopen"),t("close.close")],defaultId:0,cancelId:0,
      title:t("shutdown.title"),message:t("shutdown.uncertain"),detail:t("shutdown.detail")});
    return choice===1;
  }
  return true;
}
function beginShutdown(){
  if(stopping){shutdownView.show();return;}
  miniPlayer?.beginShutdown();
  signIn?.window?.destroy();
  if(window&&!window.isDestroyed()){
    window.webContents.executeJavaScript("document.querySelector('audio')?.pause()").catch(()=>{});
    window.hide();
  }
  shutdownView.show({phase:"reads",elapsed:0},canReopen());
  stopping=(async()=>{
    const result=await backend?.stop();
    if(result?.stopped===false){
      stopping=null;
      if (!window) await openMainWindow();
      if (rendererFailed && window && !window.isDestroyed()) {
        rendererFailed = false;
        window.reload();
      }
      miniPlayer?.resume();
      if(window&&!window.isDestroyed()){
        window.show();window.focus();
        window.webContents.executeJavaScript('toast(TagcastI18n.text("desktop.shutdown.reopened"))').catch(()=>{});
      }
      shutdownView.destroy();
      return;
    }
    if(result?.code||result?.signal)dialog.showErrorBox(t("shutdown.title"),t("shutdown.interrupted"));
    finished=true;shutdownView.destroy();window?.destroy();app.quit();
  })();
}
function requestShutdown(){
  if (!app.isReady() && !backend) { finished = true; app.quit(); return; }
  if(stopping){shutdownView.show();return;}
  if(closeChecking)return;
  closeChecking=(async()=>{
    let clean=true;
    if(window&&!window.isDestroyed())clean=await bounded(window.webContents.executeJavaScript(
      'window.dispatchEvent(new Event("beforeunload",{cancelable:true}))').catch(()=>false),false);
    if(!clean){
      const choice=dialog.showMessageBoxSync(window,{type:"question",buttons:[t("close.keepOpen"),t("close.close")],defaultId:0,cancelId:0,
        title:t("close.title"),message:t("close.message"),detail:t("close.detail")});
      if(choice!==1)return;
    }
    beginShutdown();
  })().finally(()=>{closeChecking=null;});
}

function readPage(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let page = "";
      if (response.statusCode !== 200 || !response.headers["content-type"]?.startsWith("text/html")) { response.resume(); reject(startupError("startup.pageMissing", "Tagcast did not return its interface.")); return; }
      response.setEncoding("utf8");
      response.on("data", chunk => { page += chunk; if (page.length > 2_000_000) request.destroy(startupError("startup.pageTooLarge", "The application page is too large.")); });
      response.on("end", () => resolve(page));
      response.on("error", reject);
    });
    request.setTimeout(10000, () => request.destroy(startupError("startup.pageTimeout", "Tagcast's interface timed out.")));
    request.on("error", reject);
  });
}

function openExternal(value) {
  const safe = externalUrl(value);
  if (safe) shell.openExternal(safe).catch(() => dialog.showErrorBox(t("error.linkTitle"), t("error.linkText")));
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
  const sizeFile = path.join(app.getPath("userData"), "main-window.json");
  const size = windowSize(sizeFile, {width: 1420, height: 960, minWidth: 420, minHeight: 600}, screen.getPrimaryDisplay().workArea);
  window = new BrowserWindow({...size, show: false,
    title: "Tagcast", icon, backgroundColor: "#192516",
    webPreferences: {preload: path.join(__dirname, "player-preload.cjs"), partition: "persist:tagcast", nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      devTools: !app.isPackaged, backgroundThrottling: false}});
  rememberWindowSize(window, sizeFile);
  miniPlayer = installMiniPlayer(window, origin, t);
  signIn = installSignIn(window, origin, undefined, undefined, t);
  installUploadPicker(window, origin, undefined, t);
  const contents = window.webContents;
  contents.setWindowOpenHandler(({url}) => { openExternal(url); return {action: "deny"}; });
  contents.on("will-navigate", (event, url) => {
    if (!applicationUrl(url, origin)) { event.preventDefault(); openExternal(url); }
  });
  contents.on("will-redirect", (event, url) => { if (!applicationUrl(url, origin)) event.preventDefault(); });
  contents.on("will-attach-webview", event => event.preventDefault());
  contents.on("will-prevent-unload", event => {
    const choice = dialog.showMessageBoxSync(window, {type: "question", buttons: [t("close.keepOpen"), t("close.close")],
      defaultId: 0, cancelId: 0, title: t("close.title"), message: t("close.message"), detail: t("close.detail")});
    if (choice === 1) event.preventDefault();
  });
  contents.on("render-process-gone", () => { rendererFailed = true; if (!stopping) dialog.showErrorBox(t("error.windowStoppedTitle"), t("error.windowStoppedText")); app.quit(); });
  window.once("ready-to-show", () => { if (!stopping && !miniPlayer?.window) window.show(); });
  window.on("close", event => { if (!finished) { event.preventDefault(); requestShutdown(); } });
  window.on("closed", () => { window = null; if (!stopping) app.quit(); });
  window.loadURL(origin).catch(() => { rendererFailed = true; dialog.showErrorBox(t("error.openTitle"), t("error.openText")); app.quit(); });
}

async function openMainWindow() {
  origin = backend.ready.url;
  const policy = contentPolicy(await readPage(origin));
  if (stopping || window) return;
  installSession(session.fromPartition("persist:tagcast"), policy);
  installMenu();
  createWindow();
}

function installMenu() {
  const english = desktop.english;
  const template = menuTemplate({platform: process.platform, packaged: app.isPackaged, appName: app.name, text: t, english,
    openMiniPlayer: () => miniPlayer?.open(), help: helpMenu(openExternal, {text: t, english})});
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.setAboutPanelOptions({applicationName: "Tagcast", applicationVersion: packageInfo.version, copyright: t("about.credits")});
}

// Only the main window's own page may report its language; a change rebuilds the menus.
ipcMain.on("desktop:interface", (event, value) => {
  const contents = window?.webContents;
  if (!contents || contents.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame || !applicationUrl(contents.getURL(), origin)) return;
  if (desktop.update(value) && origin) installMenu();
});

app.on("before-quit", event => {
  if (finished) return;
  event.preventDefault();
  requestShutdown();
});
app.on("window-all-closed", () => app.quit());
if (!app.requestSingleInstanceLock()) { finished = true; app.quit(); }
else {
  app.on("second-instance", () => { if(stopping)shutdownView.show();else miniPlayer?.showMain(); });
  app.whenReady().then(async () => {
    const sourceRoot = app.isPackaged ? null : path.resolve(__dirname, "..");
    backend = new Backend(backendCommand({packaged: app.isPackaged, resourcesPath: process.resourcesPath, sourceRoot, python: process.env.TAGCAST_PYTHON}),
      {version: packageInfo.version.replace(/-beta\.(\d+)$/, "b$1"), sourceRoot,
        onShutdown: status => shutdownView.update(status, status.phase !== "ready" && canReopen()), onShutdownReady: finishRenderer, onExit: () => {
        if (!stopping) { dialog.showErrorBox(t("error.serverStoppedTitle"), t("error.serverStoppedText")); window?.destroy(); app.quit(); }
      }});
    await backend.start();
    if (stopping) return;
    await openMainWindow();
    if (stopping || !window) return;
    if (process.env.TAGCAST_ELECTRON_SMOKE_REPORT) require("./smoke.cjs").check({app, window, origin, backend, miniPlayer});
    if (process.env.TAGCAST_SIGN_IN_SMOKE_REPORT) require("./sign-in-smoke.cjs").check({app, window, origin, signIn});
    if (process.env.TAGCAST_SHUTDOWN_SMOKE_REPORT) require("./shutdown-smoke.cjs").check({app, window, origin, backend, shutdownView});
  }).catch(error => { dialog.showErrorBox(t("error.startTitle"), errorText(error) + "\n" + t("error.startHint")); app.quit(); });
}
