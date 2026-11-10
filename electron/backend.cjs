"use strict";

const {spawn} = require("node:child_process");
const {existsSync} = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

// The English message stays for logs and tests; textKey lets the startup dialog show it in the
// interface language (desktop-text.cjs).
const startupError = (textKey, message) => Object.assign(new Error(message), {textKey});

function backendCommand({packaged, resourcesPath, sourceRoot, python}) {
  if (packaged) return {file: path.join(resourcesPath, "backend", process.platform === "win32" ? "tagcast-server.exe" : "tagcast-server"), args: []};
  const local = path.join(sourceRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return {file: python || (existsSync(local) ? local : process.platform === "win32" ? "python" : "python3"), args: ["-m", "tagcast.electron_host"]};
}

function readyMessage(data, version) {
  if (data?.event !== "ready" || data.protocol !== 1 || data.version !== version || typeof data.owned !== "boolean") throw startupError("startup.versionMismatch", "The desktop server does not match this Tagcast version.");
  const url = new URL(data.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw startupError("startup.invalidAddress", "Invalid desktop server address.");
  return {...data, url: url.origin};
}

function shutdownMessage(data) {
  if (data?.event !== "shutdown" || !["writes", "reads", "checking", "services", "cache", "ready"].includes(data.phase)
      || typeof data.uncertain !== "boolean" || ![data.writes, data.reads, data.checks, data.elapsed].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  return {phase:data.phase, writes:data.writes, reads:data.reads, checks:data.checks, elapsed:data.elapsed, uncertain:data.uncertain};
}

class Backend {
  constructor(command, {version, sourceRoot, env = process.env, timeout = 30000, onExit = () => {}, onShutdown = () => {}, onShutdownReady = () => {}}) {
    this.command = command; this.version = version; this.sourceRoot = sourceRoot;
    this.env = env; this.timeout = timeout; this.onExit = onExit; this.onShutdown = onShutdown; this.onShutdownReady = onShutdownReady;
    this.stopping = false; this.stopGeneration = 0;
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
      const timer = setTimeout(() => fail(startupError("startup.notReady", "Tagcast's local server did not become ready.")), this.timeout);
      const fail = error => {
        if (settled) return;
        settled = true; this.startFailed = true; clearTimeout(timer); this.stop(); reject(error);
      };
      this.exited = new Promise(done => {
        this.child.once("error", () => { fail(startupError("startup.couldNotStart", "Could not start Tagcast's local server.")); done({code:-1}); });
        this.child.once("exit", (code, signal) => {
          fail(startupError("startup.stoppedEarly", "Tagcast's local server stopped before it was ready."));
          done({code, signal});
          if (!this.stopping) this.onExit({code, signal});
        });
      });
      const lines = readline.createInterface({input: this.child.stdout});
      lines.on("line", line => {
        try {
          if (line.length > 8192) throw new Error();
          const data = JSON.parse(line);
          if (settled) {
            if (!this.control || !this.stopping) return;
            if (data.event === "resumed") {
              this.stopping = this.finishing = this.resuming = false;
              this.stopGeneration++;
              this.resolveStop?.({stopped:false});
              this.stopPromise = null;
            } else if (shutdownMessage(data)) {
              const status = shutdownMessage(data);
              try { this.onShutdown(status); } catch { /* feedback cannot prevent a safe drain */ }
              if (status.phase === "ready" && !this.finishing && !this.resuming) {
                this.finishing = true;
                const generation = this.stopGeneration;
                Promise.resolve(this.onShutdownReady(status)).then(approve => {
                  if (!this.stopping || this.resuming || generation !== this.stopGeneration) return;
                  if (approve === false) this.resume();
                  else this.child.stdin.end("finish\n");
                }).catch(() => { if (generation === this.stopGeneration) this.resume(); });
              }
            }
            return;
          }
          if (data.event === "error") throw startupError("startup.portBusy", "The server port is occupied or another Tagcast version is running. Close that instance and try again.");
          const ready = readyMessage(data, this.version);
          this.ready = ready; this.control = ready.owned && ready.shutdown_control === 1;
          settled = true; clearTimeout(timer); resolve(ready);
          if (this.stopping) this.requestStop();
        } catch (error) {
          fail(error instanceof SyntaxError ? startupError("startup.invalidResponse", "Invalid response from Tagcast's local server.") : error);
        }
      });
    });
  }

  stop() {
    if (this.stopPromise) { this.requestStop(); return this.stopPromise; }
    this.stopping = true; this.finishing = this.resuming = this.stopSent = false; this.stopGeneration++;
    this.stopPromise = new Promise(resolve => {
      this.resolveStop = resolve;
      (this.exited || Promise.resolve({})).then(exit => resolve({stopped:true, ...exit}));
    });
    this.requestStop();
    // No deadline kills a mutation/read-back. A controlled resume retains the same backend.
    return this.stopPromise;
  }

  requestStop() {
    // A close during startup must not end the control pipe before capabilities
    // arrive. A startup failure/timeout still sends legacy stop/EOF, never a kill.
    if (!this.stopSent && (this.ready || this.startFailed) && this.child?.stdin.writable && !this.child.stdin.writableEnded) {
      this.stopSent = true;
      if (this.control) this.child.stdin.write("drain\n");
      else this.child.stdin.end("stop\n");
    }
  }

  resume() {
    if (!this.control || !this.stopping || !this.child?.stdin.writable || this.child.stdin.writableEnded) return false;
    this.resuming = true;
    this.child.stdin.write("resume\n");
    return true;
  }

}

module.exports = {Backend, backendCommand, readyMessage, startupError, shutdownMessage};
