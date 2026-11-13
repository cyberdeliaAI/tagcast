"use strict";

// Only official, stable, immutable release URLs can reach the native updater.
// The renderer supplies a version and fixed actions, never a feed, path or command.
const fs = require("node:fs");
const path = require("node:path");
const {randomUUID} = require("node:crypto");
const RELEASES = "https://github.com/cyberdeliaAI/tagcast/releases/download/";
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const MAX_PACKAGE = 2 * 1024 * 1024 * 1024;

function newer(version, current) {
  if (typeof version !== "string" || typeof current !== "string" || !VERSION.test(version) || !VERSION.test(current)) return false;
  const a = version.split(".").map(Number), b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function packageName(version, platform, arch) {
  if (typeof version !== "string" || !VERSION.test(version)) return null;
  if (platform === "darwin" && ["arm64", "x64"].includes(arch)) return `tagcast-${version}-macos-${arch}.zip`;
  if (platform === "win32" && arch === "x64") return `tagcast-${version}-windows-x64-setup.exe`;
  if (platform === "linux" && arch === "x64") return `tagcast-${version}-linux-amd64.deb`;
  return null;
}

function checkedInfo(info, version, platform, arch) {
  const expected = packageName(version, platform, arch), feed = `${RELEASES}v${version}/`;
  if (!expected || info?.version !== version || info.packages !== undefined || !Array.isArray(info.files) || !info.files.length || info.files.length > 4) throw Error("metadata");
  const allowed = platform === "darwin" ? [packageName(version, platform, "arm64"), packageName(version, platform, "x64")] : [expected];
  const seen = new Set();
  for (const file of info.files) {
    if (typeof file?.url !== "string" || !allowed.includes(file.url) || seen.has(file.url)
        || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_PACKAGE
        || typeof file.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
        || Buffer.from(file.sha512, "base64").length !== 64) throw Error("metadata");
    seen.add(file.url);
    if (new URL(file.url, feed).href !== feed + file.url) throw Error("metadata");
  }
  if (!seen.has(expected) || (info.path !== undefined && !allowed.includes(info.path))) throw Error("metadata");
  return expected;
}

function preferences(value) {
  return {autoDownload: value?.autoDownload === true,
    skipped: VERSION.test(value?.skipped || "") ? value.skipped : ""};
}

class DesktopUpdates {
  constructor({current, platform, arch, supported, reason = "", file, createUpdater,
    onChange = () => {}, onConfirm = async () => false, onInstall = () => {}, onInstallError = () => {}, files = fs}) {
    Object.assign(this, {current, platform, arch, supported, reason, file, createUpdater, onChange, onConfirm, onInstall, onInstallError, files});
    this.prefs = preferences();
    try { const text = files.readFileSync(file, "utf8"); if (text.length <= 16384) this.prefs = preferences(JSON.parse(text)); } catch { /* new profile */ }
    this.state = "idle"; this.version = ""; this.progress = 0; this.error = "";
    this.busy = null; this.updater = null; this.ready = false; this.installing = false;
    this.approved = false; this.installGeneration = 0;
  }
  snapshot() {
    return {supported: this.supported, reason: this.reason, state: this.state, version: this.version,
      progress: this.progress, error: this.error, autoDownload: this.prefs.autoDownload, skipped: this.prefs.skipped};
  }
  publish() {
    try { this.onChange(this.snapshot()); } catch { /* a closing renderer cannot change update state */ }
    return this.snapshot();
  }
  save(value) {
    const next = preferences(value);
    const temporary = this.file + "." + randomUUID() + ".tmp";
    try {
      this.files.writeFileSync(temporary, JSON.stringify(next), {mode: 0o600, flag: "wx"});
      this.files.renameSync(temporary, this.file);
    } catch {
      try { this.files.unlinkSync?.(temporary); } catch { /* only our own temporary file */ }
      this.error = "preferences"; return this.publish();
    }
    this.prefs = next; this.error = ""; return this.publish();
  }
  configure(autoDownload) {
    if (typeof autoDownload !== "boolean" || this.installing) return this.snapshot();
    return this.save({...this.prefs, autoDownload});
  }
  skip(version) {
    if (version !== this.version || this.busy || this.installing) return this.snapshot();
    return this.save({...this.prefs, skipped: version});
  }
  offer(version, automatic = false) {
    if (!newer(version, this.current) || this.installing) return this.snapshot();
    if (this.busy) {
      if (newer(version, this.nextVersion || this.version)) this.nextVersion = version;
      return this.snapshot();
    }
    if (this.version !== version) {
      this.version = version; this.ready = false; this.state = "available"; this.progress = 0; this.error = "";
    }
    this.publish();
    if (automatic === true && this.supported && this.prefs.autoDownload && this.prefs.skipped !== version && this.state === "available") {
      // Errors are visible; no timer, retry or install-on-quit is registered.
      void this.download(version);
    }
    return this.snapshot();
  }
  download(version) {
    if (!this.supported || version !== this.version || !newer(version, this.current) || this.installing) return Promise.resolve(this.snapshot());
    if (this.busy) return this.busy;
    if (this.ready) return Promise.resolve(this.snapshot());
    this.busy = this.fetch(version).finally(() => {
      this.busy = null;
      const next = this.nextVersion; this.nextVersion = "";
      if (next) this.offer(next, false);
    });
    return this.busy;
  }
  async fetch(version) {
    this.state = "checking"; this.error = ""; this.publish();
    try {
      if (!this.updater) {
        this.updater = this.createUpdater();
        this.updater.autoDownload = false;
        this.updater.autoInstallOnAppQuit = false;
        this.updater.allowPrerelease = false;
        this.updater.allowDowngrade = false;
        this.updater.on("error", () => {
          if (this.finishing) { this.failedInstall = true; this.onInstallError(); }
          // Download/check errors are reported by the awaited operation below.
        });
        this.updater.on("download-progress", value => {
          if (this.state !== "downloading") return;
          const percent = value?.percent;
          this.progress = Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.floor(percent))) : 0;
          this.publish();
        });
      }
      this.updater.setFeedURL({provider: "generic", url: `${RELEASES}v${version}/`, useMultipleRangeRequest: false});
      const result = await this.updater.checkForUpdates();
      checkedInfo(result?.updateInfo, version, this.platform, this.arch);
      this.state = "downloading"; this.publish();
      await this.updater.downloadUpdate();
      this.ready = true; this.state = "ready"; this.progress = 100; this.publish();
    } catch {
      this.ready = false; this.state = "error"; this.error = "download"; this.publish();
    }
    return this.snapshot();
  }
  async install(version) {
    if (version !== this.version || !this.ready || this.busy || this.installing) return this.snapshot();
    const generation = ++this.installGeneration;
    this.installing = true; this.approved = false; this.state = "finishing"; this.error = ""; this.publish();
    try {
      const approved = await this.onConfirm();
      if (!this.installing || generation !== this.installGeneration || version !== this.version) return this.snapshot();
      if (approved !== true) return this.defer();
      this.approved = true;
      await this.onInstall();
    }
    catch { this.defer("install"); }
    return this.snapshot();
  }
  defer(error = "") {
    this.installGeneration++; this.approved = false; this.finishing = false;
    this.installing = false; this.error = error; this.state = this.ready ? "ready" : "available";
    return this.publish();
  }
  finish() {
    if (!this.installing || !this.approved || !this.ready || !this.updater) return false;
    // Called only after the owned backend exited cleanly and confirmed its writes.
    this.finishing = true; this.failedInstall = false;
    this.updater.quitAndInstall(false, true);
    return !this.failedInstall;
  }
}

