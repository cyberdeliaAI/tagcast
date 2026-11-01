"use strict";

// A presentation snapshot only. No stream URLs, account data or renderer objects.
const themeRoles = Object.freeze(["brand-background", "brand-ink", "brand-paper", "sidebar", "accent", "shell-ink", "shell-muted", "shell-active", "shell-line", "ink", "muted", "paper", "line", "link", "surface", "soft", "tint", "focus", "primary", "primary-hover", "chart", "primary-ink", "nav-icon"]);
const actions = new Set(["play", "pause", "previous", "next", "seek"]);
function command(value) {
  if (!value || !actions.has(value.action) || !["document", "entry", "segment"].every(key => typeof value[key] === "string" && value[key].length <= 100)) return null;
  if (value.action === "seek" && (!Number.isFinite(value.position) || value.position < 0 || value.position > 604800)) return null;
  return {action: value.action, document: value.document, entry: value.entry, segment: value.segment,
    ...(value.action === "seek" ? {position: value.position} : {})};
}
function snapshot(value) {
  if (!value || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      !["document", "entry", "segment"].every(key => typeof value[key] === "string" && value[key].length <= 100)) return null;
  const text = (key, limit = 1000) => typeof value[key] === "string" ? value[key].slice(0, limit) : "";
  let cover = "";
  try { const url = new URL(value.cover); if (url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2048) cover = url.href; } catch { /* missing artwork */ }
  const duration = Number.isFinite(value.duration) ? Math.max(0, Math.min(604800, value.duration)) : 0;
  return {document: value.document, entry: value.entry, segment: value.segment, sequence: value.sequence,
    title: text("title"), artist: text("artist"), album: text("album"), status: text("status", 240), cover,
    position: Number.isFinite(value.position) ? Math.max(0, Math.min(duration, value.position)) : 0, duration,
    paused: value.paused === true, controllable: value.controllable === true, seekable: value.seekable === true,
    previous: value.previous === true, next: value.next === true,
    colours: Object.fromEntries(themeRoles.filter(role => typeof value.colours?.[role] === "string" && /^#[0-9a-f]{6}$/i.test(value.colours[role])).map(role => [role, value.colours[role].toLowerCase()])),
    theme: value.theme === "dark" ? "dark" : "light",
    palette: ["ocean", "warm", "ibroadcast", "apple"].includes(value.palette) ? value.palette : "forest"};
}
function bounds(value, area) {
  const width = Math.max(420, Math.min(area.width, Number.isFinite(value?.width) ? value.width : 500));
  const height = Math.max(210, Math.min(area.height, Number.isFinite(value?.height) ? value.height : 210));
  return {width: Math.round(width), height: Math.round(height),
    x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, Number.isFinite(value?.x) ? value.x : area.x + (area.width - width) / 2))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, Number.isFinite(value?.y) ? value.y : area.y + 80)))};
}
module.exports = {command, snapshot, bounds, themeRoles};
