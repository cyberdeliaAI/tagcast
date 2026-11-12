"use strict";

// One queue view, mounted either in the normal page or the existing side panel.
// Preferences affect presentation only; no audio source, queue or account is created here.
function storedNowPlayingChoice(key, choices, fallback) {
  try { const value = localStorage.getItem(key); return choices.includes(value) ? value : fallback; }
  catch { return fallback; }
}
const nowPlayingPreferences = {
  open: storedNowPlayingChoice("tagcast-now-playing-open", ["page", "panel"], "page"),
  transport: storedNowPlayingChoice("tagcast-player-transport", ["compact", "spacious"], "compact"),
  meter: storedNowPlayingChoice("tagcast-now-playing-meter", ["off", "spectrum", "vu"], "off"),
};
const nowPlayingPresentation = {page: false, ratings: $("#player-ratings"), sound: $("#player-output"),
  vu: [0, 0], needles: [], spectrum: null};

function nowPlayingSettings() {
  const select = (id, value, choices) => `<select id="${id}">${choices.map(([key, label]) => `<option value="${key}" ${value === key ? "selected" : ""}>${TagcastI18n.html(label)}</option>`).join("")}</select>`;
  return `<div class="listening-settings"><label>${TagcastI18n.html("listening.settings.open")} ${select("now-playing-open", nowPlayingPreferences.open, [["page", "listening.settings.page"], ["panel", "listening.settings.panel"]])}</label>
    <label>${TagcastI18n.html("listening.settings.transport")} ${select("player-transport-style", nowPlayingPreferences.transport, [["compact", "listening.settings.compact"], ["spacious", "listening.settings.spacious"]])}</label>
    <label>${TagcastI18n.html("listening.settings.meter")} ${select("now-playing-meter", nowPlayingPreferences.meter, [["off", "visualizer.mode.off"], ["spectrum", "listening.settings.spectrum"], ["vu", "listening.settings.vu"]])}</label>
    <p class="muted">${TagcastI18n.html("listening.settings.note")}</p></div>`;
}

function listeningEmptyState() {
  return `<div class="listening-empty-state">
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><circle cx="32" cy="32" r="25"/><circle cx="32" cy="32" r="9"/><circle cx="32" cy="32" r="2"/></svg>
    <h3>${TagcastI18n.html("listening.empty.title")}</h3>
    <p>${TagcastI18n.html("listening.empty.description")}</p>
    <a class="button primary" href="#/albums">${TagcastI18n.html("listening.empty.browse")}</a>
  </div>`;
}

// Only recognised trailing edition labels are separated visually; the stored title is unchanged.
function listeningTitleParts(title) {
  const match = title.match(/^(.*?)\s*\(([^()]*(?:remaster|extended|version|edition|mix)[^()]*)\)\s*$/i);
  return match && match[1].trim() ? {title: match[1].trim(), edition: match[2]} : {title, edition: ""};
}

function listeningTrackMetadata(track) {
  const year = track.year || track.album.year;
  const stream = player.quality !== "orig" ? TagcastI18n.text("player.quality.mp3", {bitrate: player.quality})
    : TagcastI18n.text(track.format ? "player.quality.originalFormat" : "player.quality.original", {format: track.format});
  return `<div id="listening-facts" class="listening-facts">${year ? `<span>${escapeHtml(year)}</span>` : ""}${track.format ? `<span>${escapeHtml(track.format)}</span>` : ""}<span>${TagcastI18n.html(player.fallback ? "player.quality.streamFallback" : "player.quality.stream", {stream})}</span></div>${track.composers?.length ? `<p class="listening-composers">${TagcastI18n.html("listening.track.composers", {names: track.composers.join(", ")})}</p>` : ""}`;
}

function updateListeningFacts() {
  const track = player.queue[player.index], facts = $("#now-playing-current").querySelector("#listening-facts");
  if (facts && track) facts.innerHTML = listeningTrackMetadata(track).split('</div>')[0].replace(/^<div[^>]*>/, "");
}

// Reuse the normal reviewed track editor. Opening it never writes or adopts lyric text.
async function editListeningTrack(id, albumId) {
  if (!live() || state.loading || opening || document.querySelector("dialog[open]")) return;
  const details = state.details, request = libraryLoadRequest;
  await openEditor(shelfIds(albumId));
  if (details === state.details && request === libraryLoadRequest && $("#editor").open
      && editing?.originals.some(album => album.tracks.some(track => String(track.id) === id))) {
    editTrack(id);
    $("#track-inline").querySelector("input")?.focus();
  }
}
document.addEventListener("click", event => {
  const button = event.target.closest("[data-listening-edit]");
  if (button && !button.disabled) void editListeningTrack(button.dataset.listeningEdit, button.dataset.listeningAlbum);
});

