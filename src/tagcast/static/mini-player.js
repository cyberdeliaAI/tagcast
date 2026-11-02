"use strict";

// The main renderer remains the only owner of audio, Gapless, queue and reporting.
const miniOwner = {document: globalThis.crypto?.randomUUID?.() || String(Date.now()), sequence: 0,
  ids: new WeakMap(), serial: 0, normal: 0, timer: null, active: false};
function miniIdentity(object) {
  if (!object || typeof object !== "object") return "";
  if (!miniOwner.ids.has(object)) miniOwner.ids.set(object, String(++miniOwner.serial));
  return miniOwner.ids.get(object);
}
// The passive Mini Player has no catalogs or storage; it shows the owner's labels so both
// windows always use the same language. Labels are cached per language.
const MINI_LABELS = ["appTitle", "documentTitle", "waiting", "idleTitle", "idleArtist", "play", "pause", "previous", "next",
  "seekCurrentTrack", "seekIn", "position", "pin", "unpin", "pinUnavailable", "openMain", "windowControls", "transport",
  "progress", "shell", "playerChanged", "playerUnavailable"];
const miniLabelCache = {language: "", labels: null};
function miniLabels() {
  if (miniLabelCache.language !== TagcastI18n.language) {
    // Keep {{title}}, {{elapsed}} and {{duration}} for the view; never fill metadata here.
    const placeholders = {title: "{{title}}", elapsed: "{{elapsed}}", duration: "{{duration}}"};
    miniLabelCache.labels = Object.fromEntries(MINI_LABELS.map(name => [name, TagcastI18n.text(`mini.${name}`, placeholders)]));
    miniLabelCache.language = TagcastI18n.language;
  }
  return miniLabelCache.labels;
}
function miniSnapshot() {
  const track = player.queue[player.index], g = gaplessTrial.active;
  const available = Boolean(track && live() && !$("#player").hidden);
  const controllable = available && (typeof localPlaybackAllowed !== "function" || localPlaybackAllowed());
  const duration = playerTrackDuration(), ready = !g || Boolean(g.started && g.current && g.ready !== false);
  const theme = document.documentElement.dataset.theme;
  const status = !available ? "" : !controllable ? "remote" : audio.error ? "error" : g && (!ready || g.seekIntent) ? "preparing"
    : audio.readyState < 3 && !audio.paused ? "buffering" : g ? "gapless" : "";
  return {document: miniOwner.document, sequence: ++miniOwner.sequence,
    entry: available ? `${player.epoch}:${miniIdentity(track)}` : "", segment: g ? miniIdentity(g.current || g) : `normal:${miniOwner.normal}`,
    // Metadata fields carry only metadata; idle text comes from the translated labels.
    title: available ? track.title : "", artist: available ? track.artist || track.album?.artist || "" : "", idle: !available,
    album: available ? track.album?.name || "" : "", cover: available ? track.album?.artwork || "" : "",
    position: available && ready ? playerTrackPosition() : 0, duration: available && ready ? duration : 0,
    paused: g && !ready ? !g.autoPlay : audio.paused,
    controllable, seekable: controllable && ready && !state.loading && !audio.error && Number.isFinite(duration) && duration > 0,
    previous: controllable && player.index > 0, next: controllable && player.index < player.queue.length - 1,
    status: status ? TagcastI18n.text(`mini.status.${status}`) : "",
    language: TagcastI18n.language, direction: TagcastI18n.direction, labels: miniLabels(),
    theme: theme === "dark" || (!theme && globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches) ? "dark" : "light",
    palette: document.documentElement.dataset.palette || "forest",
    colours: TagcastThemes.active() ? {...TagcastThemes.active()[TagcastThemes.mode()]} : {}};
}
function publishMiniPlayer() {
  if (miniOwner.active) window.tagcastMiniOwner?.publish(miniSnapshot());
}
function miniApplyCommand(command) {
  const current = miniSnapshot();
  if (!current.controllable || command.document !== current.document || command.entry !== current.entry || command.segment !== current.segment) return false;
  const g = gaplessTrial.active;
  switch (command.action) {
    case "pause": if (g?.ready === false) g.autoPlay = false; audio.pause(); break;
    case "play":
      if (g?.ready === false) { g.autoPlay = true; break; }
      if (!audio.getAttribute("src") || audio.error) return false;
      if (audio.ended) { if (g) seekSystemPlayback(0); else audio.currentTime = 0; }
      audio.play().catch(() => toast(TagcastI18n.text("mini.owner.playFailed"))); break;
    case "previous": if (!current.previous) return false; step(-1); break;
    case "next": if (!current.next) return false; step(1); break;
    case "seek": if (!current.seekable || !Number.isFinite(command.position) || command.position < 0 || command.position > current.duration) return false; seekSystemPlayback(command.position); break;
    default: return false;
  }
  publishMiniPlayer(); return true;
}
if (window.tagcastMiniOwner) {
  window.tagcastMiniOwner.onActive(active => {
    miniOwner.active = active === true;
    if (miniOwner.timer) clearInterval(miniOwner.timer);
    miniOwner.timer = miniOwner.active ? setInterval(publishMiniPlayer, 250) : null;
    publishMiniPlayer();
  });
  window.tagcastMiniOwner.onCommand(request => {
    let ok = false;
    try { ok = miniApplyCommand(request.command); } catch { /* stale or unavailable player */ } finally {
      window.tagcastMiniOwner.respond({id: request.id, ok});
    }
  });
  for (const name of ["loadstart", "ended"]) audio.addEventListener(name, () => { miniOwner.normal += 1; publishMiniPlayer(); });
  for (const name of ["play", "pause", "playing", "waiting", "stalled", "ended", "error", "emptied", "loadedmetadata", "seeked"]) audio.addEventListener(name, publishMiniPlayer);
  document.addEventListener("tagcast-theme-change", publishMiniPlayer);
  TagcastI18n.subscribe(publishMiniPlayer);
  document.addEventListener("DOMContentLoaded", () => {
    const button = $("#visual-player-mini"); button.hidden = false;
    button.addEventListener("click", () => window.tagcastMiniOwner.open());
    new MutationObserver(publishMiniPlayer).observe(document.documentElement, {attributes: true, attributeFilter: ["data-theme", "data-palette"]});
    window.tagcastMiniOwner.ready();
  });
}
