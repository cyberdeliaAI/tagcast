"use strict";

// Local output selection and system controls share the player's one audio element.
const playbackOutput = {devices: [], names: new Map(), read: 0, opened: 0, busy: false, focus: null, airplay: null, volumeLimited: false};
const systemPlayback = {session: null, installed: false, metadata: "", positionAt: -Infinity};

function systemPlaybackTrack() {
  return live() && !state.loading && (typeof localPlaybackAllowed !== "function" || localPlaybackAllowed()) && audio.getAttribute("src") && !audio.error
    ? player.queue[player.index] : null;
}

function playbackOutputCapabilities() {
  const sink = typeof audio.setSinkId === "function";
  return {sink, choose: sink && typeof navigator.mediaDevices?.selectAudioOutput === "function",
    list: sink && typeof navigator.mediaDevices?.enumerateDevices === "function",
    airplay: typeof audio.webkitShowPlaybackTargetPicker === "function"};
}

function playbackOutputName() {
  if (audio.webkitCurrentPlaybackTargetIsWireless) return "AirPlay";
  const id = audio.sinkId || "";
  return !id || id === "default" ? "System default" : playbackOutput.names.get(id) || "Selected output";
}

function renderPlaybackVolume() {
  const percent = Math.round((Number.isFinite(audio.volume) ? audio.volume : 1) * 100);
  const value = `${percent}%${audio.muted ? ", muted" : ""}`;
  $("#player-output").title = `Volume: ${value} · Output: ${playbackOutputName()}`;
  $("#player-output").setAttribute("aria-label", `Volume and audio output: ${value}`);
  $("#audio-volume").value = String(percent);
  $("#audio-volume").setAttribute("aria-valuetext", value);
  $("#audio-volume-value").textContent = `${percent}%`;
  $("#audio-mute").textContent = audio.muted ? "Unmute" : "Mute";
  $("#audio-mute").setAttribute("aria-pressed", String(Boolean(audio.muted)));
  $("#audio-volume-note").textContent = playbackOutput.volumeLimited
    ? "This browser or output controls volume through your system or device."
    : "Player volume only. Your system or speaker may also have its own volume control.";
}

function changePlaybackVolume(value) {
  if (!$("#audio-output-dialog").open || !systemPlaybackTrack()) return;
  const percent = Number(value);
  if (!Number.isFinite(percent)) return;
  const volume = Math.max(0, Math.min(100, percent)) / 100;
  try {
    audio.volume = volume;
    if (volume > 0) audio.muted = false;
    playbackOutput.volumeLimited = Math.abs(audio.volume - volume) > 0.001;
  } catch { playbackOutput.volumeLimited = true; }
  renderPlaybackVolume(); // Read the real value, including outputs that reject changes.
}

function renderPlaybackOutput() {
  const name = playbackOutputName(), capabilities = playbackOutputCapabilities();
  renderPlaybackVolume();
  if (!$("#audio-output-dialog").open) return;
  $("#audio-output-current").textContent = `Current output: ${name}`;
  const choices = playbackOutput.devices.filter(device => device.deviceId !== "default");
  const selected = audio.sinkId || "";
  const extra = selected && selected !== "default" && !choices.some(device => device.deviceId === selected)
    ? [{deviceId: selected, label: playbackOutput.names.get(selected) || "Selected output"}] : [];
  $("#audio-output-select").innerHTML = '<option value="">System default</option>' + [...choices, ...extra]
    .map((device, i) => `<option value="${escapeHtml(device.deviceId)}">${escapeHtml(device.label || `Audio output ${i + 1}`)}</option>`).join("");
  $("#audio-output-select").value = selected === "default" ? "" : selected;
  $("#audio-output-devices").hidden = !capabilities.sink || (!choices.length && !selected);
  $("#audio-output-select").disabled = playbackOutput.busy;
  $("#audio-output-choose").hidden = !capabilities.choose;
  $("#audio-output-choose").disabled = playbackOutput.busy;
  $("#audio-output-airplay").hidden = !capabilities.airplay || playbackOutput.airplay === false;
  $("#audio-output-airplay").disabled = playbackOutput.busy;
  $("#audio-output-note").textContent = playbackOutput.busy ? "Waiting for the output selection…"
    : capabilities.choose ? "Choose an output to open your browser’s device picker. Only outputs made available by the browser are listed here."
      : choices.length ? "Choose one of the outputs available to this browser."
        : "Choose speakers, headphones or a DAC in your system sound settings. This browser has not made additional outputs available here.";
}

