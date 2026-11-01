"use strict";

// Optional spectrum for the compact player. It only listens: captureStream() taps the
// existing audio element, so playback, volume, output selection (setSinkId) and gapless
// MediaSource playback all stay on that element. Nothing here starts, stops, seeks or
// reroutes audio, and the analyser is never connected to an audio output.

const VISUALIZER_MODES = ["off", "title", "cover", "edge"];
const VISUALIZER_LABELS = {off: "Off", title: "Next to the title", cover: "Over the cover", edge: "Along the top edge"};
const VISUALIZER_BANDS = 16;
const visualizerNarrowQuery = typeof matchMedia === "function" ? matchMedia("(max-width: 760px)") : null;
const visualizer = {mode: storedVisualizerMode(), context: null, analyser: null, source: null, track: null,
  stream: null, bins: null, levels: new Float32Array(VISUALIZER_BANDS), peak: 0.35, frame: 0, last: 0,
  canvas: null, colour: "", colourAge: 0, row: null, rowSearch: 0};

function visualizerReducedMotion() {
  try { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; }
  catch { return false; }
}

// A stored choice wins; without one, reduced motion starts with the spectrum off.
function storedVisualizerMode() {
  try {
    const stored = localStorage.getItem("tagcast-player-visualizer");
    if (VISUALIZER_MODES.includes(stored)) return stored;
  } catch { /* private window */ }
  return visualizerReducedMotion() ? "off" : "title";
}

function visualizerSupported() {
  return typeof audio !== "undefined" && typeof audio.captureStream === "function"
    && typeof AudioContext === "function" && typeof MediaStream === "function";
}

// Along the top edge needs the wide player; narrow windows show it next to the title.
function visualizerActiveMode() {
  if (!visualizerSupported()) return "off";
  return visualizer.mode === "edge" && visualizerNarrowQuery?.matches ? "title" : visualizer.mode;
}

function setVisualizerMode(mode) {
  if (!VISUALIZER_MODES.includes(mode)) return;
  visualizer.mode = mode;
  try { localStorage.setItem("tagcast-player-visualizer", mode); } catch { /* private window */ }
  applyVisualizer();
}

function visualizerSettings() {
  const supported = visualizerSupported();
  const options = VISUALIZER_MODES.map(mode =>
    `<option value="${mode}" ${visualizer.mode === mode ? "selected" : ""}>${VISUALIZER_LABELS[mode]}</option>`).join("");
  const note = supported
    ? "Bars follow the music that is playing and also replace the speaker in the playing row of album and playlist tracklists. Along the top edge uses Next to the title in narrow windows. Playback, volume and audio output stay unchanged."
    : "This browser cannot share the playing audio with the page, so the spectrum is unavailable. Playback is unaffected.";
  return `<section class="player-visualizer-settings" data-settings-category="playback"><h3>Player spectrum <span class="settings-mode">Immediate · this browser</span></h3>
    <label>Spectrum in the compact player <select id="player-visualizer-mode" ${supported ? "" : "disabled"}>${options}</select></label>
    <p class="muted">${note}</p></section>`;
}

/**
 * Frequency data (dB per bin, as getFloatFrequencyData gives it) as `count` bands from bass
 * to treble on a logarithmic scale, each 0–1. Music loses about 3 dB per octave towards the
 * treble, like pink noise; a matching tilt around 1 kHz lets every bar move instead of only
 * the bass ones.
 */
function visualizerBands(freq, sampleRate, count = VISUALIZER_BANDS, low = 40, high = 16000) {
  const binHz = sampleRate / 2 / freq.length, out = new Array(count);
  for (let band = 0; band < count; band++) {
    const from = low * Math.pow(high / low, band / count), to = low * Math.pow(high / low, (band + 1) / count);
    const first = Math.min(freq.length - 1, Math.floor(from / binHz));
    const last = Math.min(freq.length, Math.max(first + 1, Math.ceil(to / binHz)));
    let power = 0;
    for (let i = first; i < last; i++) power += Math.pow(10, (Number.isFinite(freq[i]) ? freq[i] : -200) / 10);
    const tilt = 3 * Math.log2(Math.sqrt(from * to) / 1000);
    const db = 10 * Math.log10(power / (last - first) + 1e-20) + tilt;
    out[band] = Math.max(0, Math.min(1, (db + 90) / 60));
  }
  return out;
}

