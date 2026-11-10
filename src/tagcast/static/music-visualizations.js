"use strict";

// Presentation-only listeners of visualizer.js's existing captureStream graph.
// Butterchurn receives sample arrays, never an AudioContext or an output node.
const MUSIC_VISUAL_EFFECTS = ["aurora", "orbit", "ribbons", "led", "scope", "radial", "stars", "waterfall"];
const MUSIC_VISUAL_MODES = ["off", "random", ...MUSIC_VISUAL_EFFECTS];
const MUSIC_VISUAL_CANVAS = ["led", "scope", "radial", "stars", "waterfall"];
const musicVisualization = {mode: storedMusicVisualization(), canvas: null, renderer: null,
  generation: 0, pending: false, failed: false, loader: null, last: 0, width: 0, height: 0,
  bytes: new Uint8Array(1024), samples: new Float32Array(2048), message: "",
  effect: null, shuffle: [], activeSeconds: 0, phase: 0};

// Shuffle a bounded local bag. Every effect gets a turn; avoid repeats across bags too.
function nextMusicVisualization() {
  if (!musicVisualization.shuffle.length) {
    const bag = [...MUSIC_VISUAL_EFFECTS];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    if (bag[0] === musicVisualization.effect) [bag[0], bag[1]] = [bag[1], bag[0]];
    musicVisualization.shuffle = bag;
  }
  return musicVisualization.shuffle.shift();
}

function advanceMusicVisualization() {
  const effect = nextMusicVisualization();
  musicVisualization.activeSeconds = 0;
  // MilkDrop-to-MilkDrop changes share one renderer with a gentle transition.
  if (musicVisualization.renderer && !MUSIC_VISUAL_CANVAS.includes(effect)) {
    musicVisualization.renderer.loadPreset(musicVisualizationPreset(effect), 2);
    musicVisualization.effect = effect;
  } else {
    releaseMusicVisualization();
    musicVisualization.effect = effect;
    prepareMusicVisualization();
  }
}

function storedMusicVisualization() {
  try {
    const value = localStorage.getItem("tagcast-fullscreen-visualization");
    if (MUSIC_VISUAL_MODES.includes(value)) return value;
  } catch { /* private window */ }
  return "off";
}

function musicVisualizationActive() {
  return visualPlayer.open && musicVisualization.mode !== "off" && !musicVisualization.failed
    && !visualizerReducedMotion() && visualizerSupported() && !document.hidden;
}

function musicVisualizationOptions() {
  return MUSIC_VISUAL_MODES.map(mode => `<option value="${mode}"${musicVisualization.mode === mode ? " selected" : ""}>${TagcastI18n.html(`musicVisual.${mode}`)}</option>`).join("");
}

function musicVisualizationSettings() {
  return `<section class="player-visualizer-settings" data-settings-category="playback"><h3>${TagcastI18n.html("musicVisual.heading")} <span class="settings-mode">${TagcastI18n.html("settings.mode.immediate")}</span></h3>
    <label>${TagcastI18n.html("musicVisual.label")} <select id="music-visualization-setting">${musicVisualizationOptions()}</select></label>
    <p class="muted">${TagcastI18n.html("musicVisual.note")}</p></section>`;
}

function musicVisualizationLabels() {
  if (typeof renderVisualDisc === "function") renderVisualDisc();
  const choice = $("#music-visualization-mode");
  if (choice) choice.innerHTML = musicVisualizationOptions();
  const setting = $("#music-visualization-setting");
  if (setting) setting.value = musicVisualization.mode;
  const status = $("#music-visualization-status");
  if (status) {
    status.textContent = musicVisualization.message ? TagcastI18n.text(musicVisualization.message) : "";
    status.hidden = !visualPlayer.open || !musicVisualization.message;
  }
}

function releaseMusicVisualization() {
  musicVisualization.generation++;
  musicVisualization.pending = false;
  const renderer = musicVisualization.renderer, canvas = musicVisualization.canvas;
  musicVisualization.renderer = null; musicVisualization.canvas = null;
  musicVisualization.last = 0; musicVisualization.width = 0; musicVisualization.height = 0;
  // Butterchurn has no destroy API. Release all GPU resources, including feedback textures.
  try { renderer?.renderer.gl.getExtension("WEBGL_lose_context")?.loseContext(); }
  catch { /* context already lost */ }
  canvas?.remove();
}