async function refreshPlaybackOutputs() {
  const read = ++playbackOutput.read;
  if (!playbackOutputCapabilities().list) { renderPlaybackOutput(); return; }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (read !== playbackOutput.read || !$("#audio-output-dialog").open) return;
    const seen = new Set();
    playbackOutput.devices = devices.filter(device => device.kind === "audiooutput" && device.deviceId
      && !seen.has(device.deviceId) && seen.add(device.deviceId));
    for (const device of playbackOutput.devices) if (device.label) playbackOutput.names.set(device.deviceId, device.label);
  } catch {
    if (read !== playbackOutput.read || !$("#audio-output-dialog").open) return;
    playbackOutput.devices = [];
  }
  renderPlaybackOutput();
}

function openPlaybackOutput() {
  if (!systemPlaybackTrack() || document.querySelector("dialog[open]")) return;
  closeQueueActions();
  playbackOutput.focus = document.activeElement;
  playbackOutput.opened += 1;
  $("#audio-output-error").textContent = "";
  $("#audio-output-dialog").showModal();
  $("#player-output").setAttribute("aria-expanded", "true");
  renderPlaybackOutput();
  $("#audio-volume").focus();
  refreshPlaybackOutputs(); // No microphone permission or automatic device selection.
}

function closePlaybackOutput(restoreFocus = true) {
  playbackOutput.read += 1;
  playbackOutput.opened += 1;
  if (!$("#audio-output-dialog").open) return;
  if (typeof closeHelp === "function") closeHelp(false);
  $("#audio-output-dialog").close();
  $("#player-output").setAttribute("aria-expanded", "false");
  if (restoreFocus) ($("#player").hidden ? $("#home") : playbackOutput.focus || $("#player-output")).focus();
}

function playbackOutputError(error) {
  if (error?.name === "NotAllowedError") return "Output selection was cancelled or permission was not granted. Your current output is kept.";
  if (error?.name === "NotFoundError") return "That output is no longer available. Choose another output or System default.";
  return "Could not change the audio output. Choose an output in your system sound settings.";
}

async function changePlaybackOutput(choose, id = "") {
  if (playbackOutput.busy || !systemPlaybackTrack() || !$("#audio-output-dialog").open) return;
  const capabilities = playbackOutputCapabilities();
  if (!capabilities.sink || (choose && !capabilities.choose)) return;
  if (!choose && id && !playbackOutput.devices.some(device => device.deviceId === id)) return;
  const opened = playbackOutput.opened, details = state.details, epoch = player.epoch;
  const current = () => opened === playbackOutput.opened && details === state.details
    && epoch === player.epoch && $("#audio-output-dialog").open && systemPlaybackTrack();
  playbackOutput.busy = true;
  $("#audio-output-error").textContent = "";
  renderPlaybackOutput();
  try {
    // Invoke the native picker directly in this click's user activation.
    const device = choose ? await navigator.mediaDevices.selectAudioOutput() : {deviceId: id};
    if (!current() || !device || typeof device.deviceId !== "string") return;
    await audio.setSinkId(device.deviceId);
    if (!current()) return;
    if (device.label) playbackOutput.names.set(device.deviceId, device.label);
    refreshPlaybackOutputs();
  } catch (error) {
    if (current()) $("#audio-output-error").textContent = playbackOutputError(error);
  } finally {
    playbackOutput.busy = false;
    renderPlaybackOutput(); // Read the actual sink; never restart, reload or resume audio.
  }
}

$("#player-output").addEventListener("click", openPlaybackOutput);
$("#audio-volume").addEventListener("input", event => changePlaybackVolume(event.target.value));
$("#audio-mute").addEventListener("click", () => {
  if (!$("#audio-output-dialog").open || !systemPlaybackTrack()) return;
  audio.muted = !audio.muted;
  renderPlaybackVolume();
});
audio.addEventListener("volumechange", renderPlaybackVolume);
$("#audio-output-close").addEventListener("click", () => closePlaybackOutput());
$("#audio-output-dialog").addEventListener("cancel", event => { event.preventDefault(); closePlaybackOutput(); });
$("#audio-output-dialog").addEventListener("click", event => { if (event.target === $("#audio-output-dialog")) {
  const box = $("#audio-output-dialog").getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closePlaybackOutput();
} });
$("#audio-output-choose").addEventListener("click", () => changePlaybackOutput(true));
$("#audio-output-select").addEventListener("change", event => changePlaybackOutput(false, event.target.value));
$("#audio-output-airplay").addEventListener("click", () => {
  if (playbackOutput.busy || !systemPlaybackTrack() || !playbackOutputCapabilities().airplay) return;
  try { audio.webkitShowPlaybackTargetPicker(); }
  catch (error) { $("#audio-output-error").textContent = playbackOutputError(error); }
});
audio.addEventListener("webkitplaybacktargetavailabilitychanged", event => {
  playbackOutput.airplay = event.availability === "available";
  renderPlaybackOutput();
});
audio.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", renderPlaybackOutput);
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  if ($("#audio-output-dialog").open) refreshPlaybackOutputs();
});