// Bars rise quickly and fall slowly; quiet and loud songs both use the full height.
function visualizerSmooth(fresh, dt) {
  const levels = visualizer.levels, rise = Math.min(1, dt / 30), fall = Math.min(1, dt / 160);
  let top = 0;
  if (fresh) for (const value of fresh) top = Math.max(top, value);
  visualizer.peak = Math.max(0.35, top, visualizer.peak * Math.pow(0.9993, dt));
  for (let i = 0; i < levels.length; i++) {
    const target = fresh ? Math.min(1, fresh[i] / visualizer.peak) : 0;
    levels[i] += (target - levels[i]) * (target > levels[i] ? rise : fall);
  }
}

function visualizerLevelAt(fraction) {
  const levels = visualizer.levels, x = Math.max(0, Math.min(levels.length - 1, fraction * (levels.length - 1)));
  const i = Math.floor(x), next = Math.min(levels.length - 1, i + 1);
  return levels[i] + (levels[next] - levels[i]) * (x - i);
}

// The capture follows the element: each new source adds a track, and only the newest is heard.
function connectVisualizerTrack(track) {
  if (!track || track.kind !== "audio" || track === visualizer.track || !visualizer.context) return;
  try {
    const source = visualizer.context.createMediaStreamSource(new MediaStream([track]));
    source.connect(visualizer.analyser);
    visualizer.source?.disconnect();
    if (visualizer.track && visualizer.track.readyState !== "ended") visualizer.track.stop();
    visualizer.source = source; visualizer.track = track;
  } catch { /* a track that ended meanwhile; the next one connects */ }
}

function ensureVisualizerGraph() {
  if (visualizer.context || visualizerActiveMode() === "off") return;
  try {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0.5;
    visualizer.context = context; visualizer.analyser = analyser;
    visualizer.bins = new Float32Array(analyser.frequencyBinCount);
    visualizer.stream = audio.captureStream();
    visualizer.stream.addEventListener("addtrack", event => connectVisualizerTrack(event.track));
    connectVisualizerTrack(visualizer.stream.getAudioTracks().filter(track => track.readyState === "live").pop());
  } catch {
    visualizer.context = null; visualizer.analyser = null; visualizer.stream = null;
  }
}

function visualizerCanvas() {
  if (!visualizer.canvas) {
    const canvas = document.createElement("canvas");
    canvas.className = "player-visualizer";
    canvas.setAttribute("aria-hidden", "true");
    visualizer.canvas = canvas;
  }
  return visualizer.canvas;
}

// Puts the bars where the chosen style draws them; the player's own elements stay unchanged.
function placeVisualizer(mode) {
  const title = $("#player-title"), text = title?.parentElement, cover = $("#player-cover-button"), bar = $("#player");
  text?.classList.toggle("has-visualizer", mode === "title");
  cover?.classList.toggle("has-visualizer", mode === "cover");
  if (mode === "off") { visualizer.canvas?.remove(); return; }
  const canvas = visualizerCanvas();
  canvas.dataset.style = mode;
  if (mode === "title" && title) title.after(canvas);
  else if (mode === "cover" && cover) cover.append(canvas);
  else if (mode === "edge" && bar) bar.append(canvas);
  visualizer.colourAge = 0;
}

function applyVisualizer() {
  const mode = visualizerActiveMode();
  document.documentElement.dataset.playerVisualizer = mode;
  placeVisualizer(mode);
  if (mode === "off") { stopVisualizer(); return; }
  if (!audio.paused) { ensureVisualizerGraph(); visualizer.context?.resume?.().catch(() => {}); }
  startVisualizer();
}

function startVisualizer() {
  if (visualizer.frame || typeof requestAnimationFrame !== "function" || visualizerActiveMode() === "off") return;
  visualizer.last = 0;
  visualizer.frame = requestAnimationFrame(visualizerFrame);
}