function installation({packaged, platform, arch, execPath, resourcesPath, files = fs}) {
  if (!packaged || !packageName("1.0.0", platform, arch)) return {supported: false, reason: "manual"};
  try {
    const config = JSON.parse(files.readFileSync(path.join(resourcesPath, "update-capabilities.json"), "utf8"));
    if (config.protocol !== 1) return {supported: false, reason: "manual"};
    if (platform === "darwin") {
      if (!config.developerId) return {supported: false, reason: "test"};
      if (["/opt/homebrew/Caskroom/tagcast", "/usr/local/Caskroom/tagcast"].some(name => files.existsSync(name))) return {supported: false, reason: "homebrew"};
      return {supported: true, reason: ""};
    }
    if (platform === "win32" && files.existsSync(path.join(path.dirname(execPath), "Uninstall Tagcast.exe"))) {
      const publisher = JSON.parse(files.readFileSync(path.join(resourcesPath, "app-update.yml"), "utf8")).publisherName;
      if (Array.isArray(publisher) && publisher.length > 0 && publisher.length <= 4
          && publisher.every(name => typeof name === "string" && name.length > 0 && name.length <= 200 && !/[\x00-\x1f]/.test(name))) return {supported: true, reason: ""};
      return {supported: false, reason: "signing"};
    }
    if (platform === "linux" && files.realpathSync(execPath) === "/opt/Tagcast/Tagcast"
        && files.existsSync("/var/lib/dpkg/info/tagcast.list")) return {supported: true, reason: ""};
  } catch { /* incomplete or unsupported installation stays manual */ }
  return {supported: false, reason: "manual"};
}

function installUpdateBridge({ipcMain, window: getWindow, origin: getOrigin, applicationUrl, updates}) {
  const trusted = event => {
    const contents = getWindow()?.webContents;
    return contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame
      && applicationUrl(contents.getURL(), getOrigin());
  };
  for (const [action, handler] of Object.entries({
    status: () => updates.snapshot(), offer: value => updates.offer(value?.version, value?.automatic === true),
    download: value => updates.download(value), install: value => updates.install(value),
    skip: value => updates.skip(value), configure: value => updates.configure(value)
  })) ipcMain.handle(`updates:${action}`, (event, value) => trusted(event) ? handler(value) : null);
}

module.exports = {DesktopUpdates, installation, installUpdateBridge, newer, packageName, checkedInfo};