function syncNowPlayingPage() {
  const page = state.screen === "now-playing", host = $("#listening-page"), panel = $("#now-playing-panel");
  host.hidden = !page;
  document.body.classList.toggle("listening-page-open", page);
  $("#player-queue").classList.toggle("active", page);
  if (page) {
    if (panel.parentElement !== host) host.appendChild(panel);
    panel.hidden = visualPlayer.open;
    document.body.classList.remove("now-playing-open");
    $("#player-queue").setAttribute("aria-expanded", String(!visualPlayer.open));
  } else if (nowPlayingPresentation.page) {
    $("#player-extras-home").before?.(panel);
    panel.hidden = true;
    $("#player-queue").setAttribute("aria-expanded", "false");
  }
  const footer = $(".now-playing-footer"), actions = $("#queue-heading-actions");
  if (page && footer.parentElement !== actions) actions.appendChild(footer);
  else if (!page && footer.parentElement !== panel) panel.appendChild(footer);
  nowPlayingPresentation.page = page;
  if (page) renderNowPlaying();
  renderPlaybackLyrics();
  renderLyricsCoverBackground();
  placePlayerExtras();
  if (typeof applyVisualizer === "function") applyVisualizer();
}

function closeNowPlayingView() {
  if (state.screen === "now-playing") goBack("artists");
  else setNowPlaying(false);
  const focus = typeof workspacePanel !== "undefined" ? workspacePanel.focus : null;
  const fallback = $("#sidebar").hidden ? $("#workspace-panel-toggle") : $("#player-queue");
  (focus?.isConnected ? focus : fallback).focus();
}

// Keep the same ratings beside the transport and Sound in the sidebar.
function placePlayerExtras() {
  const ratingsHost = $("#player-rating-slot");
  const soundHost = $("#sidebar-sound");
  if (ratingsHost && nowPlayingPresentation.ratings.parentElement !== ratingsHost) ratingsHost.appendChild(nowPlayingPresentation.ratings);
  nowPlayingPresentation.sound.disabled = !player.queue[player.index];
  if (soundHost && nowPlayingPresentation.sound.parentElement !== soundHost) soundHost.appendChild(nowPlayingPresentation.sound);
}

function listeningMeterFace(channel) {
  // Original meter artwork. A digital reference (0 VU = -18 dBFS RMS), not speaker SPL.
  const point = (angle, r) => {
    const radians = angle * Math.PI / 180;
    return `${(150 + Math.sin(radians) * r).toFixed(2)} ${(190 - Math.cos(radians) * r).toFixed(2)}`;
  };
  const angle = db => -50 + (Math.pow(10, db / 20) - .1) / (Math.pow(10, 3 / 20) - .1) * 100;
  const arc = (from, to, radius) => `M${point(angle(from), radius)}A${radius} ${radius} 0 0 1 ${point(angle(to), radius)}`;
  const marks = [-20, -15, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3];
  const ticks = marks.map(db => `<path d="M${point(angle(db), 127)}L${point(angle(db), db === 0 ? 144 : 139)}"${db > 0 ? ' class="vu-hot"' : ""}/>`).join("");
  const labels = marks.filter(db => db !== -15).map(db => `<text x="${point(angle(db), 151).split(" ")[0]}" y="${Number(point(angle(db), 151).split(" ")[1]) - 3}" text-anchor="middle"${db > 0 ? ' class="vu-hot"' : ""}>${Math.abs(db)}</text>`).join("");
  return `<div class="vu-housing"><svg class="vu-face" viewBox="0 0 300 186" aria-hidden="true"><defs>
    <radialGradient id="vu-lamp-${channel}" cx="50%" cy="95%" r="100%"><stop stop-color="#fff3bf"/><stop offset=".55" stop-color="#ebd391"/><stop offset="1" stop-color="#9c8350"/></radialGradient>
    <linearGradient id="vu-glass-${channel}" x2=".15" y2="1"><stop stop-color="#ffffff" stop-opacity=".16"/><stop offset=".45" stop-color="#ffffff" stop-opacity="0"/><stop offset="1" stop-color="#ffffff" stop-opacity=".05"/></linearGradient>
    <linearGradient id="vu-shade-${channel}" x2="0" y2="1"><stop stop-color="#171106" stop-opacity=".55"/><stop offset=".3" stop-color="#171106" stop-opacity="0"/><stop offset="1" stop-color="#171106" stop-opacity=".12"/></linearGradient>
    <clipPath id="vu-window-${channel}"><rect x="9" y="9" width="282" height="156" rx="3"/></clipPath></defs>
    <rect class="vu-paper" x="9" y="9" width="282" height="156" rx="3" fill="url(#vu-lamp-${channel})"/>
    <g clip-path="url(#vu-window-${channel})"><path class="vu-arc" d="${arc(-20, 3, 127)}"/><path class="vu-red-zone" d="${arc(0, 3, 123)}"/>${ticks}${labels}
    <text class="vu-title" x="29" y="43">VU</text><text class="vu-channel" x="150" y="145" text-anchor="middle">${channel}</text><text x="23" y="135">−</text><text class="vu-hot" x="273" y="135">+</text>
    <g class="vu-needle" style="transform:rotate(-50deg)"><path class="vu-needle-shadow" d="M152 192V53"/><path d="M150 190V51"/></g>
    <rect x="9" y="9" width="282" height="156" fill="url(#vu-shade-${channel})" stroke="none"/>
    <path d="M9 9h282v26L9 72Z" fill="url(#vu-glass-${channel})" stroke="none"/></g>
    <rect class="vu-glass-edge" x="9" y="9" width="282" height="156" rx="3"/>
    <text class="vu-caption" x="150" y="180" text-anchor="middle">TAGCAST · ${channel}</text></svg></div>`;
}

