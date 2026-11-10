"use strict";

// One ordinary-player restart coordinator. Gapless retains its own engine/fallback.
// The status read inspects the existing proxy request; it never probes upstream audio.
const audioRecovery = {generation: 0, pending: null, failed: null, networkUsed: false, intent: false, closing: false, holdEnded: false};

function audioRecoveryCurrent(record = audioRecovery.pending || audioRecovery.failed) {
  return record && !audioRecovery.closing && record.generation === audioRecovery.generation
    && record.entry === player.queue[player.index] && record.details === state.details
    && record.session === state.connection.playback_session && record.quality === player.quality
    && live() && !state.loading && (typeof localPlaybackAllowed !== "function" || localPlaybackAllowed()) ? record : null;
}
function audioRecoveryPaused() {
  const record = audioRecoveryCurrent();
  return record ? !record.wantsPlay : audio.paused;
}
function audioRecoveryPosition() { return audioRecoveryCurrent()?.position; }
function audioRecoveryDuration() { return audioRecoveryCurrent()?.duration; }

function clearAudioRecovery() {
  const record = audioRecovery.pending;
  if (record) { clearTimeout(record.timer); clearTimeout(record.deadline); record.controller.abort(); }
  audioRecovery.pending = null; audioRecovery.failed = null;
}
function selectAudioRecovery(autoPlay) {
  clearAudioRecovery(); audioRecovery.generation++;
  audioRecovery.holdEnded = false;
  audioRecovery.intent = autoPlay;
  // A Gapless failure has already chosen its one ordinary-source fallback.
  audioRecovery.networkUsed = Boolean(typeof gaplessTrial !== "undefined" && gaplessTrial.bypass);
}
function normalStreamUrl(track, quality) {
  const base = `/api/stream/${encodeURIComponent(track.id)}?quality=${quality}`;
  const session = state.connection.playback_session;
  player.streamRequest = session ? globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}` : "";
  return session ? `${base}&request=${encodeURIComponent(player.streamRequest)}&session=${encodeURIComponent(session)}` : base;
}
function renderAudioRecovery() {
  if (typeof gaplessRenderTransport === "function") gaplessRenderTransport();
  if (typeof syncSystemPlayback === "function") syncSystemPlayback();
  if (typeof publishMiniPlayer === "function") publishMiniPlayer();
}
function freezeAudioReporting() {
  samplePlayback();
  if (playReporting.watch) playReporting.watch.active = false;
}
function finishAudioRecovery(record, success) {
  if (audioRecovery.pending !== record) return;
  const current = audioRecoveryCurrent(record);
  clearTimeout(record.timer); clearTimeout(record.deadline); record.controller.abort();
  audioRecovery.pending = null;
  if (!current) { audioRecovery.failed = null; return; }
  audioRecovery.failed = success ? null : record;
  player.continuing = false;
  if (!success) {
    record.wantsPlay = false; audioRecovery.intent = false;
    freezeAudioReporting(); audio.pause();
  }
  const key = success ? "player.error.recovered" : record.failureKey || "player.error.recoveryFailed";
  toast(TagcastI18n.text(key));
  if (visualPlayer.open) setVisualPlayerStatus(success ? null : () => TagcastI18n.text(key));
  renderAudioRecovery();
}
function audioRecoveryReady() {
  const record = audioRecovery.pending;
  if (!record || record.stage !== "loading" || !record.metadata) return false;
  if (!audioRecoveryCurrent(record)) { clearAudioRecovery(); return false; }
  if (audio.error || audio.seeking || audio.readyState < 2 || Math.abs(audio.currentTime - record.position) > .25) return false;
  if (record.duration > 0 && record.position >= record.duration) {
    record.wantsPlay = false; audioRecovery.intent = false;
  }
  if (!record.wantsPlay) { audio.pause(); finishAudioRecovery(record, true); return true; }
  if (!record.playRequested) {
    record.playRequested = true;
    const serial = ++record.playSerial;
    audio.play().catch(() => {
      if (audioRecoveryCurrent(record) && record.wantsPlay && record.playSerial === serial) {
        if (player.quality === "orig" && !player.fallback && [3, 4].includes(audio.error?.code)) recoverAudio(audio.error.code);
        else finishAudioRecovery(record, false);
      }
    });
  }
  return false; // Only the actual playing event confirms resumed playback.
}
function audioRecoveryPlaying() {
  const record = audioRecovery.pending;
  if (!record) { audioRecovery.holdEnded = false; return true; }
  if (!audioRecoveryCurrent(record)) { clearAudioRecovery(); return false; }
  if (!record.wantsPlay) { audio.pause(); audioRecoveryReady(); return false; }
  if (record.stage !== "loading" || !record.metadata || audio.seeking || Math.abs(audio.currentTime - record.position) > .25) return false;
  finishAudioRecovery(record, true);
  audioRecovery.holdEnded = false;
  return true;
}
function audioRecoverySeek(position) {
  const record = audioRecoveryCurrent();
  if (!record) return false;
  record.position = Math.max(0, Math.min(record.duration, position));
  const prepared = record === audioRecovery.failed && !audio.error && audio.getAttribute("src") && audio.readyState >= 2;
  if (record === audioRecovery.pending && record.metadata || prepared) {
    record.playSerial++; record.playRequested = false; audio.currentTime = record.position; audioRecoveryReady();
  }
  renderAudioRecovery(); return true;
}
function audioRecoveryIntent(wantsPlay) {
  audioRecovery.intent = wantsPlay;
  const record = audioRecoveryCurrent();
  if (record) {
    const changed = record.wantsPlay !== wantsPlay;
    record.wantsPlay = wantsPlay;
    if (record === audioRecovery.pending) {
      if (changed) { record.playSerial++; record.playRequested = false; }
      audioRecoveryReady();
    }
    renderAudioRecovery();
  }
}

function recoverAudio(code, manual = false) {
  const previous = audioRecoveryCurrent();
  if (audioRecovery.pending) {
    if (audioRecovery.pending.stage !== "loading") return true; // Coalesce duplicate error events.
    if (!(player.quality === "orig" && !player.fallback && [3, 4].includes(code))) {
      finishAudioRecovery(audioRecovery.pending, false); return true;
    }
    clearAudioRecovery(); // A confirmed decode failure may still take the existing quality fallback.
  } else if (!manual && audioRecovery.failed) return true;
  if (!manual && code !== 2 && code !== 4 && !(code === 3 && player.quality === "orig" && !player.fallback)) return false;
  const entry = player.queue[player.index], session = state.connection.playback_session;
  if (!entry || !session || !player.streamRequest || audioRecovery.closing || !live() || state.loading
    || (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed())) return false;
  freezeAudioReporting();
  const record = {entry, details: state.details, session, generation: audioRecovery.generation,
    quality: player.quality, request: player.streamRequest, code, stage: "checking", controller: new AbortController(),
    position: previous?.position ?? Math.max(0, Number(audio.currentTime) || 0),
    duration: previous?.duration ?? (Number.isFinite(audio.duration) ? audio.duration : Number(entry.length) || 0),
    rate: audio.playbackRate || 1, wantsPlay: manual || audioRecovery.intent, reserved: !manual && code === 2, playSerial: 0};
  const exhausted = !manual && code === 2 && audioRecovery.networkUsed;
  if (record.reserved) audioRecovery.networkUsed = true;
  audioRecovery.pending = record; audioRecovery.failed = null;
  if (exhausted) { finishAudioRecovery(record, false); return true; }
  toast(TagcastI18n.text("player.error.reconnecting"));
  if (visualPlayer.open) setVisualPlayerStatus(() => TagcastI18n.text("player.error.reconnecting"));
  renderAudioRecovery();
  // This bounds recovery state only; normal streaming/proxy/Gapless timeouts are unchanged.
  record.deadline = setTimeout(() => {
    if (audioRecoveryCurrent(record) && record.stage === "loading") {
      audio.pause(); audio.removeAttribute("src"); audio.load();
    }
    finishAudioRecovery(record, false);
  }, 30000);
  record.run = async () => {
    if (audioRecovery.pending !== record) return;
    if (!audioRecoveryCurrent(record)) { clearAudioRecovery(); return; }
    if (navigator.onLine === false) { record.stage = "offline"; return; }
    try {
      const response = await fetch(`/api/playback/stream-status?request=${encodeURIComponent(record.request)}&session=${encodeURIComponent(session)}`,
        {signal: record.controller.signal, cache: "no-store"});
      if (!response.ok) throw Error("Playback status unavailable");
      const status = await response.json();
      if (audioRecovery.pending !== record) return;
      if (!audioRecoveryCurrent(record)) { if (audioRecovery.pending === record) clearAudioRecovery(); return; }
      if (status.state === "auth") record.failureKey = "errors.account.not_connected";
      else if (["security", "unavailable"].includes(status.state)) record.failureKey = "player.error.trackStatus";
      if (["auth", "security", "unavailable"].includes(status.state) || !["network", "available", "unknown"].includes(status.state)) throw Error("Playback cannot be recovered");
      if (status.state === "unknown" && code !== 3 && !manual) throw Error("Playback outcome is unknown");
      const network = code === 2 || status.state === "network";
      if (network) {
        if (!manual && audioRecovery.networkUsed && !record.reserved) throw Error("Recovery exhausted");
        audioRecovery.networkUsed = true;
      } else if (!manual && player.quality === "orig" && !player.fallback && [3, 4].includes(code)) {
        player.fallback = true; player.quality = record.quality = "128";
        toast(TagcastI18n.text("player.error.originalFallback"));
      } else if (!manual) throw Error("Not a network error");
      record.stage = "loading";
      audioRecovery.holdEnded = true;
      const source = normalStreamUrl(entry, record.quality); record.request = player.streamRequest;
      audio.src = source; audio.load(); audio.playbackRate = record.rate;
      renderStreamQuality(); renderAudioRecovery();
    } catch {
      if (audioRecovery.pending === record) finishAudioRecovery(record, false);
    }
  };
  record.timer = setTimeout(record.run, manual ? 0 : 500);
  return true;
}

audio.addEventListener("loadedmetadata", () => {
  if (audio.currentSrc && audio.currentSrc !== audio.src) return;
  const record = audioRecovery.pending;
  if (!record) { player.continuing = false; return; }
  if (!audioRecoveryCurrent(record) || record.stage !== "loading" || audio.error
    || audio.currentSrc && audio.currentSrc !== audio.src) return;
  record.metadata = true;
  record.duration = Number.isFinite(audio.duration) ? audio.duration : record.duration;
  record.position = Math.min(record.position, record.duration || record.position);
  audio.currentTime = record.position;
  audioRecoveryReady();
});
for (const name of ["seeked", "canplay"]) audio.addEventListener(name, audioRecoveryReady);
audio.addEventListener("play", () => { if (!audioRecovery.pending) audioRecovery.intent = true; });
audio.addEventListener("pause", () => {
  if (!audio.error && !audioRecovery.pending) audioRecovery.intent = false;
});
function closeAudioRecovery() {
  audioRecovery.closing = true; clearAudioRecovery(); freezeAudioReporting(); audio.pause();
}
window.addEventListener("pagehide", closeAudioRecovery);
window.addEventListener("pageshow", () => { audioRecovery.closing = false; });
window.addEventListener("tagcast-playback-shutdown", closeAudioRecovery);
window.addEventListener("tagcast-playback-resume", () => { audioRecovery.closing = false; });
window.addEventListener("online", () => {
  const record = audioRecovery.pending;
  if (record?.stage === "offline" && audioRecoveryCurrent(record)) {
    record.stage = "checking"; record.run();
  }
});
