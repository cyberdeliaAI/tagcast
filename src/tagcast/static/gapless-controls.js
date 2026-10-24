"use strict";

// Presentation only: all buttons and seeking retain the same native audio element.
const gaplessControls = {draft: null};
function gaplessClock(seconds) {
  const n = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(n / 3600), minutes = Math.floor(n / 60) % 60;
  return `${hours ? `${hours}:${String(minutes).padStart(2, "0")}` : Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
function gaplessRenderTransport() {
  const transport = $("#gapless-transport"), g = gaplessTrial.active;
  const active = Boolean(g), focused = document.activeElement;
  const wasNative = focused === audio, wasCustom = transport.contains?.(focused);
  transport.hidden = !active; audio.hidden = active;
  $("#gapless-speed-field").hidden = !active;
  if (!active) {
    gaplessControls.draft = null;
    if (wasCustom && !$("#player").hidden) audio.focus();
    return;
  }
  const ready = Boolean(g.started && g.current), duration = ready ? gaplessDuration() : Number(g.first?.length) || 0;
  const draft = gaplessControls.draft;
  const preview = draft && draft.engine === g && draft.segment === g.current;
  const position = Math.max(0, Math.min(duration, preview ? draft.position : ready ? gaplessPosition() : 0));
  $("#gapless-time").textContent = `${gaplessClock(position)} / ${gaplessClock(duration)}`;
  const slider = $("#gapless-position"); slider.max = String(duration); slider.value = String(position);
  slider.disabled = !ready || !Number.isFinite(duration) || duration <= 0;
  slider.setAttribute("aria-label", `Seek in ${player.queue[player.index]?.title || "current track"}`);
  slider.setAttribute("aria-valuetext", ready ? `${gaplessClock(position)} of ${gaplessClock(duration)}` : "Preparing audio");
  const button = $("#gapless-play"), paused = audio.paused;
  button.disabled = !ready; button.textContent = paused ? "▶" : "❚❚";
  button.setAttribute("aria-label", paused ? "Play current track" : "Pause current track");
  button.title = paused ? "Play" : "Pause";
  const muted = audio.muted || audio.volume === 0, label = muted ? "Unmute" : "Mute";
  $("#gapless-mute").setAttribute("aria-pressed", String(muted));
  $("#gapless-mute").setAttribute("aria-label", label); $("#gapless-mute").title = label;
  $("#gapless-speed").value = String(audio.playbackRate || 1);
  if (wasNative && ready) button.focus();
}
function gaplessSeekInput() {
  const g = gaplessTrial.active, slider = $("#gapless-position");
  if (!g?.current || slider.disabled) return;
  gaplessControls.draft ||= {engine: g, segment: g.current, position: gaplessPosition()};
  if (Number.isFinite(Number(slider.value))) gaplessControls.draft.position = Number(slider.value);
  gaplessRenderTransport();
}
function gaplessCommitSeek() {
  const draft = gaplessControls.draft; gaplessControls.draft = null;
  const g = gaplessTrial.active;
  // A drag started on another track (including a Repeat copy) must never seek this one.
  if (draft && draft.engine === g && draft.segment === g?.current) seekSystemPlayback(draft.position);
  gaplessRenderTransport();
}
$("#gapless-position").addEventListener("input", gaplessSeekInput);
$("#gapless-position").addEventListener("change", gaplessCommitSeek);
$("#gapless-position").addEventListener("pointerdown", () => {
  const g = gaplessTrial.active;
  if (g?.current) gaplessControls.draft = {engine: g, segment: g.current, position: gaplessPosition()};
});
for (const name of ["pointercancel", "blur"]) $("#gapless-position").addEventListener(name, () => { gaplessControls.draft = null; gaplessRenderTransport(); });
$("#gapless-position").addEventListener("keydown", event => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) gaplessControls.draft = null;
});
$("#gapless-play").addEventListener("click", () => {
  if (!gaplessTrial.active?.started) return;
  if (audio.paused) playSystemPlayback(); else audio.pause();
});
$("#gapless-mute").addEventListener("click", () => {
  if (!gaplessTrial.active) return;
  const unmute = audio.muted || audio.volume === 0;
  audio.muted = !unmute;
  if (unmute && audio.volume === 0) audio.volume = 1;
  gaplessRenderTransport();
});
$("#gapless-options").addEventListener("click", () => { openPlaybackOutput(); gaplessRenderTransport(); });
$("#gapless-speed").addEventListener("change", event => {
  const speed = Number(event.target.value);
  if (gaplessTrial.active && $("#audio-output-dialog").open && [.25, .5, .75, 1, 1.25, 1.5, 1.75, 2].includes(speed)) audio.playbackRate = speed;
});
for (const name of ["timeupdate", "play", "pause", "playing", "seeking", "seeked", "durationchange", "ratechange", "volumechange", "emptied", "ended"]) audio.addEventListener(name, gaplessRenderTransport);
gaplessRenderTransport();
