"use strict";

// Isolated Electron experiment. The ordinary URL player is retained as a fallback.
const gaplessTrial = {enabled: false, origins: new WeakMap(), active: null, bypass: false, offset: 0, message: "Gapless test ready", failures: new WeakMap()};
try { gaplessTrial.enabled = localStorage.getItem("tagcast-gapless-test") === "on"; } catch { /* Local preference is optional. */ }
// Only explicitly started, ordered album queues qualify; playlist/server rows never acquire this provenance.
function gaplessAlbumQueue(entries, ordered) {
  if (!ordered) return;
  const run = {length: entries.length};
  entries.forEach((entry, index) => gaplessTrial.origins.set(entry, {run, index}));
}
function gaplessAlbumEntry(entry) {
  return !player.shuffle && !entry?.upNext ? gaplessTrial.origins.get(entry) : null;
}
function gaplessFailed(entry, quality = player.quality) {
  const failure = gaplessTrial.failures.get(entry);
  return failure?.quality === quality && failure.session === state.connection.playback_session;
}
function gaplessFail(entry, g) { gaplessTrial.failures.set(entry, {quality: g.quality, session: g.session}); }
function gaplessSupported() {
  return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported('audio/mp4; codecs="flac"');
}
function gaplessSettings() {
  return `<section class="settings-section" data-settings-category="playback"><h3>Gapless playback <span class="settings-mode">Experimental · next track</span></h3><label class="checkline"><input type="checkbox" id="gapless-test-enabled" ${gaplessTrial.enabled ? "checked" : ""} ${gaplessSupported() ? "" : "disabled"}> Enable gapless playback for albums in order</label><p class="muted">Keep consecutive album tracks playing without an added pause. Off by default. Only for normal album order; not shuffle, Random Album, playlists or queue sync. Your choice is remembered in this browser and applies on the next track.</p><p class="muted">Starting an album can take longer. Forward seeking may show Preparing… while the current audio continues. Unsupported files use standard playback.</p><details class="settings-details"><summary>Supported audio and limitations</summary><p class="muted">Original FLAC is repackaged without changing its audio samples. MP3 needs reliable encoder metadata and is decoded to 24-bit PCM for playback. For a first test, choose Original streaming quality (Premium) and a continuous FLAC album. No crossfade or automatic silence removal is used.</p><p class="muted">The current track and the start of the next are prepared before playback begins. The track-based time bar keeps the continuous buffer underneath. Volume and playback speed remain available in Playback options or Sound. Slow connections and incompatible files can still interrupt playback; this experiment does not guarantee uninterrupted output for every file or device.</p></details><p id="gapless-test-status" role="status">${escapeHtml(gaplessSupported() ? gaplessTrial.message : "Gapless buffering is unavailable in this browser; standard playback is retained.")}</p></section>`;
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
function gaplessBuffered(g, time, extent = 0) {
  const ranges = g.buffer?.buffered;
  for (let i = 0; ranges && i < ranges.length; i++) {
    if (ranges.start(i) <= time + 1e-5 && ranges.end(i) >= time + extent - 1e-5) return true;
  }
  return false;
}
function gaplessBoundaryReady(g) {
  if (!g.wanted || gaplessFailed(g.wanted, g.quality)) return true;
  return Boolean(g.next?.entry === g.wanted && gaplessBuffered(g, g.next.start, Math.min(.05, (g.next.media.parts?.[0]?.end || g.next.media.duration) / 2)));
}
function gaplessApplySeek(g, position, fast) {
  const target = (g?.current?.start || 0) + Math.max(0, Math.min(gaplessDuration(), position));
  if (fast && typeof audio.fastSeek === "function") audio.fastSeek(target); else audio.currentTime = target;
}
function gaplessSeek(position, fast = false) {
  const g = gaplessTrial.active;
  if (g) g.seekIntent = null;
  if (g?.current && position > gaplessPosition() + .05 && !gaplessBoundaryReady(g)) {
    g.seekIntent = {engine: g, segment: g.current, position, fast};
    gaplessNote("Preparing the next album track before seeking…");
    gaplessPrefetch(g); gaplessPump(g); return;
  }
  gaplessApplySeek(g, position, fast);
}
function gaplessReadiness(g) {
  if (!gaplessValid(g) || !g.started || g.buffer?.updating) return;
  if (g.ready === false && gaplessBoundaryReady(g)) {
    g.ready = true;
    if (g.autoPlay) { beginPlaybackWatch(); audio.play().catch(() => { if (gaplessValid(g)) toast("Press Play in Tagcast to start the prepared audio."); }); }
    gaplessNote(g.nextProblem ? `Gapless current track; next uses standard playback. ${g.nextProblem}` : "Gapless active · track-based controls");
  }
  const intent = g.seekIntent;
  if (intent && intent.segment !== g.current) { g.seekIntent = null; return; }
  if (intent && gaplessBoundaryReady(g)) {
    g.seekIntent = null; gaplessApplySeek(g, intent.position, intent.fast);
    gaplessNote(g.nextProblem ? `Gapless current track; next uses standard playback. ${g.nextProblem}` : "Gapless active · track-based controls");
  }
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
  const entry = g.current.entry, origin = gaplessAlbumEntry(entry), index = player.queue.indexOf(entry);
  if (index < 0 || !origin) return null;
  if (player.repeat === "track") return {entry, wrap: false};
  const next = player.queue[index + 1], following = gaplessAlbumEntry(next);
  if (following?.run === origin.run && following.index === origin.index + 1) return {entry: next, wrap: false};
  if (index + 1 < player.queue.length) return null;
  const first = player.repeat === "queue" ? player.queue.find(t => !t.upNext) : null, start = gaplessAlbumEntry(first);
  return start?.run === origin.run && start.index === 0 && origin.index === origin.run.length - 1 ? {entry: first, wrap: true} : null;
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
  g.next = null; g.pending = false; g.finished = false; g.nextProblem = "";
  gaplessPrefetch(g); gaplessPump(g);
}
async function gaplessPrefetch(g) {
  if (!gaplessValid(g) || !g.current || !g.wanted || g.next || g.pending || state.loading || gaplessFailed(g.wanted, g.quality)) return;
  const entry = g.wanted, ticket = g.ticket; g.pending = true;
  try {
    const media = await gaplessPrepare(g, entry);
    if (!gaplessValid(g) || ticket !== g.ticket || entry !== g.wanted) return;
    if (media.maxBlock > g.maxBlock) throw new Error("The next FLAC needs larger decoder blocks; standard playback is used at the boundary.");
    if (media.key !== g.current.media.key) throw new Error("Adjacent audio formats differ; the next transition uses standard playback.");
    g.byteRate = Math.max(g.byteRate || 0, media.byteRate || 0);
    g.next = {entry, media, start: g.current.end, end: g.current.end + media.duration, part: 0, wrap: g.wrap};
    if (g.media.readyState === "open" && !g.buffer.updating) g.media.duration = g.next.end;
    gaplessNote(g.ready === false ? "Preparing the next album track…" : "Gapless active · track-based controls"); gaplessPump(g);
  } catch (error) {
    if (gaplessValid(g) && ticket === g.ticket) { gaplessFail(entry, g); g.nextProblem = error.message; gaplessNote(`Gapless current track; next transition uses standard playback. ${error.message}`); }
  } finally { if (gaplessValid(g) && ticket === g.ticket) { g.pending = false; gaplessPump(g); } }
}
// Conservative coded-byte estimate, not decoded PCM/RSS or a Chromium quota override.
// Peak fragment density bounds retained ranges even after a higher-rate fragment is evicted.
function gaplessBufferPolicy(g) {
  const bytes = 6 * 1024 ** 2, rate = Math.max(1, g.byteRate || 65536);
  const reserve = Math.min(bytes / 2, Math.max(512 * 1024, g.current?.media.maxPartBytes || 0, g.next?.media.maxPartBytes || 0));
  return {bytes, rate, ahead: Math.max(.05, Math.min(16, (bytes - reserve) * .6 / rate)), behind: Math.min(6, (bytes - reserve) * .2 / rate)};
}
function gaplessBufferedBytes(g, policy) {
  const ranges = g.buffer.buffered; let seconds = 0;
  for (let i = 0; i < ranges.length; i++) seconds += ranges.end(i) - ranges.start(i);
  return seconds * policy.rate;
}
function gaplessPump(g) {
  if (!gaplessValid(g)) { if (gaplessTrial.active === g) gaplessRetire(g); return; }
  const sb = g.buffer;
  if (!sb || sb.updating || g.media.readyState === "closed" || !g.current) return;
  try {
    const end = g.next?.end || g.current.end, policy = gaplessBufferPolicy(g);
    if (g.media.readyState === "open" && g.media.duration < end) g.media.duration = end;
    if (g.trim !== null) { const from = g.trim; g.trim = null; g.finished = false; sb.remove(from, Math.max(from + .001, Number.isFinite(g.media.duration) ? g.media.duration + 1 : from + 10000)); return; }
    // Bound coded retention by both time and peak encoded fragment density.
    const before = Math.max(0, audio.currentTime - policy.behind);
    if (sb.buffered.length && sb.buffered.start(0) < before - Math.min(4, policy.behind / 2)) { g.finished = false; sb.remove(0, before); return; }
    // The next track's first fragment stays primed even after a seek far ahead or back.
    const primeNext = g.started && g.next && !gaplessBuffered(g, g.next.start, Math.min(.05, (g.next.media.parts?.[0]?.end || g.next.media.duration) / 2));
    if (primeNext && g.next.part > 0) g.next.part = 0;
    const segment = primeNext ? g.next : g.current.part < g.current.media.parts.length ? g.current : g.next;
    if (segment && segment.part < segment.media.parts.length) {
      const part = segment.media.parts[segment.part];
      if (!primeNext && segment.start + part.start > (audio.currentTime || 0) + policy.ahead && g.started) return;
      if (part.data.byteLength > policy.bytes) { gaplessFallback(g, "An audio fragment exceeds the trial buffer budget."); return; }
      if (gaplessBufferedBytes(g, policy) + part.data.byteLength > policy.bytes) {
        if (primeNext && !g.ready) gaplessFallback(g, "The next audio fragment cannot fit before playback; using standard playback.");
        return; // Resume pumping as playback frees old data; never spin on append failures.
      }
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
    g.seekIntent = null;
    player.index = player.queue.indexOf(g.current.entry); player.album = g.current.entry.album;
    beginPlaybackWatch(!audio.paused);
    g.switching = false; renderCurrentPlayerTrack(); gaplessQueueChanged();
  }
  gaplessPump(g);
}
// A decoder can wait forever without firing error; recover once through the normal player.
// Pauses, seeks and startup holds are not evidence of a stalled playing timeline.
function gaplessWatch(g, now = performance.now()) {
  if (!gaplessValid(g)) return;
  const time = audio.currentTime || 0, progress = g.progress;
  if (!progress || !g.ready || audio.paused || audio.seeking || audio.ended
      || time < progress.time || time > progress.time + .01) {
    g.progress = {time, at: now}; return;
  }
  if (now - progress.at >= 8000) gaplessFallback(g, "Continuous playback stopped progressing; continuing with standard playback.");
}
function gaplessBegin(entry, autoPlay) {
  gaplessCancel();
  if (gaplessTrial.bypass || !gaplessTrial.enabled || !gaplessAlbumEntry(entry) || !gaplessSupported() || gaplessFailed(entry)
      || (typeof queueSync !== "undefined" && queueSync.active)) return false;
  audio.pause(); audio.removeAttribute("src"); audio.load(); playReporting.watch = null;
  const g = {session: state.connection.playback_session, quality: player.quality, first: entry, autoPlay, offset: gaplessTrial.offset,
    controllers: new Set(), current: null, next: null, wanted: null, wrap: false, ticket: 0, pending: false, trim: null, started: false, finished: false, switching: false, ready: false, seekIntent: null};
  gaplessTrial.offset = 0; gaplessTrial.active = g; gaplessNote("Preparing gapless playback…");
  (async () => {
    try {
      const media = await gaplessPrepare(g, entry); if (!gaplessValid(g)) return;
      g.current = {entry, media, start: 0, end: media.duration, part: 0}; g.maxBlock = media.maxBlock; g.byteRate = media.byteRate;
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
          gaplessNote(g.wanted && !gaplessBoundaryReady(g) ? "Preparing the next album track…" : "Gapless active · track-based controls");
        }
        gaplessReadiness(g); gaplessPump(g);
      });
      g.buffer.appendBuffer(media.init);
      gaplessQueueChanged();
      const tick = () => { if (!gaplessValid(g)) { if (gaplessTrial.active === g) gaplessRetire(g); return; } gaplessAdvance(); gaplessQueueChanged(); gaplessPrefetch(g); gaplessReadiness(g); gaplessWatch(g); if (typeof gaplessRenderTransport === "function") gaplessRenderTransport(); if (gaplessValid(g)) g.timer = setTimeout(tick, 100); }; tick();
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
