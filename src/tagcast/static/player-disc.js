"use strict";

// Presentation only: the native audio element remains the playback authority.
const visualDisc = {style: storedVisualDiscStyle(), waiting: false, label: ""};

function storedVisualDiscStyle() {
  try { return localStorage.getItem("tagcast-player-artwork") === "cd" ? "cd" : "cover"; }
  catch { return "cover"; }
}

function visualDiscSettings() {
  return `<label>${TagcastI18n.html("player.disc.setting")} <select id="player-artwork-style" aria-describedby="player-artwork-note"><option value="cover" ${visualDisc.style === "cover" ? "selected" : ""}>${TagcastI18n.html("player.disc.cover")}</option><option value="cd" ${visualDisc.style === "cd" ? "selected" : ""}>${TagcastI18n.html("player.disc.cd")}</option></select></label><p class="muted" id="player-artwork-note">${TagcastI18n.html("player.disc.note")}</p>`;
}

// Bound decorative lettering only; the original metadata remains unchanged.
function visualDiscLabel(value, limit) {
  const letters = Array.from(String(value || "").replace(/\s+/g, " ").trim());
  return letters.length > limit ? letters.slice(0, limit - 1).join("") + "…" : letters.join("");
}

function renderVisualDiscLabel() {
  const track = player.queue[player.index], album = track?.album;
  const title = track ? visualDiscLabel([track.title, track.artist || album?.artist].filter(Boolean).join(" • "), 96) : "";
  const name = visualDiscLabel(album?.name, 36), key = JSON.stringify([title, name]);
  if (visualDisc.label === key) return;
  visualDisc.label = key;
  $("#visual-disc-title").textContent = title;
  $("#visual-disc-album").textContent = name;
}

// The blurred cover is a 30% image layer over the palette paper. Check its darkest
// and lightest possible pixels, including the selected-control wash, without reading
// cross-origin artwork or changing the user's theme accent.
function expandedTextColours(link, paper, accent) {
  const rgb = hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  const hex = parts => "#" + parts.map(value => Math.round(value).toString(16).padStart(2, "0")).join("");
  const blend = (a, b, weight) => a.map((value, index) => value * (1 - weight) + b[index] * weight);
  const base = rgb(paper), ink = rgb(link), colour = rgb(accent);
  const backgrounds = [0, 255].map(value => blend(base, [value, value, value], .3));
  backgrounds.push(...backgrounds.map(background => blend(background, colour, .16)));
  const score = value => Math.min(...backgrounds.map(background => TagcastThemes.contrast(value, hex(background))));
  const target = score("#000000") >= score("#ffffff") ? [0, 0, 0] : [255, 255, 255];
  for (let step = 0; step <= 100; step++) {
    const candidate = hex(blend(ink, target, step / 100));
    if (score(candidate) >= 4.5) return {text: candidate, backing: "transparent"};
  }
  // An unusual custom mid-tone theme may offer no shared contrast across the image.
  // A tiny opaque backing on the link/selected controls then makes the result bounded.
  const text = TagcastThemes.contrast(paper, "#000000") >= TagcastThemes.contrast(paper, "#ffffff") ? "#000000" : "#ffffff";
  return {text, backing: paper};
}

function renderVisualDisc() {
  const stage = $("#visual-player"), cd = visualDisc.style === "cd";
  renderVisualDiscLabel();
  stage.classList.toggle("cd-view", cd);
  stage.classList.toggle("disc-spinning", cd && visualPlayer.open && !document.hidden
    && !visualDisc.waiting && !audio.paused && !audio.ended && !audio.seeking
    && audio.readyState >= 3);
  const palette = TagcastThemes.active() || {base: document.documentElement.dataset.palette || "forest"};
  const colours = TagcastThemes.colours(palette, TagcastThemes.mode()), accent = colours.accent;
  const readable = expandedTextColours(colours.link, colours.paper, accent);
  stage.style.setProperty("--expanded-link", readable.text);
  stage.style.setProperty("--expanded-source-backing", readable.backing);
  const effect = typeof musicVisualizationActive === "function" && musicVisualizationActive();
  const button = $("#visual-player-disc-toggle");
  button.setAttribute("aria-pressed", String(cd && !effect));
  button.textContent = TagcastI18n.text("player.disc.cdTab");
  button.setAttribute("aria-label", TagcastI18n.text("player.disc.toggle"));
  $("#visual-player-cover-toggle").setAttribute("aria-pressed", String(!cd && !effect));
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
