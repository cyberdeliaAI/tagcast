"use strict";

// Optional listening-build instrumentation. No timers, network, storage or audio reads.
const gaplessDiagnostics = {enabled: false, events: [], dropped: 0, start: 0, started: null, generation: 0, restore: [], detach: null};
function gaplessDiagnosticsPanel() {
  return `<section class="settings-section" data-settings-category="playback"><details class="settings-details"><summary>Optional playback diagnostics</summary><p class="muted">For reporting a playback problem in Tagcast. Off each time you open the app. Records anonymous queue positions, preparation and buffer timings, player events and fallback categories. No track names, account details, stream URLs or music are recorded. The latest 2,000 events stay in memory until you explicitly download them or close the app.</p><label class="checkline"><input type="checkbox" id="gapless-diagnostics-enabled" ${gaplessDiagnostics.enabled ? "checked" : ""}> Collect playback diagnostics</label><button type="button" class="button small" id="gapless-diagnostics-download" ${gaplessDiagnostics.events.length ? "" : "disabled"}>Download diagnostics ↓</button><p id="gapless-diagnostics-status" role="status">${gaplessDiagnostics.enabled ? "Collecting anonymous playback events." : "Diagnostics are off."} Use Activity Monitor for total app memory.</p></details></section>`;
}
function gaplessDiagnosticEvent(kind, values = {}) {
  if (!gaplessDiagnostics.enabled || !["diagnostics-enabled", "diagnostics-disabled", "prepare-start", "prepare-ready", "prepare-failed", "track-boundary", "fallback", "buffer-append", "buffer-remove", "buffer-exception", "buffer-update", "buffer-error", "source-buffer-created", "sourceopen", "sourceended", "sourceclose", ...["play", "playing", "pause", "waiting", "stalled", "seeking", "seeked", "ended", "error", "ratechange", "emptied"].map(name => "audio-" + name)].includes(kind)) return;
  // Never serialize arbitrary objects, exception messages, identifiers or URLs.
  const row = {event: kind, ms: Math.round(performance.now() - gaplessDiagnostics.start)};
  for (const key of ["slot", "nextSlot", "elapsedMs", "bytes", "sampleRate", "channels", "bits", "maxBlock", "duration", "position", "bufferedSeconds", "ranges", "playbackRate"]) {
    if (typeof values[key] === "number" && Number.isFinite(values[key])) row[key] = Math.round(Math.max(0, Math.min(1e12, values[key])) * 1000) / 1000;
  }
  for (const key of ["paused", "ready", "gapless"]) if (typeof values[key] === "boolean") row[key] = values[key];
  if (["quota", "memory-limit", "format", "prepare-timeout", "no-progress", "decoder", "other"].includes(values.cause)) row.cause = values.cause;
  if (gaplessDiagnostics.events.length >= 2000) { gaplessDiagnostics.events.splice(0, 100); gaplessDiagnostics.dropped += 100; }
  gaplessDiagnostics.events.push(row);
}
function gaplessDiagnosticCause(reason) {
  const text = String(reason || "").toLowerCase();
  return /quota/.test(text) ? "quota" : /memory|budget|fit/.test(text) ? "memory-limit" : /block|format|sample rate|compatible|supported|encoder/.test(text) ? "format" : /took too long|timeout|timed out|preparation/.test(text) ? "prepare-timeout" : /progress/.test(text) ? "no-progress" : /decoder|decode/.test(text) ? "decoder" : "other";
}
function gaplessDiagnosticSlot(entry) { return typeof player !== "undefined" ? player.queue.indexOf(entry) + 1 : 0; }
function gaplessDiagnosticAudio() {
  const g = gaplessTrial.active;
  return {slot: gaplessDiagnosticSlot(g?.current?.entry || player.queue[player.index]), position: audio.currentTime,
    duration: audio.duration, paused: audio.paused, playbackRate: audio.playbackRate, gapless: Boolean(g), ready: Boolean(g?.ready)};
}
function gaplessDiagnosticRanges(buffer) {
  try {
    let seconds = 0;
    for (let i = 0; i < buffer.buffered.length; i++) seconds += buffer.buffered.end(i) - buffer.buffered.start(i);
    return {bufferedSeconds: seconds, ranges: buffer.buffered.length};
  } catch { return {}; }
}
function gaplessDiagnosticWrap(object, key, make, restorers) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key), original = object[key], wrapped = make(original);
  object[key] = wrapped;
  restorers.push(() => {
    if (object[key] !== wrapped) return;
    if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key];
  });
}
function gaplessDiagnosticBuffer(source, buffer) {
  gaplessDiagnostics.detach?.();
  const restore = [], listeners = [];
  let operation = null;
  function listen(target, name, callback) {
    target.addEventListener(name, callback); listeners.push(() => target.removeEventListener(name, callback));
  }
  for (const name of ["appendBuffer", "remove"]) gaplessDiagnosticWrap(buffer, name, original => function(...args) {
    operation = {at: performance.now(), bytes: name === "appendBuffer" ? args[0]?.byteLength : 0};
    gaplessDiagnosticEvent(name === "appendBuffer" ? "buffer-append" : "buffer-remove", {bytes: operation.bytes, ...gaplessDiagnosticAudio()});
    try { return original.apply(this, args); }
    catch (error) { gaplessDiagnosticEvent("buffer-exception", {cause: error?.name === "QuotaExceededError" ? "quota" : "other"}); throw error; }
  }, restore);
  listen(buffer, "updateend", () => {
    gaplessDiagnosticEvent("buffer-update", {elapsedMs: operation ? performance.now() - operation.at : 0, ...gaplessDiagnosticRanges(buffer)}); operation = null;
  });
  listen(buffer, "error", () => gaplessDiagnosticEvent("buffer-error", {cause: "decoder"}));
  for (const name of ["sourceopen", "sourceended", "sourceclose"]) listen(source, name, () => gaplessDiagnosticEvent(name));
  // Retain only the current SourceBuffer, never every engine from a long session.
  gaplessDiagnostics.detach = () => { listeners.forEach(remove => remove()); restore.reverse().forEach(undo => undo()); gaplessDiagnostics.detach = null; };
}
function gaplessDiagnosticsSet(enabled) {
  if (enabled === gaplessDiagnostics.enabled) return;
  const d = gaplessDiagnostics;
  if (!enabled) {
    gaplessDiagnosticEvent("diagnostics-disabled"); d.enabled = false; d.generation += 1;
    d.detach?.(); d.restore.reverse().forEach(undo => undo()); d.restore = []; return;
  }
  d.events = []; d.dropped = 0; d.start = performance.now(); d.started = new Date().toISOString(); d.generation += 1; d.enabled = true;
  const generation = d.generation;
  // Function declarations are shared bindings. Restore the exact original functions on stop.
  const prepare = gaplessPrepare, advance = gaplessAdvance, fallback = gaplessFallback, cancel = gaplessCancel;
  const wrappedPrepare = function(g, entry) {
    const at = performance.now(), slot = gaplessDiagnosticSlot(entry);
    gaplessDiagnosticEvent("prepare-start", {slot});
    return prepare(g, entry).then(media => {
      if (d.enabled && d.generation === generation) gaplessDiagnosticEvent("prepare-ready", {slot, elapsedMs: performance.now() - at, bytes: media.bytes, duration: media.duration, sampleRate: media.rate, channels: media.channels, bits: media.bits, maxBlock: media.maxBlock});
      return media;
    }, error => {
      if (d.enabled && d.generation === generation) gaplessDiagnosticEvent("prepare-failed", {slot, elapsedMs: performance.now() - at, cause: gaplessDiagnosticCause(error?.message)});
      throw error;
    });
  };
  const wrappedAdvance = function(...args) {
    const before = gaplessTrial.active?.current, slot = gaplessDiagnosticSlot(before?.entry);
    const result = advance(...args), after = gaplessTrial.active?.current;
    if (before && after && before !== after) gaplessDiagnosticEvent("track-boundary", {slot, nextSlot: gaplessDiagnosticSlot(after.entry), position: audio.currentTime});
    return result;
  };
  const wrappedFallback = function(g, reason) { gaplessDiagnosticEvent("fallback", {cause: gaplessDiagnosticCause(reason), ...gaplessDiagnosticAudio()}); return fallback(g, reason); };
  const wrappedCancel = function(...args) { const result = cancel(...args); d.detach?.(); return result; };
  gaplessPrepare = wrappedPrepare; gaplessAdvance = wrappedAdvance; gaplessFallback = wrappedFallback; gaplessCancel = wrappedCancel;
  d.restore.push(() => { if (gaplessPrepare === wrappedPrepare) gaplessPrepare = prepare; if (gaplessAdvance === wrappedAdvance) gaplessAdvance = advance; if (gaplessFallback === wrappedFallback) gaplessFallback = fallback; if (gaplessCancel === wrappedCancel) gaplessCancel = cancel; });
  if (typeof MediaSource !== "undefined") gaplessDiagnosticWrap(MediaSource.prototype, "addSourceBuffer", original => function(...args) {
    const buffer = original.apply(this, args); gaplessDiagnosticEvent("source-buffer-created"); gaplessDiagnosticBuffer(this, buffer); return buffer;
  }, d.restore);
  if (gaplessTrial.active?.buffer) gaplessDiagnosticBuffer(gaplessTrial.active.media, gaplessTrial.active.buffer);
  for (const name of ["play", "playing", "pause", "waiting", "stalled", "seeking", "seeked", "ended", "error", "ratechange", "emptied"]) {
    const callback = () => gaplessDiagnosticEvent("audio-" + name, gaplessDiagnosticAudio());
    audio.addEventListener(name, callback); d.restore.push(() => audio.removeEventListener(name, callback));
  }
  gaplessDiagnosticEvent("diagnostics-enabled", gaplessDiagnosticAudio());
}
function gaplessDiagnosticsReport() {
  const versions = {};
  for (const name of ["Electron", "Chrome"]) {
    const match = (navigator.userAgent || "").match(new RegExp(name + "/([0-9.]+)")); if (match) versions[name.toLowerCase()] = match[1];
  }
  return {schema: 1, started: gaplessDiagnostics.started, versions, enabled: gaplessDiagnostics.enabled,
    dropped: gaplessDiagnostics.dropped, events: gaplessDiagnostics.events.slice()};
}
function gaplessDiagnosticsDownload() {
  if (!gaplessDiagnostics.events.length) return;
  const blob = new Blob([JSON.stringify(gaplessDiagnosticsReport(), null, 2)], {type: "application/json"}), url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = "tagcast-playback-diagnostics.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.addEventListener("change", event => {
  if (event.target.id !== "gapless-diagnostics-enabled") return;
  gaplessDiagnosticsSet(event.target.checked);
  $("#gapless-diagnostics-download").disabled = !gaplessDiagnostics.events.length;
  $("#gapless-diagnostics-status").textContent = gaplessDiagnostics.enabled ? "Collecting anonymous playback events. Download after reproducing the problem." : "Collection stopped. You can download the retained events; enabling again starts a new log.";
});
document.addEventListener("click", event => { if (event.target.id === "gapless-diagnostics-download") gaplessDiagnosticsDownload(); });