function renderListeningExtras(track, focused) {
  const focus = nowPlayingPresentation.ratings.contains?.(focused) ? focused : null;
  // Never replace the rating controls themselves when the current-track markup is refreshed.

  placePlayerExtras();
  renderLyricsCoverBackground();
  renderPlaybackLyrics();
  if (focus) focus.focus({preventScroll: true});
  const host = $("#listening-meter");
  nowPlayingPresentation.needles = []; nowPlayingPresentation.spectrum = null;
  if (!host) return;
  const available = track && state.screen === "now-playing" && visualizerSupported() && !visualizerReducedMotion();
  host.hidden = !available || nowPlayingPreferences.meter === "off";
  if (!host.hidden && nowPlayingPreferences.meter === "vu") {
    host.innerHTML = listeningMeterFace("L") + listeningMeterFace("R");
    nowPlayingPresentation.needles = [...host.querySelectorAll(".vu-needle")];
  } else if (!host.hidden) {
    host.innerHTML = '<canvas class="listening-spectrum" aria-hidden="true"></canvas>';
    nowPlayingPresentation.spectrum = host.querySelector("canvas");
  }
}

function listeningMeterActive() {
  return typeof nowPlayingPreferences !== "undefined" && state.screen === "now-playing" && !visualPlayer.open
    && nowPlayingPreferences.meter !== "off" && !visualizerReducedMotion() && visualizerSupported()
    && Boolean(player.queue[player.index]);
}

function drawListeningMeter(dt, channels, levels) {
  if (!listeningMeterActive()) return;
  if (nowPlayingPreferences.meter === "vu") {
    for (let i = 0; i < 2; i++) {
      let power = 0;
      const samples = channels?.[i];
      if (samples) for (const sample of samples) power += sample * sample;
      const rms = samples?.length ? Math.sqrt(power / samples.length) : 0;
      const target = Math.max(0, Math.min(1, (rms * Math.pow(10, 18 / 20) - .1) / (Math.pow(10, 3 / 20) - .1)));
      nowPlayingPresentation.vu[i] += (target - nowPlayingPresentation.vu[i]) * (1 - Math.exp(-dt / 300));
      if (nowPlayingPresentation.needles[i]) nowPlayingPresentation.needles[i].style.transform = `rotate(${-50 + 100 * nowPlayingPresentation.vu[i]}deg)`;
    }
  } else {
    const canvas = nowPlayingPresentation.spectrum, g = canvas?.getContext("2d");
    if (!g) return;
    const w = canvas.width = Math.max(1, canvas.clientWidth * (window.devicePixelRatio || 1));
    const h = canvas.height = Math.max(1, canvas.clientHeight * (window.devicePixelRatio || 1));
    g.fillStyle = getComputedStyle(canvas).color;
    levels.forEach((v, i) => g.fillRect(i * w / levels.length, h * (1 - v), w / levels.length * .6, h * v));
  }
}

document.addEventListener("change", event => {
  const choices = {"now-playing-open": ["open", ["page", "panel"], "tagcast-now-playing-open"],
    "player-transport-style": ["transport", ["compact", "spacious"], "tagcast-player-transport"],
    "now-playing-meter": ["meter", ["off", "spectrum", "vu"], "tagcast-now-playing-meter"]};
  const choice = choices[event.target?.id];
  if (!choice || !choice[1].includes(event.target.value)) return;
  nowPlayingPreferences[choice[0]] = event.target.value;
  try { localStorage.setItem(choice[2], event.target.value); } catch { /* private window */ }
  applyNowPlayingPreferences();
});
function applyNowPlayingPreferences() {
  document.documentElement.dataset.playerTransport = nowPlayingPreferences.transport;
  gaplessControls.spacious = nowPlayingPreferences.transport === "spacious";
  gaplessRenderTransport();
  renderNowPlaying();
  applyVisualizer();
}
applyNowPlayingPreferences();

// Keep the fixed listening workspace above either transport, including wrapped metadata.
function updateListeningPlayerSize() {
  const bar = $("#player");
  document.documentElement.style.setProperty("--listening-player-height",
    `${bar.hidden ? 0 : Math.ceil(bar.getBoundingClientRect().height)}px`);
}
const listeningPlayerSizeObserver = typeof ResizeObserver === "function"
  ? new ResizeObserver(updateListeningPlayerSize) : null;
listeningPlayerSizeObserver?.observe($("#player"));
