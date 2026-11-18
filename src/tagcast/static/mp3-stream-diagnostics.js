"use strict";

// Per-window opt-in. Only the existing stream and its local status read are used.
const mp3StreamDiagnostics = {enabled: false, session: "", active: null, recent: [], lastProblem: null};

function mp3StreamDiagnosticSession() {
  const d = mp3StreamDiagnostics, session = state.connection.playback_session || "";
  if (session !== d.session) {
    d.session = session;
    d.active = null;
    d.recent = [];
    d.lastProblem = null;
  }
  return session;
}

function mp3StreamDiagnosticAttempts() {
  mp3StreamDiagnosticSession();
  const {recent, lastProblem} = mp3StreamDiagnostics;
  const attempts = recent.filter(attempt => attempt.events.length);
  if (lastProblem && !attempts.includes(lastProblem)) attempts.unshift(lastProblem);
  return attempts;
}

function mp3StreamDiagnosticsPanel() {
  const ready = mp3StreamDiagnosticAttempts().length > 0;
  return `<section class="settings-section" data-settings-category="playback"><details class="settings-details">
    <summary>${TagcastI18n.html("mp3Diagnostics.heading")}</summary>
    <p class="muted">${TagcastI18n.html("mp3Diagnostics.note")}</p>
    <label class="checkline"><input type="checkbox" id="mp3-diagnostics-enabled" ${mp3StreamDiagnostics.enabled ? "checked" : ""}> ${TagcastI18n.html("mp3Diagnostics.collect")}</label>
    <button type="button" class="button small" id="mp3-diagnostics-download" ${ready ? "" : "disabled"}>${TagcastI18n.html("mp3Diagnostics.download")}</button>
  </details></section>`;
}

function beginMp3StreamDiagnostic(source, session, request, quality, libraryDuration) {
  const d = mp3StreamDiagnostics;
  mp3StreamDiagnosticSession();
  d.active = null;
  if (!d.enabled || !session || !request || !["96", "128", "192", "256", "320"].includes(quality)) return source;
  const url = source + "&diagnostic=1";
  const length = Number(libraryDuration);
  d.active = {url, request, session, quality: Number(quality), libraryDuration: Number.isFinite(length) && length > 0 ? length : null,
    started: performance.now(), events: [], http: null, status: null, lookup: null, problem: null, unknownWhilePlaying: false};
  d.recent.push(d.active);
  if (d.recent.length > 8) d.recent.shift();
  return url;
}

function mp3StreamDiagnosticNumber(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : String(value);
}

function mp3StreamDiagnosticRanges(ranges) {
  return Array.from({length: Math.min(ranges.length, 4)}, (_, i) =>
    [mp3StreamDiagnosticNumber(ranges.start(i)), mp3StreamDiagnosticNumber(ranges.end(i))]);
}

function mp3StreamDiagnosticUpdateButton() {
  const button = $("#mp3-diagnostics-download");
  if (button) button.disabled = !mp3StreamDiagnosticAttempts().length;
}

async function readMp3StreamDiagnosticResponse(attempt) {
  const query = new URLSearchParams({request: attempt.request, session: attempt.session});
  try {
    const response = await fetch(`/api/playback/stream-status?${query}`, {cache: "no-store", signal: AbortSignal.timeout(3000)});
    if (!response.ok) return;
    const result = await response.json();
    if (attempt.session === mp3StreamDiagnosticSession()) {
      attempt.http = result.first_response ?? null;
      attempt.status = result.state ?? null;
    }
  } catch { /* The media observations remain useful when the local status read fails. */ }
}

function mp3StreamDiagnosticEvent(kind) {
  const d = mp3StreamDiagnostics;
  mp3StreamDiagnosticSession();
  const attempt = d.active;
  if (!d.enabled || !attempt || !audio.src.endsWith(attempt.url)
    || (audio.currentSrc ? audio.currentSrc !== audio.src : kind !== "error")) return;
  if (kind === "timeupdate") {
    if (attempt.unknownWhilePlaying || audio.paused || audio.seeking || audio.currentTime < 5
      || Number.isFinite(audio.duration)) return;
    kind = "unknown-duration-during-playback";
    attempt.unknownWhilePlaying = true;
  }
  const snapshot = {
    event: kind, elapsed_ms: Math.round(performance.now() - attempt.started),
    duration_s: mp3StreamDiagnosticNumber(audio.duration), position_s: mp3StreamDiagnosticNumber(audio.currentTime),
    ready_state: audio.readyState, network_state: audio.networkState, seeking: audio.seeking,
    buffered_s: mp3StreamDiagnosticRanges(audio.buffered), seekable_s: mp3StreamDiagnosticRanges(audio.seekable),
    media_error: audio.error?.code ?? null,
  };
  if (attempt.events.length >= 24) attempt.events.splice(4, 1); // Keep startup observations as well as recent events.
  attempt.events.push(snapshot);
  if (kind === "unknown-duration-during-playback" || kind === "error") {
    attempt.problem = snapshot;
    d.lastProblem = attempt;
  }
  // A waiting event can arrive while the proxy is still waiting for HTTP headers.
  if (!attempt.lookup && (audio.readyState > 0 || kind === "error")) {
    attempt.lookup = readMp3StreamDiagnosticResponse(attempt);
  }
  if (attempt.events.length === 1) mp3StreamDiagnosticUpdateButton();
}

async function downloadMp3StreamDiagnostics() {
  const session = mp3StreamDiagnosticSession(), attempts = mp3StreamDiagnosticAttempts();
  if (!attempts.length) return;
  await Promise.all(attempts.map(attempt => attempt.lookup ??= readMp3StreamDiagnosticResponse(attempt)));
  if (session !== mp3StreamDiagnosticSession()) return;
  const versions = {};
  for (const name of ["Chrome", "Electron"]) {
    const match = navigator.userAgent.match(new RegExp(name + "/([0-9.]+)"));
    if (match) versions[name.toLowerCase()] = match[1];
  }
  const report = {schema: 1, versions, attempts: attempts.map(attempt => ({
    quality_kbps: attempt.quality, library_duration_s: attempt.libraryDuration,
    first_http_response: attempt.http, proxy_state: attempt.status,
    problem: attempt.problem, events: attempt.events,
  }))};
  const blob = new Blob([JSON.stringify(report, null, 2)], {type: "application/json"});
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url;
  link.download = "tagcast-mp3-stream-diagnostics.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

for (const name of ["durationchange", "loadedmetadata", "playing", "waiting", "stalled",
  "seeking", "seeked", "timeupdate", "error", "ended"]) {
  audio.addEventListener(name, () => mp3StreamDiagnosticEvent(name));
}
audio.addEventListener("emptied", mp3StreamDiagnosticUpdateButton);
document.addEventListener("change", event => {
  if (event.target.id !== "mp3-diagnostics-enabled") return;
  mp3StreamDiagnostics.enabled = event.target.checked;
  if (!mp3StreamDiagnostics.enabled) mp3StreamDiagnostics.active = null;
});
document.addEventListener("click", event => {
  if (event.target.id === "mp3-diagnostics-download") downloadMp3StreamDiagnostics();
});