function failMusicVisualization() {
  musicVisualization.failed = true;
  musicVisualization.message = "musicVisual.failed";
  syncMusicVisualization();
}

function loadMusicVisualizationLibrary() {
  if (globalThis.butterchurn?.default?.createVisualizer) return Promise.resolve();
  if (musicVisualization.loader) return musicVisualization.loader;
  const pending = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timer = setTimeout(() => finish(new Error("Visualization load timeout")), 8000);
    function finish(error) {
      clearTimeout(timer); script.onload = null; script.onerror = null; script.remove();
      if (error) reject(error); else resolve();
    }
    script.src = "vendor/butterchurn/butterchurn.js";
    script.onload = () => finish(globalThis.butterchurn?.default?.createVisualizer ? null : new Error("Visualization unavailable"));
    script.onerror = () => finish(new Error("Visualization unavailable"));
    document.head.append(script);
  });
  musicVisualization.loader = pending;
  pending.finally(() => { if (musicVisualization.loader === pending) musicVisualization.loader = null; }).catch(() => {});
  return pending;
}

// Original, bounded function presets; no imported equations or remote image dependencies.
function musicVisualizationPreset(mode) {
  const variant = {aurora: 0, orbit: 1, ribbons: 2}[mode] || 0;
  return {baseVals: {decay: .96, gammaadj: 1.7, wave_a: .85, wave_scale: 1.1,
    wave_mode: variant === 1 ? 0 : 7, wave_thick: 1, additivewave: 1, wave_smoothing: .65,
    warp: .3, zoom: 1.015, ob_a: .08, ob_size: .008}, shapes: [], waves: [],
  init_eqs: m => m,
  frame_eqs: m => {
    m.wave_r = .5 + .4 * Math.sin(m.time * .23 + variant * 2);
    m.wave_g = .5 + .4 * Math.sin(m.time * .19 + 2);
    m.wave_b = .65 + .3 * Math.sin(m.time * .17 + 4);
    m.zoom = 1.008 + Math.min(2, m.bass_att) * .008;
    m.rot = variant === 1 ? .007 : .002 * Math.sin(m.time * .3);
    m.warp = variant === 2 ? .08 : .25 + .08 * Math.sin(m.time * .2);
    return m;
  }, pixel_eqs: m => m, warp: "", comp: ""};
}

function musicVisualizationSize() {
  const host = $("#music-visualization-surface");
  const scale = Math.min(1, 1280 / Math.max(1, host.clientWidth), 720 / Math.max(1, host.clientHeight));
  return [Math.max(2, Math.round(host.clientWidth * scale)), Math.max(2, Math.round(host.clientHeight * scale))];
}

async function prepareMusicVisualization() {
  if (musicVisualization.canvas || musicVisualization.pending || !musicVisualizationActive()) return;
  if (!musicVisualization.effect) musicVisualization.effect = musicVisualization.mode === "random"
    ? nextMusicVisualization() : musicVisualization.mode;
  const generation = ++musicVisualization.generation, mode = musicVisualization.effect;
  musicVisualization.pending = true;
  musicVisualization.message = MUSIC_VISUAL_CANVAS.includes(mode) ? "" : "musicVisual.loading";
  musicVisualizationLabels();
  try {
    if (!MUSIC_VISUAL_CANVAS.includes(mode)) await loadMusicVisualizationLibrary();
    if (generation !== musicVisualization.generation || !musicVisualizationActive()) return;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    musicVisualization.canvas = canvas;
    $("#music-visualization-surface").append(canvas);
    const [width, height] = musicVisualizationSize();
    canvas.width = width; canvas.height = height;
    if (!MUSIC_VISUAL_CANVAS.includes(mode)) {
      canvas.addEventListener("webglcontextlost", event => {
        event.preventDefault();
        if (musicVisualization.canvas === canvas) failMusicVisualization();
      });
      musicVisualization.renderer = globalThis.butterchurn.default.createVisualizer(null, canvas,
        {width, height, pixelRatio: 1, textureRatio: 1, meshWidth: 32, meshHeight: 24});
      musicVisualization.renderer.loadPreset(musicVisualizationPreset(mode), 0);
    } else {
      const g = canvas.getContext("2d");
      if (!g) throw new Error("Canvas unavailable");
      g.fillStyle = "#080d0c"; g.fillRect(0, 0, width, height);
    }
    musicVisualization.width = width; musicVisualization.height = height;
    musicVisualization.message = "";
  } catch {
    if (generation === musicVisualization.generation) failMusicVisualization();
  } finally {
    if (generation === musicVisualization.generation) {
      musicVisualization.pending = false; musicVisualizationLabels();
    }
  }
}

