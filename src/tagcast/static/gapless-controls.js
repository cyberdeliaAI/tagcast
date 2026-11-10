"use strict";

// Presentation only: all buttons and seeking retain the same native audio element.
const gaplessControls = {draft: null, spacious: false};
function customTransportEnabled() {
  return Boolean(gaplessTrial.active) || gaplessControls.spacious || Boolean(player.resumePending) || Boolean(audioRecoveryCurrent());
}
function transportSelection() {
  const g = gaplessTrial.active;
  return {engine: g, segment: g ? g.current : player.queue[player.index], epoch: player.epoch};
}
function transportDraftCurrent(draft) {
  const current = transportSelection();
  return Boolean(draft && draft.engine === current.engine && draft.segment === current.segment && draft.epoch === current.epoch);
}
function gaplessClock(seconds) {
  const n = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(n / 3600), minutes = Math.floor(n / 60) % 60;
  return `${hours ? `${hours}:${String(minutes).padStart(2, "0")}` : Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
function gaplessRenderTransport() {
  const transport = $("#gapless-transport"), g = gaplessTrial.active;
  const active = customTransportEnabled(), focused = document.activeElement;
  const wasNative = focused === audio, wasCustom = transport.contains?.(focused);
  transport.hidden = !active; audio.hidden = active;
  $("#gapless-speed-field").hidden = !active;
  if (!active) {
    gaplessControls.draft = null;
    if (wasCustom && !$("#player").hidden) audio.focus();
    return;
  }
  const failed = Boolean(audio.error);
  const recovery = audioRecoveryCurrent();
  const ready = Boolean(recovery && Number.isFinite(recovery.duration) && recovery.duration > 0) || !failed && (g ? Boolean(g.started && g.current && g.ready !== false)
    : Boolean(player.queue[player.index] && Number.isFinite(audio.duration) && audio.duration > 0));
  const duration = ready ? playerTrackDuration() : Number(player.resumePending ? player.queue[player.index]?.length : g?.first?.length) || 0;
  const draft = gaplessControls.draft || g?.seekIntent;
  const preview = draft && (draft === g?.seekIntent || transportDraftCurrent(draft));
  const position = Math.max(0, Math.min(duration, preview ? draft.position : ready ? playerTrackPosition() : 0));
  const waiting = Boolean(recovery && recovery === audioRecovery.pending) || !player.resumePending && !failed && (g ? g.ready === false || Boolean(g.seekIntent) : !ready);
  transport.setAttribute("aria-busy", String(waiting));
  $("#gapless-time").textContent = waiting ? TagcastI18n.text("gaplessSettings.transport.preparing") : `${gaplessClock(position)} / ${gaplessClock(duration)}`;
  $("#gapless-time").title = waiting && g ? gaplessTrial.message : "";
  $("#transport-current").textContent = failed ? "—" : waiting ? TagcastI18n.text("gaplessSettings.transport.preparing") : gaplessClock(position);
  $(".transport-timeline").title = failed ? TagcastI18n.text("player.error.trackStatus") : "";
  $("#transport-total").textContent = gaplessClock(duration);
  const slider = $("#gapless-position"); slider.max = String(duration); slider.value = String(position);
  slider.disabled = !ready || !Number.isFinite(duration) || duration <= 0;
  const title = player.queue[player.index]?.title, times = {position: gaplessClock(position), duration: gaplessClock(duration)};
  slider.setAttribute("aria-label", title ? TagcastI18n.text("gaplessSettings.transport.seekIn", {title}) : TagcastI18n.text("gaplessSettings.transport.seekCurrent"));
  slider.setAttribute("aria-valuetext", TagcastI18n.text(waiting ? "gaplessSettings.transport.preparingAt" : "gaplessSettings.transport.position", times));
  const button = $("#gapless-play"), paused = audioRecoveryPaused();
  button.disabled = !ready && !player.resumePending && !recovery; button.textContent = paused ? "▶" : "❚❚";
  button.setAttribute("aria-label", TagcastI18n.text(paused ? "gaplessSettings.transport.playTrack" : "gaplessSettings.transport.pauseTrack"));
  button.title = TagcastI18n.text(paused ? "gaplessSettings.transport.play" : "gaplessSettings.transport.pause");
  const muted = audio.muted || audio.volume === 0, label = TagcastI18n.text(muted ? "gaplessSettings.transport.unmute" : "gaplessSettings.transport.mute");
  $("#gapless-mute").setAttribute("aria-pressed", String(muted));
  $("#gapless-mute").setAttribute("aria-label", label); $("#gapless-mute").title = label;
  $("#gapless-speed").value = String(audio.playbackRate || 1);
  if (wasNative && (ready || recovery)) button.focus();
}
function gaplessSeekInput() {
  const slider = $("#gapless-position"), selection = transportSelection();
  if (!selection.segment || slider.disabled) return;
  gaplessControls.draft ||= {...selection, position: playerTrackPosition()};
  if (Number.isFinite(Number(slider.value))) gaplessControls.draft.position = Number(slider.value);
  gaplessRenderTransport();
}
function gaplessCommitSeek() {
  const draft = gaplessControls.draft; gaplessControls.draft = null;
  // A drag started on another track (including a Repeat copy) must never seek this one.
  if (transportDraftCurrent(draft)) seekSystemPlayback(draft.position);
  gaplessRenderTransport();
}
$("#gapless-position").addEventListener("input", gaplessSeekInput);
$("#gapless-position").addEventListener("change", gaplessCommitSeek);
$("#gapless-position").addEventListener("pointerdown", () => {
  const selection = transportSelection();
  if (selection.segment) gaplessControls.draft = {...selection, position: playerTrackPosition()};
});
for (const name of ["pointercancel", "blur"]) $("#gapless-position").addEventListener(name, () => { gaplessControls.draft = null; gaplessRenderTransport(); });
$("#gapless-position").addEventListener("keydown", event => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) gaplessControls.draft = null;
});
$("#gapless-play").addEventListener("click", () => {
  if (!customTransportEnabled() || $("#gapless-play").disabled) return;
  if (audioRecoveryPaused()) playSystemPlayback(); else pauseSystemPlayback();
});
$("#gapless-mute").addEventListener("click", () => {
  if (!customTransportEnabled()) return;
  const unmute = audio.muted || audio.volume === 0;
  audio.muted = !unmute;
  if (unmute && audio.volume === 0) audio.volume = 1;
  gaplessRenderTransport();
});
$("#gapless-options").addEventListener("click", () => { openPlaybackOutput(); gaplessRenderTransport(); });
$("#gapless-speed").addEventListener("change", event => {
  const speed = Number(event.target.value);
  if (customTransportEnabled() && $("#audio-output-dialog").open && [.25, .5, .75, 1, 1.25, 1.5, 1.75, 2].includes(speed)) audio.playbackRate = speed;
});
for (const name of ["timeupdate", "play", "pause", "playing", "seeking", "seeked", "durationchange", "ratechange", "volumechange", "emptied", "ended", "loadedmetadata", "error"]) audio.addEventListener(name, gaplessRenderTransport);
// Labels follow a language change; an inactive transport is hidden and has nothing to redraw.
TagcastI18n.subscribe(() => { if (customTransportEnabled()) gaplessRenderTransport(); });
gaplessRenderTransport();
