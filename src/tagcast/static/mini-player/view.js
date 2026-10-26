"use strict";
// This page deliberately has no audio element, library client or playback engine.
const bridge = window.tagcastMini;
const nodes = Object.fromEntries(["cover", "title", "artist", "album", "previous", "play", "next", "elapsed", "duration", "position", "status", "pin", "open"].map(id => [id, document.getElementById(id)]));
let playback = null, draft = null, busy = false, cover = "", failure = "";
function clock(value) {
  const n = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${n >= 3600 ? `${Math.floor(n/3600)}:${String(Math.floor(n/60)%60).padStart(2,"0")}` : Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`;
}
function miniText(node, value) { if (node.textContent !== value) node.textContent = value; }
function identity(value) { return value ? `${value.document}/${value.entry}/${value.segment}` : ""; }
function miniDisabled(node, unavailable) {
  // Keep the focused control usable during a brief acknowledgement. send() still
  // serializes commands; disabling a focused range would discard keyboard focus.
  node.disabled = unavailable || (busy && document.activeElement !== node);
}
function render() {
  const s = playback, ready = Boolean(s?.controllable);
  miniText(nodes.title, s?.title || "Tagcast Mini Player"); nodes.title.title = nodes.title.textContent;
  miniText(nodes.artist, s?.artist || "Waiting for Tagcast…"); nodes.artist.title = nodes.artist.textContent;
  miniText(nodes.album, s?.album || ""); nodes.album.hidden = !s?.album; nodes.album.title = nodes.album.textContent;
  miniDisabled(nodes.previous, !s?.previous); miniDisabled(nodes.next, !s?.next);
  miniDisabled(nodes.play, !ready); nodes.play.dataset.paused = String(s?.paused !== false);
  const playLabel = s?.paused !== false ? "Play" : "Pause";
  nodes.play.setAttribute("aria-label", playLabel); nodes.play.title = playLabel;
  miniDisabled(nodes.position, !s?.seekable);
  const preview = draft?.identity === identity(s) ? draft.position : s?.position || 0;
  nodes.position.max = String(s?.duration || 0); nodes.position.value = String(preview);
  nodes.position.setAttribute("aria-valuetext", `${clock(preview)} of ${clock(s?.duration)}`);
  miniText(nodes.elapsed, clock(preview)); miniText(nodes.duration, clock(s?.duration));
  nodes.position.style.setProperty("--mini-progress", `${s?.duration > 0 ? Math.max(0, Math.min(100, preview / s.duration * 100)) : 0}%`);
  nodes.position.setAttribute("aria-label", `Seek in ${s?.title || "current track"}`);
  // Do not repeatedly announce an unchanged status on every progress snapshot.
  miniText(nodes.status, failure || s?.status || "");
  if (cover !== (s?.cover || "")) { cover = s?.cover || ""; nodes.cover.hidden = !cover; if (cover) nodes.cover.src = cover; else nodes.cover.removeAttribute("src"); }
}
async function send(action, value = playback, position) {
  if (!bridge || !value || busy) return;
  busy = true; failure = ""; render();
  try { if (!await bridge.command({action, document: value.document, entry: value.entry, segment: value.segment, ...(action === "seek" ? {position} : {})})) failure = "Player changed · try again"; }
  catch { failure = "Player unavailable · open Tagcast"; }
  finally { busy = false; render(); }
}
function startDraft() { if (playback?.seekable && !draft) draft = {identity: identity(playback), snapshot: playback, position: playback.position}; }
nodes.position.addEventListener("pointerdown", startDraft);
nodes.position.addEventListener("input", () => { startDraft(); if (draft) { draft.position = Number(nodes.position.value); render(); } });
nodes.position.addEventListener("change", () => { const value = draft; draft = null; if (value) send("seek", value.snapshot, value.position); });
for (const name of ["blur", "pointercancel"]) nodes.position.addEventListener(name, () => { draft = null; render(); });
nodes.previous.addEventListener("click", () => send("previous")); nodes.next.addEventListener("click", () => send("next"));
nodes.play.addEventListener("click", () => send(playback?.paused ? "play" : "pause"));
nodes.open.addEventListener("click", () => bridge?.openMain());
nodes.pin.addEventListener("click", () => bridge?.pin(nodes.pin.getAttribute("aria-pressed") !== "true"));
nodes.cover.addEventListener("error", () => { nodes.cover.hidden = true; });
if (bridge) {
  bridge.onState(value => {
    if (identity(playback) !== identity(value.playback)) { draft = null; failure = ""; }
    playback = value.playback;
    nodes.pin.disabled = !value.canPin; nodes.pin.setAttribute("aria-pressed", String(value.pinned));
    nodes.pin.title = !value.canPin ? "Pinning is unavailable on this desktop" : value.pinned ? "Unpin Mini Player" : "Keep Mini Player on top";
    nodes.pin.setAttribute("aria-label", nodes.pin.title);
    if (playback) { document.documentElement.dataset.theme = playback.theme; document.documentElement.dataset.palette = playback.palette; }
    render();
  });
  bridge.ready();
} else { failure = "Open Mini Player from the Tagcast desktop app"; render(); }