function stopVisualizer() {
  if (visualizer.frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(visualizer.frame);
  visualizer.frame = 0;
  visualizer.levels.fill(0);
  drawVisualizer(visualizerActiveMode());
  markVisualizerRow(true);
}

function visualizerFrame(time) {
  visualizer.frame = 0;
  const mode = visualizerActiveMode();
  if (mode === "off" || document.hidden) return;
  const dt = visualizer.last ? Math.min(100, time - visualizer.last) : 16;
  visualizer.last = time;
  const listening = visualizer.analyser && !audio.paused && visualizer.context?.state === "running";
  let fresh = null;
  if (listening) {
    visualizer.analyser.getFloatFrequencyData(visualizer.bins);
    fresh = visualizerBands(visualizer.bins, visualizer.context.sampleRate);
  }
  visualizerSmooth(fresh, dt);
  drawVisualizer(mode);
  markVisualizerRow(false);
  // Once paused bars have settled, the loop stops until playback resumes.
  if (listening || visualizer.levels.some(level => level > 0.004)) visualizer.frame = requestAnimationFrame(visualizerFrame);
  else markVisualizerRow(true);
}

function drawVisualizer(mode) {
  const canvas = visualizer.canvas;
  if (!canvas?.isConnected || mode === "off") return;
  const ratio = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  }
  const g = canvas.getContext("2d");
  if (!g) return;
  if (visualizer.colourAge-- <= 0 && typeof getComputedStyle === "function") {
    visualizer.colour = getComputedStyle(canvas).color; visualizer.colourAge = 60;
  }
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, width, height);
  if (mode === "cover") {
    const shade = g.createLinearGradient(0, 0, 0, height);
    shade.addColorStop(0, "rgba(0,0,0,0)"); shade.addColorStop(1, "rgba(0,0,0,.72)");
    g.fillStyle = shade; g.fillRect(0, 0, width, height);
  }
  g.fillStyle = visualizer.colour || "#fff";
  const bar = (x, y, w, h) => { if (g.roundRect) { g.beginPath(); g.roundRect(x, y, w, h, w / 2); g.fill(); } else g.fillRect(x, y, w, h); };
  if (mode === "title") { // ten slim bars from the middle line
    const count = 10, w = 2.5, gap = (width - count * w) / (count - 1);
    for (let i = 0; i < count; i++) {
      const h = Math.max(w, visualizerLevelAt(i / (count - 1)) * height);
      bar(i * (w + gap), (height - h) / 2, w, h);
    }
  } else if (mode === "cover") { // six bars standing on the cover's lower edge
    const count = 6, w = 3, inset = 6, gap = (width - inset * 2 - count * w) / (count - 1), floor = height - 4;
    for (let i = 0; i < count; i++) {
      const h = Math.max(2, visualizerLevelAt(i / (count - 1)) * (floor - 3));
      bar(inset + i * (w + gap), floor - h, w, h);
    }
  } else { // a fine row hanging from the player's top edge
    const w = 3, count = Math.max(2, Math.floor(width / 7)), gap = (width - count * w) / (count - 1);
    for (let i = 0; i < count; i++) {
      const h = Math.max(1, visualizerLevelAt(i / (count - 1)) * height);
      g.fillRect(i * (w + gap), 0, w, h);
    }
  }
}

// The playing row's speaker becomes four small bars (visualizer.css draws them from these values).
function markVisualizerRow(clear) {
  let row = visualizer.row;
  if (row && (clear || !row.isConnected || !row.classList.contains("playing"))) {
    for (let i = 0; i < 4; i++) row.style.removeProperty(`--player-eq-${i}`);
    row = visualizer.row = null;
  }
  if (clear) return;
  if (!row && visualizer.rowSearch-- <= 0) {
    row = visualizer.row = document.querySelector(".album-tracklist tr.playing");
    visualizer.rowSearch = row ? 0 : 20;
  }
  if (row) for (let i = 0; i < 4; i++) row.style.setProperty(`--player-eq-${i}`, visualizerLevelAt(i / 3).toFixed(3));
}

audio.addEventListener("play", () => {
  if (visualizerActiveMode() === "off") return;
  ensureVisualizerGraph();
  visualizer.context?.resume?.().catch(() => {});
  startVisualizer();
});
for (const name of ["playing", "pause", "ended", "emptied"]) audio.addEventListener(name, startVisualizer);
document.addEventListener("visibilitychange", () => { if (!document.hidden) startVisualizer(); });
document.addEventListener("change", event => {
  if (event.target?.id === "player-visualizer-mode") setVisualizerMode(event.target.value);
});
visualizerNarrowQuery?.addEventListener?.("change", applyVisualizer);
applyVisualizer();
