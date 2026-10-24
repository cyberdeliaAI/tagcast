"use strict";

// Isolated Electron experiment. The ordinary URL player is retained as a fallback.
const gaplessTrial = {enabled: true, active: null, bypass: false, offset: 0, message: "Gapless test ready", failures: new WeakMap()};
try { gaplessTrial.enabled = localStorage.getItem("tagcast-gapless-test") !== "off"; } catch { /* Local preference is optional. */ }
function gaplessFailed(entry, quality = player.quality) {
  const failure = gaplessTrial.failures.get(entry);
  return failure?.quality === quality && failure.session === state.connection.playback_session;
}
function gaplessFail(entry, g) { gaplessTrial.failures.set(entry, {quality: g.quality, session: g.session}); }
function gaplessSupported() {
  return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported('audio/mp4; codecs="flac"');
}
function gaplessSettings() {
  return `<section class="settings-section"><h3>Gapless playback · experimental</h3><label class="checkline"><input type="checkbox" id="gapless-test-enabled" ${gaplessTrial.enabled ? "checked" : ""} ${gaplessSupported() ? "" : "disabled"}> Enable gapless playback in this test app</label><p class="muted">Original FLAC is repackaged without changing its audio samples. MP3 with reliable encoder metadata is decoded to 24-bit PCM for playback. For a first test, choose Original streaming quality (Premium) and a continuous FLAC album. Only the current and next track are prepared; the first start can take longer. Unsupported files use standard playback. No crossfade or automatic silence removal is used.</p><p class="muted">The gapless time bar shows and seeks within the current track. The continuous buffer stays underneath; standard playback retains the native audio controls. Volume and playback speed are available through Playback options or Sound. Queue sync uses the standard player. Changes to this option apply on the next track.</p><p id="gapless-test-status" role="status">${escapeHtml(gaplessSupported() ? gaplessTrial.message : "Gapless buffering is unavailable in this browser; standard playback is retained.")}</p></section>`;
}
function gaplessNote(message) {
  gaplessTrial.message = message;
  const status = document.querySelector("#gapless-test-status"); if (status) status.textContent = message;
  renderStreamQuality();
  if (typeof gaplessRenderTransport === "function") gaplessRenderTransport();
  if (visualPlayer.open && gaplessTrial.active) $("#visual-player-status").textContent = message;
}
function gaplessPosition() {
  const g = gaplessTrial.active, s = g?.current;
  return s ? Math.max(0, Math.min(s.end - s.start, (audio.currentTime || 0) - s.start)) : Number(audio.currentTime) || 0;
}
function gaplessDuration() {
  const s = gaplessTrial.active?.current;
  return s ? s.end - s.start : audio.duration;
}
function gaplessSeek(position, fast = false) {
  const g = gaplessTrial.active;
  const target = (g?.current?.start || 0) + Math.max(0, Math.min(gaplessDuration(), position));
  if (fast && typeof audio.fastSeek === "function") audio.fastSeek(target); else audio.currentTime = target;
}
function gaplessCancel() {
  const g = gaplessTrial.active; gaplessTrial.active = null;
  if (!g) return;
  clearTimeout(g.timer); for (const controller of g.controllers) controller.abort();
  if (g.url) URL.revokeObjectURL(g.url);
  if (typeof gaplessRenderTransport === "function") gaplessRenderTransport();
}
function gaplessValid(g) {
  return gaplessTrial.active === g && live() && g.session === state.connection.playback_session
    && !(typeof queueSync !== "undefined" && queueSync.active);
}
function gaplessRetire(g) {
  if (gaplessTrial.active !== g) return;
  const position = gaplessPosition(), resume = g.started && !audio.paused;
  const sameSession = live() && g.session === state.connection.playback_session;
  gaplessCancel(); audio.pause(); audio.removeAttribute("src"); audio.load();
  if (sameSession && typeof queueSync !== "undefined" && queueSync.active && localPlaybackAllowed()) {
    gaplessTrial.bypass = true; gaplessTrial.offset = position;
    playCurrent(resume); gaplessTrial.bypass = false;
  }
}
function gaplessCandidate(g) {
  const index = player.queue.indexOf(g.current.entry);
  if (index < 0) return null;
  if (player.repeat === "track") return {entry: g.current.entry, wrap: false};
  if (index + 1 < player.queue.length) return {entry: player.queue[index + 1], wrap: false};
  const first = player.repeat === "queue" ? player.queue.find(t => !t.upNext) : null;
  return first ? {entry: first, wrap: true} : null;
}
async function gaplessRead(g, entry, controller) {
  const response = await fetch(`/api/stream/${encodeURIComponent(entry.id)}?quality=${g.quality}`, {signal: controller.signal, cache: "no-store"});
  if (!response.ok) throw new Error(`Audio returned HTTP ${response.status}.`);
  const max = 96 * 1024 ** 2, length = Number(response.headers.get("Content-Length"));
  if (length > max) { await response.body?.cancel(); throw new Error("Audio exceeds the 96 MiB trial file limit."); }
  const reader = response.body.getReader(), chunks = []; let count = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      count += value.length;
      if (count > max || !gaplessValid(g)) { await reader.cancel(); throw new Error("Gapless preparation was cancelled or exceeded its limit."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(count); let n = 0; for (const chunk of chunks) { bytes.set(chunk, n); n += chunk.length; }
  if (!gaplessValid(g) || controller.signal.aborted) throw new Error("Gapless preparation was cancelled.");
  let info;
  if (String.fromCharCode(...bytes.subarray(0, 4)) === "fLaC") info = gaplessMedia.parseFlac(bytes);
  else {
    const mp3 = gaplessMedia.mp3Info(bytes);
    const Decoder = typeof OfflineAudioContext !== "undefined" ? OfflineAudioContext : null;
    if (!Decoder) throw new Error("MP3 decoding is unavailable.");
    const context = new Decoder(mp3.channels, 1, mp3.rate), decoded = await context.decodeAudioData(bytes.buffer);
    if (!gaplessValid(g) || controller.signal.aborted) throw new Error("Gapless preparation was cancelled.");
    if (decoded.sampleRate !== mp3.rate || decoded.numberOfChannels !== mp3.channels || Math.abs(decoded.length - mp3.total) > 1) throw new Error("Decoded MP3 padding could not be confirmed; standard playback is used.");
    info = gaplessMedia.pcmFlac(decoded);
  }
  if (!gaplessValid(g) || controller.signal.aborted) throw new Error("Gapless preparation was cancelled.");
  return gaplessMedia.pack(info);
}
async function gaplessPrepare(g, entry) {
  if (g.current?.entry === entry && g.current.media) return g.current.media;
  const controller = new AbortController(); g.controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 60000);
  try { return await gaplessRead(g, entry, controller); }
  finally { clearTimeout(timeout); g.controllers.delete(controller); }
}
function gaplessFallback(g, reason) {
  if (!gaplessValid(g)) return;
  const position = g.current ? gaplessPosition() : g.offset || 0, entry = g.current?.entry || g.first;
  const playing = g.started ? !audio.paused : g.autoPlay;
  gaplessFail(entry, g); gaplessCancel();
  gaplessNote(`Standard playback: ${reason}`);
  gaplessTrial.bypass = true; gaplessTrial.offset = position;
  playCurrent(playing); gaplessTrial.bypass = false;
}
function gaplessQueueChanged() {
  const g = gaplessTrial.active;
  if (!g || !g.current || g.switching) return;
  if (!gaplessValid(g)) { gaplessRetire(g); return; }
  const quality = state.connection.premium ? lookup.streamQuality || "128" : "128";
  const wanted = gaplessTrial.enabled && quality === g.quality ? gaplessCandidate(g) : null, entry = wanted?.entry || null;
  if (entry === g.wanted && Boolean(wanted?.wrap) === g.wrap) return;
  g.wanted = entry; g.wrap = Boolean(wanted?.wrap); g.ticket += 1;
  for (const controller of g.controllers) controller.abort();
  if (g.next?.part > 0) g.trim = g.current.end;
  g.next = null; g.pending = false; g.finished = false;
  gaplessPrefetch(g); gaplessPump(g);
}
async function gaplessPrefetch(g) {
  if (!gaplessValid(g) || !g.current || !g.wanted || g.next || g.pending || state.loading || gaplessFailed(g.wanted, g.quality)) return;
  const entry = g.wanted, ticket = g.ticket; g.pending = true;
  try {
    const media = await gaplessPrepare(g, entry);
    if (!gaplessValid(g) || ticket !== g.ticket || entry !== g.wanted) return;
    if (media.key !== g.current.media.key) throw new Error("Adjacent audio formats differ; the next transition uses standard playback.");
    g.next = {entry, media, start: g.current.end, end: g.current.end + media.duration, part: 0, wrap: g.wrap};
    if (g.media.readyState === "open" && !g.buffer.updating) g.media.duration = g.next.end;
    gaplessNote("Gapless active · track-based controls"); gaplessPump(g);
  } catch (error) {
    if (gaplessValid(g) && ticket === g.ticket) { gaplessFail(entry, g); gaplessNote(`Gapless current track; next transition uses standard playback. ${error.message}`); }
  } finally { if (gaplessValid(g) && ticket === g.ticket) { g.pending = false; gaplessPump(g); } }
}
function gaplessPump(g) {
  if (!gaplessValid(g)) { if (gaplessTrial.active === g) gaplessRetire(g); return; }
  const sb = g.buffer;
  if (!sb || sb.updating || g.media.readyState === "closed" || !g.current) return;
  try {
    const end = g.next?.end || g.current.end;
    if (g.media.readyState === "open" && g.media.duration < end) g.media.duration = end;
    if (g.trim !== null) { const from = g.trim; g.trim = null; sb.remove(from, Math.max(from + .001, Number.isFinite(g.media.duration) ? g.media.duration + 1 : from + 10000)); return; }
    // Keep decoded media bounded, independently of queue length.
    const before = Math.max(0, audio.currentTime - 6);
    if (sb.buffered.length && sb.buffered.start(0) < before - 4) { sb.remove(0, before); return; }
    const segment = g.current.part < g.current.media.parts.length ? g.current : g.next;
    if (segment && segment.part < segment.media.parts.length) {
      const part = segment.media.parts[segment.part];
      if (segment.start + part.start > (audio.currentTime || 0) + 16 && g.started) return;
      sb.timestampOffset = segment.start; sb.appendWindowStart = 0; sb.appendWindowEnd = segment.end; sb.appendWindowStart = segment.start;
      sb.appendBuffer(part.data); segment.part += 1; g.finished = false; return;
    }
    if ((!g.wanted || gaplessFailed(g.wanted, g.quality)) && !g.pending && !g.finished && g.media.readyState === "open") {
      g.finished = true; g.media.endOfStream();
    }
  } catch (error) { gaplessFallback(g, `The continuous buffer could not be continued. ${error.message}`); }
}
function gaplessAdvance() {
  const g = gaplessTrial.active;
  if (!g || !g.current || !gaplessValid(g) || g.switching) return;
  if (audio.seeking) { gaplessPump(g); return; }
  if (g.next && audio.currentTime >= g.next.start - 1e-7) {
    g.switching = true;
    samplePlayback(); if (playReporting.watch) { playReporting.watch.active = false; playReporting.watch.completed = true; }
    const old = g.current;
    if (old.entry.upNext) { const i = player.queue.indexOf(old.entry); if (i >= 0) player.queue.splice(i, 1); }
    if (g.next.wrap) player.queue = player.queue.filter(t => !t.upNext);
    g.current = g.next; g.next = null; g.wanted = null; g.ticket += 1; g.pending = false;
    player.index = player.queue.indexOf(g.current.entry); player.album = g.current.entry.album;
    beginPlaybackWatch(!audio.paused);
    g.switching = false; renderCurrentPlayerTrack(); gaplessQueueChanged();
  }
  gaplessPump(g);
}
function gaplessBegin(entry, autoPlay) {
  gaplessCancel();
  if (gaplessTrial.bypass || !gaplessTrial.enabled || !gaplessSupported() || gaplessFailed(entry)
      || (typeof queueSync !== "undefined" && queueSync.active)) return false;
  audio.pause(); audio.removeAttribute("src"); audio.load(); playReporting.watch = null;
  const g = {session: state.connection.playback_session, quality: player.quality, first: entry, autoPlay, offset: gaplessTrial.offset,
    controllers: new Set(), current: null, next: null, wanted: null, wrap: false, ticket: 0, pending: false, trim: null, started: false, finished: false, switching: false};
  gaplessTrial.offset = 0; gaplessTrial.active = g; gaplessNote("Preparing gapless playback…");
  (async () => {
    try {
      const media = await gaplessPrepare(g, entry); if (!gaplessValid(g)) return;
      g.current = {entry, media, start: 0, end: media.duration, part: 0};
      g.media = new MediaSource(); g.url = URL.createObjectURL(g.media); audio.src = g.url;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Continuous audio did not open.")), 10000);
        g.media.addEventListener("sourceopen", () => { clearTimeout(timeout); resolve(); }, {once: true});
      });
      if (!gaplessValid(g)) return;
      g.buffer = g.media.addSourceBuffer('audio/mp4; codecs="flac"'); g.media.duration = media.duration;
      g.buffer.addEventListener("error", () => gaplessFallback(g, "The audio decoder rejected this continuous stream."));
      g.buffer.addEventListener("updateend", () => {
        if (!gaplessValid(g)) return;
        if (!g.started && g.current.part > 0) {
          g.started = true; if (g.offset) audio.currentTime = Math.min(g.offset, g.current.end);
          if (g.autoPlay) { beginPlaybackWatch(); audio.play().catch(() => { if (gaplessValid(g)) toast("Press Play in Tagcast to start the prepared audio."); }); }
          gaplessNote("Gapless active · track-based controls");
        }
        gaplessPump(g);
      });
      g.buffer.appendBuffer(media.init);
      gaplessQueueChanged();
      const tick = () => { if (!gaplessValid(g)) { if (gaplessTrial.active === g) gaplessRetire(g); return; } gaplessAdvance(); gaplessQueueChanged(); gaplessPrefetch(g); if (typeof gaplessRenderTransport === "function") gaplessRenderTransport(); g.timer = setTimeout(tick, 100); }; tick();
    } catch (error) { gaplessFallback(g, error.message); }
  })();
  return true;
}
function gaplessNativeSeek() {
  const g = gaplessTrial.active;
  if (!g?.current) return;
  const time = audio.currentTime;
  if (time < g.current.start) { audio.currentTime = g.current.start; return; }
  const buffered = g.buffer?.buffered;
  const present = buffered && Array.from({length: buffered.length}, (_, i) => i)
    .some(i => time >= buffered.start(i) && time < buffered.end(i));
  if (!present && time < g.current.end) {
    // Reuse the current file's encoded fragments for evicted/backward or unbuffered/forward seeks.
    // No refetch, source replacement or queue change is needed.
    const part = g.current.media.parts.findIndex(p => p.end > time - g.current.start);
    if (part >= 0) { g.current.part = part; g.finished = false; }
    // A backward seek must not retain arbitrarily distant decoded regions from earlier seeks.
    if (buffered?.length && buffered.end(buffered.length - 1) > time + 20) {
      g.trim = Math.min(g.trim ?? Infinity, time + 20);
      if (g.next) g.next.part = 0;
    }
  }
  gaplessPump(g);
}
function gaplessAudioError() {
  const g = gaplessTrial.active; if (!g) return false;
  gaplessFallback(g, "The continuous stream failed; the original player is used."); return true;
}
audio.addEventListener("seeking", gaplessNativeSeek);
audio.addEventListener("seeked", gaplessAdvance);
document.addEventListener("change", event => {
  if (event.target.id !== "gapless-test-enabled") return;
  gaplessTrial.enabled = event.target.checked;
  try { localStorage.setItem("tagcast-gapless-test", gaplessTrial.enabled ? "on" : "off"); } catch { /* Optional preference. */ }
  gaplessQueueChanged();
  gaplessNote(`${gaplessTrial.enabled ? "Gapless enabled" : "Standard playback selected"}; applies on the next track.`);
});
