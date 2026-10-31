"use strict";
const fs = require("node:fs"), path = require("node:path");

function windowSize(file, defaults, area) {
  let saved = {};
  try { if (file && fs.statSync(file).size <= 4096) saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first use or invalid preference */ }
  const valid = value => Number.isInteger(value) && value > 0 && value <= 50000;
  if (!valid(saved?.width) || !valid(saved?.height)) saved = {};
  const minWidth = Math.min(defaults.minWidth, area.width), minHeight = Math.min(defaults.minHeight, area.height);
  return {width: Math.max(minWidth, Math.min(saved.width || defaults.width, area.width)),
    height: Math.max(minHeight, Math.min(saved.height || defaults.height, area.height)), minWidth, minHeight};
}

function rememberWindowSize(window, file) {
  if (!file) return () => {};
  let timer;
  const save = () => {
    clearTimeout(timer);
    if (window.isDestroyed()) return;
    try {
      // Never save the temporary maximized/fullscreen dimensions as the normal size.
      const {width, height} = window.getNormalBounds();
      if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 50000)) return;
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file + ".tmp", JSON.stringify({width, height}), {mode: 0o600});
      fs.renameSync(file + ".tmp", file);
    } catch { /* optional preference must not block opening or closing */ }
  };
  window.on("resize", () => { clearTimeout(timer); timer = setTimeout(save, 250); });
  window.on("close", save);
  window.on("closed", () => clearTimeout(timer));
  return save;
}

module.exports = {windowSize, rememberWindowSize};
