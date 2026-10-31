"use strict";

const http = require("node:http");
const path = require("node:path");
const {windowSize, rememberWindowSize} = require("./window-size.cjs");
const {isIP} = require("node:net");
const {applicationUrl} = require("./security.cjs");
const SIGN_IN_PARTITION = "persist:tagcast-sign-in";

function signInRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,96}$/.test(value);
}

function signInUrl(value) {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://oauth.ibroadcast.com" && !url.username && !url.password
      ? url.href : null;
  } catch { return null; }
}

function signInResource(value) {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/, "");
    // The provider controls its own HTTPS assets. Remote pages never receive
    // a preload, app session, local API access, downloads or native protocols.
    return url.protocol === "https:" && !url.username && !url.password
      && host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local")
      && !isIP(host.replace(/^\[|\]$/g, ""));
  } catch { return false; }
}

function signInApi(origin, pathname, body) {
  // Fixed loopback endpoints only. Never accept an IPC-supplied URL or log
  // provider links, codes, token responses or account details.
  if (!["/api/status", "/api/auth/cancel"].includes(pathname)) return Promise.reject(new Error("Invalid sign-in operation."));
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const request = http.request(new URL(pathname, origin), {method: payload ? "POST" : "GET",
      headers: payload ? {"X-Tagcast": "1", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload)} : {}}, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error("Sign-in status unavailable.")); return; }
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; if (text.length > 65536) request.destroy(new Error("Invalid sign-in status.")); });
      response.on("end", () => { try { resolve(JSON.parse(text)); } catch { reject(new Error("Invalid sign-in status.")); } });
      response.on("error", () => reject(new Error("Sign-in status unavailable.")));
    });
    request.setTimeout(10000, () => request.destroy(new Error("Sign-in status timed out.")));
    request.on("error", () => reject(new Error("Sign-in status unavailable.")));
    request.end(payload);
  });
}

function installSignIn(owner, origin, dependencies = require("electron"), request = signInApi) {
  const {BrowserWindow, ipcMain, session, screen} = dependencies, contents = owner.webContents;
  let current = null, serial = 0;
  const fromOwner = event => !contents.isDestroyed() && event.sender === contents
    && event.senderFrame === contents.mainFrame && applicationUrl(contents.getURL(), origin);
  const notify = (entry, reason) => {
    if (!contents.isDestroyed()) contents.send("signin:closed", {requestId: entry.id, reason});
  };
  const ses = session.fromPartition(SIGN_IN_PARTITION);
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => callback({cancel: !signInResource(details.url)}));
  const denyDownload = event => event.preventDefault();
  ses.on("will-download", denyDownload);

  function end(entry, {cancel = false, reason = "closed", announce = false, restore = false} = {}) {
    if (!entry || current !== entry) return;
    current = null; serial += 1;
    if (entry.view && !entry.view.isDestroyed()) { entry.saveSize?.(); entry.view.destroy(); }
    if (cancel) {
      // Bound cancellation cannot revoke an accepted login or cancel a newer flow.
      request(origin, "/api/auth/cancel", {request_id: entry.id}).catch(() => {}).finally(() => {
        if (announce) notify(entry, reason);
      });
    } else if (announce) notify(entry, reason);
    if ((announce || restore) && !owner.isDestroyed()) { if (owner.isMinimized()) owner.restore(); owner.show(); owner.focus(); }
  }

  async function open(id) {
    if (!signInRequestId(id) || owner.isDestroyed()) return false;
    if (current?.id === id && current.view && !current.view.isDestroyed()) {
      current.view.show(); current.view.focus(); return true;
    }
    if (current) end(current, {cancel: current.id !== id});
    const entry = {id, view: null}, generation = ++serial;
    current = entry;
    try {
      const status = await request(origin, "/api/status"), device = status?.device;
      if (current !== entry || serial !== generation || owner.isDestroyed()) return false;
      const url = signInUrl(device?.verification_uri_complete) || signInUrl(device?.verification_uri);
      if (device?.state !== "pending" || device.request_id !== id || !url
          || !Number.isFinite(device.expires_at) || device.expires_at * 1000 <= Date.now()) {
        end(entry); return false;
      }
      const area = screen.getDisplayMatching(owner.getBounds()).workArea;
      const sizeFile = dependencies.app ? path.join(dependencies.app.getPath("userData"), "sign-in-window.json") : null;
      const size = windowSize(sizeFile, {width: 620, height: 800, minWidth: 360, minHeight: 480}, area);
      const view = entry.view = new BrowserWindow({parent: owner, ...size, show: false,
        title: "Sign in to iBroadcast", backgroundColor: "#ffffff", autoHideMenuBar: true,
        webPreferences: {partition: SIGN_IN_PARTITION, sandbox: true, contextIsolation: true,
          nodeIntegration: false, webSecurity: true, webviewTag: false,
          allowRunningInsecureContent: false, devTools: false, safeDialogs: true}});
      entry.saveSize = rememberWindowSize(view, sizeFile);
      view.setMenu(null);
      view.once("ready-to-show", () => { if (current === entry) { view.show(); view.focus(); } });
      const remote = view.webContents;
      remote.setWindowOpenHandler(() => {
        end(entry, {reason: "browser-needed", announce: true});
        return {action: "deny"};
      });
      for (const name of ["will-navigate", "will-redirect"]) remote.on(name, (event, target) => {
        if (!signInUrl(target)) {
          event.preventDefault();
          end(entry, {reason: "browser-needed", announce: true});
        }
      });
      remote.on("will-attach-webview", event => event.preventDefault());
      remote.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
        if (mainFrame && code !== -3) end(entry, {reason: "load-failed", announce: true});
      });
      remote.on("render-process-gone", () => end(entry, {reason: "load-failed", announce: true}));
      view.on("closed", () => end(entry, {cancel: true, announce: true}));
      view.loadURL(url).catch(() => end(entry, {reason: "load-failed", announce: true}));
      return true;
    } catch { end(entry); return false; }
  }

  const close = (event, id) => { if (fromOwner(event) && current?.id === id) end(current, {restore: true}); };
  ipcMain.handle("signin:open", (event, id) => fromOwner(event) ? open(id) : false);
  ipcMain.on("signin:close", close);
  contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) end(current, {cancel: true});
  });
  owner.on("closed", () => {
    end(current, {cancel: true});
    ipcMain.removeHandler("signin:open"); ipcMain.removeListener("signin:close", close);
    ses.removeListener("will-download", denyDownload);
  });
  return {get window() { return current?.view || null; }};
}

module.exports = {installSignIn, signInUrl, signInResource, signInRequestId, signInApi, SIGN_IN_PARTITION};
