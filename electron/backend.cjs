"use strict";

const {spawn} = require("node:child_process");
const {existsSync} = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

function backendCommand({packaged, resourcesPath, sourceRoot, python}) {
  if (packaged) return {file: path.join(resourcesPath, "backend", process.platform === "win32" ? "tagcast-server.exe" : "tagcast-server"), args: []};
  const local = path.join(sourceRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return {file: python || (existsSync(local) ? local : process.platform === "win32" ? "python" : "python3"), args: ["-m", "tagcast.electron_host"]};
}

function readyMessage(data, version) {
  if (data?.event !== "ready" || data.protocol !== 1 || data.version !== version || typeof data.owned !== "boolean") throw new Error("The desktop server does not match this Tagcast version.");
  const url = new URL(data.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid desktop server address.");
  return {...data, url: url.origin};
}

class Backend {
  constructor(command, {version, sourceRoot, env = process.env, timeout = 30000, onExit = () => {}}) {
    this.command = command; this.version = version; this.sourceRoot = sourceRoot;
    this.env = env; this.timeout = timeout; this.onExit = onExit; this.stopping = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      const env = {...this.env, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1"};
      if (this.sourceRoot) env.PYTHONPATH = path.join(this.sourceRoot, "src");
      this.child = spawn(this.command.file, this.command.args, {cwd: this.sourceRoot || path.dirname(this.command.file), env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
      // Never expose server stderr, which can contain library titles or request URLs.
      this.child.stderr.resume();
      this.child.stdin.on("error", () => {});
      let settled = false;
      const timer = setTimeout(() => fail(new Error("Tagcast's local server did not become ready.")), this.timeout);
      const fail = error => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.stop(); reject(error);
      };
      this.exited = new Promise(done => {
        this.child.once("error", () => { fail(new Error("Could not start Tagcast's local server.")); done(); });
        this.child.once("exit", (code, signal) => {
          fail(new Error("Tagcast's local server stopped before it was ready."));
          done();
          if (!this.stopping) this.onExit({code, signal});
        });
      });
      const lines = readline.createInterface({input: this.child.stdout});
      lines.on("line", line => {
        if (settled) return;
        try {
          if (line.length > 8192) throw new Error();
          const data = JSON.parse(line);
          if (data.event === "error") throw new Error("The server port is occupied or another Tagcast version is running. Close that instance and try again.");
          const ready = readyMessage(data, this.version);
          settled = true; clearTimeout(timer); resolve(ready);
        } catch (error) {
          fail(error instanceof SyntaxError ? new Error("Invalid response from Tagcast's local server.") : error);
        }
      });
    });
  }

  stop() {
    this.stopping = true;
    if (this.child?.stdin.writable) this.child.stdin.end("stop\n");
    // No automatic kill: reviewed writes must finish their current request/read-back.
    return this.exited || Promise.resolve();
  }
}

module.exports = {Backend, backendCommand, readyMessage};
