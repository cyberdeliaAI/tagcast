"use strict";

// Presentation only: the native audio element remains the playback authority.
const visualDisc = {style: storedVisualDiscStyle(), waiting: false};

function storedVisualDiscStyle() {
  try { return localStorage.getItem("tagcast-player-artwork") === "cd" ? "cd" : "cover"; }
  catch { return "cover"; }
}

function visualDiscSettings() {
  return `<label>${TagcastI18n.html("player.disc.setting")} <select id="player-artwork-style" aria-describedby="player-artwork-note"><option value="cover" ${visualDisc.style === "cover" ? "selected" : ""}>${TagcastI18n.html("player.disc.cover")}</option><option value="cd" ${visualDisc.style === "cd" ? "selected" : ""}>${TagcastI18n.html("player.disc.cd")}</option></select></label><p class="muted" id="player-artwork-note">${TagcastI18n.html("player.disc.note")}</p>`;
}

function renderVisualDisc() {
  const stage = $("#visual-player"), cd = visualDisc.style === "cd";
  stage.classList.toggle("cd-view", cd);
  stage.classList.toggle("disc-spinning", cd && visualPlayer.open && !document.hidden
    && !visualDisc.waiting && !audio.paused && !audio.ended && !audio.seeking
    && audio.readyState >= 3);
  const palette = TagcastThemes.active() || {base: document.documentElement.dataset.palette || "forest"};
  const accent = TagcastThemes.colours(palette, TagcastThemes.mode()).accent;
  stage.style.setProperty("--expanded-accent-ink",
    TagcastThemes.contrast(accent, "#111111") >= TagcastThemes.contrast(accent, "#ffffff") ? "#111111" : "#ffffff");
  const button = $("#visual-player-disc-toggle");
  button.setAttribute("aria-pressed", String(cd));
  button.textContent = TagcastI18n.text("player.disc.cdTab");
  button.setAttribute("aria-label", TagcastI18n.text("player.disc.toggle"));
  $("#visual-player-cover-toggle").setAttribute("aria-pressed", String(!cd));
  const setting = $("#player-artwork-style");
  if (setting) setting.value = visualDisc.style;
}

function setVisualDiscStyle(style) {
  if (!["cover", "cd"].includes(style)) return;
  visualDisc.style = style;
  try { localStorage.setItem("tagcast-player-artwork", style); } catch { /* private window */ }
  renderVisualDisc();
}

$("#visual-player-disc-toggle").addEventListener("click", () => {
  setVisualDiscStyle("cd");
});
$("#visual-player-cover-toggle").addEventListener("click", () => setVisualDiscStyle("cover"));
document.addEventListener("change", event => {
  if (event.target.id === "player-artwork-style") setVisualDiscStyle(event.target.value);
});
for (const name of ["loadstart", "waiting", "seeking", "emptied", "ended", "error"]) {
  audio.addEventListener(name, () => { visualDisc.waiting = true; renderVisualDisc(); });
}
for (const name of ["playing", "canplay", "seeked"]) {
  audio.addEventListener(name, () => { visualDisc.waiting = false; renderVisualDisc(); });
}
for (const name of ["play", "pause"]) audio.addEventListener(name, renderVisualDisc);
// A network 'stalled' event alone does not stop audio already in the buffer.
document.addEventListener("visibilitychange", renderVisualDisc);
document.addEventListener("tagcast-theme-change", renderVisualDisc);
TagcastI18n.subscribe(renderVisualDisc);
renderVisualDisc();