function seekSystemPlayback(position, fast = false) {
  if (!systemPlaybackTrack() || !Number.isFinite(position) || !Number.isFinite(playerTrackDuration()) || playerTrackDuration() <= 0) return;
  const target = Math.max(0, Math.min(playerTrackDuration(), position));
  if (typeof gaplessSeek === "function") gaplessSeek(target, fast);
  else if (fast && typeof audio.fastSeek === "function") audio.fastSeek(target);
  else audio.currentTime = target;
  syncSystemPlayback();
}

function playSystemPlayback() {
  const track = systemPlaybackTrack(), details = state.details;
  if (!track) return;
  if (audio.ended) audio.currentTime = 0;
  audio.play().catch(() => {
    if (details === state.details && track === systemPlaybackTrack()) toast("Press Play in Tagcast to resume audio.");
  });
}

const systemPlaybackActions = {
  play: playSystemPlayback,
  pause: () => { if (systemPlaybackTrack()) audio.pause(); },
  stop: () => { if (systemPlaybackTrack()) stopPlayer(); },
  previoustrack: () => { if (systemPlaybackTrack()) step(-1); },
  nexttrack: () => { if (systemPlaybackTrack()) step(1); },
  seekto: details => seekSystemPlayback(details.seekTime, details.fastSeek === true),
  seekbackward: details => seekSystemPlayback(playerTrackPosition() - (Number.isFinite(details.seekOffset) && details.seekOffset > 0 ? details.seekOffset : 10)),
  seekforward: details => seekSystemPlayback(playerTrackPosition() + (Number.isFinite(details.seekOffset) && details.seekOffset > 0 ? details.seekOffset : 10)),
};

function updateSystemPlaybackPosition(force = true) {
  const session = navigator.mediaSession;
  if (typeof session?.setPositionState !== "function") return;
  if (!force && performance.now() - systemPlayback.positionAt < 1000) return;
  systemPlayback.positionAt = performance.now();
  try {
    if (!systemPlaybackTrack() || !Number.isFinite(playerTrackDuration()) || playerTrackDuration() <= 0) session.setPositionState();
    else session.setPositionState({duration: playerTrackDuration(), playbackRate: Number.isFinite(audio.playbackRate) && audio.playbackRate > 0 ? audio.playbackRate : 1,
      position: Math.max(0, Math.min(playerTrackDuration(), playerTrackPosition()))});
  } catch { /* Position controls are optional and vary by browser. */ }
}

function syncSystemPlayback() {
  const session = navigator.mediaSession, track = systemPlaybackTrack();
  if (!track) closePlaybackOutput(false);
  if (!session) return;
  if (systemPlayback.session !== session) {
    systemPlayback.session = session; systemPlayback.installed = false; systemPlayback.metadata = "";
  }
  const active = Boolean(track);
  if (systemPlayback.installed !== active && typeof session.setActionHandler === "function") {
    for (const [action, handler] of Object.entries(systemPlaybackActions)) {
      try { session.setActionHandler(action, active ? handler : null); }
      catch { /* An unsupported action must not disable the remaining controls. */ }
    }
    systemPlayback.installed = active;
  }
  try { session.playbackState = !track ? "none" : audio.paused || audio.ended ? "paused" : "playing"; }
  catch { /* Browsers may expose a partial Media Session implementation. */ }
  const key = track ? JSON.stringify([track.id, track.title, track.artist, track.album?.name, track.album?.artwork]) : "";
  if (!track || key !== systemPlayback.metadata) {
    systemPlayback.metadata = key;
    try {
      session.metadata = track && typeof MediaMetadata === "function" ? new MediaMetadata({
        title: track.title, artist: track.artist, album: track.album?.name || "",
        artwork: track.album?.artwork ? [{src: track.album.artwork, sizes: "300x300"}] : [],
      }) : null;
    } catch { try { session.metadata = null; } catch { /* Optional system metadata. */ } }
  }
  updateSystemPlaybackPosition();
}

for (const event of ["playing", "pause", "ended", "emptied", "error", "loadedmetadata", "durationchange", "seeked", "ratechange"]) {
  audio.addEventListener(event, syncSystemPlayback);
}
audio.addEventListener("timeupdate", () => updateSystemPlaybackPosition(false));
renderPlaybackOutput();