function syncMusicVisualization() {
  const active = musicVisualizationActive(), stage = $("#visual-player");
  stage?.classList.toggle("music-visualization-active", active);
  const surface = $("#music-visualization-surface");
  if (surface) surface.hidden = !active;
  if (!active) {
    releaseMusicVisualization();
    if (!musicVisualization.failed) musicVisualization.message = visualPlayer.open && !document.hidden && musicVisualization.mode !== "off"
      ? (visualizerReducedMotion() ? "musicVisual.reduced" : "musicVisual.unsupported") : "";
  } else {
    if (!musicVisualization.pending) musicVisualization.message = "";
    if (!audio.paused) prepareMusicVisualization();
  }
  musicVisualizationLabels();
  // The shared graph is allocated only during playback, never by the settings page.
  applyVisualizer();
}

function setMusicVisualization(mode) {
  if (!MUSIC_VISUAL_MODES.includes(mode)) return;
  releaseMusicVisualization();
  musicVisualization.mode = mode; musicVisualization.failed = false; musicVisualization.message = "";
  musicVisualization.effect = mode === "random" ? null : mode;
  musicVisualization.shuffle = []; musicVisualization.activeSeconds = 0; musicVisualization.phase = 0;
  try { localStorage.setItem("tagcast-fullscreen-visualization", mode); } catch { /* private window */ }
  syncMusicVisualization();
}

function drawMusicVisualization(time, listening) {
  if (!musicVisualizationActive() || !listening || audio.seeking || audio.readyState < 3) {
    musicVisualization.last = 0;
    return;
  }
  if (!musicVisualization.canvas) { prepareMusicVisualization(); return; }
  if (musicVisualization.last && time - musicVisualization.last < 1000 / 30) return;
  const elapsed = musicVisualization.last ? Math.min(.1, (time - musicVisualization.last) / 1000) : 1 / 30;
  musicVisualization.last = time;
  try {
    musicVisualization.phase += elapsed;
    if (musicVisualization.mode === "random") {
      musicVisualization.activeSeconds += elapsed;
      if (musicVisualization.activeSeconds >= 30) { advanceMusicVisualization(); return; }
    }
    const canvas = musicVisualization.canvas, [width, height] = musicVisualizationSize();
    if (width !== musicVisualization.width || height !== musicVisualization.height) {
      if (musicVisualization.renderer) musicVisualization.renderer.setRendererSize(width, height);
      else {
        canvas.width = width; canvas.height = height;
        const g = canvas.getContext("2d");
        g.fillStyle = "#080d0c"; g.fillRect(0, 0, width, height);
      }
      musicVisualization.width = width; musicVisualization.height = height;
    }
    if (musicVisualization.renderer) {
      visualizer.analyser.getByteTimeDomainData(musicVisualization.bytes);
      const bytes = musicVisualization.bytes;
      musicVisualization.renderer.render({elapsedTime: elapsed,
        audioLevels: {timeByteArray: bytes, timeByteArrayL: bytes, timeByteArrayR: bytes}});
    } else {
      const g = canvas.getContext("2d"), mode = musicVisualization.effect;
      if (mode === "waterfall") {
        // A bounded canvas history, never retained samples or a second audio read.
        const step = Math.max(1, Math.round(height * elapsed * .12));
        g.drawImage(canvas, 0, 0, width, height - step, 0, step, width, height - step);
        for (let i = 0; i < 96; i++) {
          const level = Math.max(0, Math.min(1, visualizerLevelAt(i / 95)));
          g.fillStyle = `hsl(${260 - level * 230} 85% ${4 + level * 60}%)`;
          g.fillRect(i * width / 96, 0, Math.ceil(width / 96), step);
        }
        return;
      }
      g.fillStyle = "#080d0c"; g.fillRect(0, 0, width, height);
      if (mode === "radial") {
        const radius = Math.min(width, height) * .2, length = Math.min(width, height) * .26;
        g.lineWidth = Math.max(2, Math.min(width, height) / 150);
        g.lineCap = "round";
        for (let i = 0; i < 96; i++) {
          const angle = i / 96 * Math.PI * 2 - Math.PI / 2;
          const level = Math.max(0, Math.min(1, visualizerLevelAt((i < 48 ? i : 95 - i) / 47)));
          g.strokeStyle = `hsl(${i * 3.75 + musicVisualization.phase * 8} 85% 65%)`;
          g.beginPath();
          g.moveTo(width / 2 + Math.cos(angle) * radius, height / 2 + Math.sin(angle) * radius);
          g.lineTo(width / 2 + Math.cos(angle) * (radius + 3 + level * length), height / 2 + Math.sin(angle) * (radius + 3 + level * length));
          g.stroke();
        }
      } else if (mode === "stars") {
        const energy = Math.max(0, Math.min(1, visualizerLevelAt(.1)));
        // Deterministic positions avoid per-frame allocations and random flicker.
        for (let i = 0; i < 160; i++) {
          const angle = i * 2.399963, depth = (i / 160 + musicVisualization.phase * .09) % 1;
          const reach = depth * depth * Math.hypot(width, height) * .55;
          const x = width / 2 + Math.cos(angle) * reach, y = height / 2 + Math.sin(angle) * reach;
          g.strokeStyle = `hsla(${200 + i % 85} 85% 80% / ${.15 + depth * .85})`;
          g.lineWidth = 1 + depth * energy * 2;
          g.beginPath();g.moveTo(x, y);
          g.lineTo(x + Math.cos(angle) * depth * (3 + energy * 35), y + Math.sin(angle) * depth * (3 + energy * 35));g.stroke();
        }
      } else if (mode === "scope") {
        g.strokeStyle = "#14322a"; g.lineWidth = 1;
        g.beginPath();
        for (let x = 0; x <= width; x += width / 16) { g.moveTo(x, 0); g.lineTo(x, height); }
        for (let y = 0; y <= height; y += height / 10) { g.moveTo(0, y); g.lineTo(width, y); }
        g.stroke();
        visualizer.analyser.getFloatTimeDomainData(musicVisualization.samples);
        g.strokeStyle = "#9cf9b5"; g.lineWidth = 2; g.shadowColor = "#59ed96"; g.shadowBlur = 10;
        g.beginPath();
        const samples = musicVisualization.samples;
        // Align to a rising zero crossing to steady a periodic waveform.
        let start = 0;
        for (let i = 1; i < 512; i++) if (samples[i - 1] <= 0 && samples[i] > 0) { start = i; break; }
        for (let i = 0; i < 1024; i++) {
          const x = i / 1023 * width, y = height / 2 - samples[start + i] * height * .42;
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.stroke(); g.shadowBlur = 0;
      } else {
        const columns = 32, rows = 24, inset = width * .06, gap = 3;
        const cellWidth = (width - inset * 2) / columns, cellHeight = height * .68 / rows;
        for (let x = 0; x < columns; x++) for (let y = 0; y < rows; y++) {
          const lit = y < visualizerLevelAt(x / (columns - 1)) * rows;
          g.fillStyle = lit ? (y > 20 ? "#ff6e53" : y > 15 ? "#ffd36b" : "#dfaa55") : "#26251c";
          g.fillRect(inset + x * cellWidth, height * .82 - (y + 1) * cellHeight, Math.max(1, cellWidth - gap), Math.max(1, cellHeight - gap));
        }
      }
    }
  } catch { failMusicVisualization(); }
}

document.addEventListener("change", event => {
  if (["music-visualization-mode", "music-visualization-setting"].includes(event.target?.id)) setMusicVisualization(event.target.value);
});
// Choosing Cover or CD returns to the existing presentation explicitly.
for (const id of ["#visual-player-cover-toggle", "#visual-player-disc-toggle"]) {
  $(id)?.addEventListener("click", () => setMusicVisualization("off"));
}
for (const name of ["play", "playing", "emptied"]) audio.addEventListener(name, syncMusicVisualization);
document.addEventListener("visibilitychange", syncMusicVisualization);
if (typeof matchMedia === "function") matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", syncMusicVisualization);
TagcastI18n.subscribe(musicVisualizationLabels);
musicVisualizationLabels();
