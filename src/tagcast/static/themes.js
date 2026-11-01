"use strict";

// Colour values only. Kept synchronous so saved appearance is restored before first paint.
globalThis.TagcastThemes = (() => {
  const key = "tagcast-custom-themes", limit = 20;
  // Preview defaults mirror palettes.css; tests guard parity. Saved themes contain overrides only.
  const bases = {"forest":{"light":{"brand-background":"#52745a","brand-ink":"#20382a","brand-paper":"#fff7de","sidebar":"#1e3027","accent":"#d2e59e","shell-ink":"#dce7de","shell-muted":"#b5c6b8","shell-active":"#344b3d","shell-line":"#3a4e40","ink":"#203329","muted":"#68746c","paper":"#f7f8f4","line":"#e0e5dd","link":"#2d654d","surface":"#ffffff","soft":"#fbfcf9","tint":"#eef4e2","focus":"#759345","primary":"#2d654d","primary-hover":"#24553f","chart":"#5f8a4a","primary-ink":"#ffffff"},"dark":{"brand-background":"#52745a","brand-ink":"#20382a","brand-paper":"#fff7de","sidebar":"#1e3027","accent":"#d2e59e","shell-ink":"#dce7de","shell-muted":"#b5c6b8","shell-active":"#344b3d","shell-line":"#3a4e40","ink":"#d4e8db","muted":"#a8b6ad","paper":"#121915","line":"#36483b","link":"#a9c281","surface":"#1b2520","soft":"#18211c","tint":"#26372d","focus":"#9cbd6a","primary":"#3e8a62","primary-hover":"#469a6e","chart":"#52a874","primary-ink":"#ffffff"}},"ocean":{"light":{"brand-background":"#32768b","brand-ink":"#172d38","brand-paper":"#fff7de","sidebar":"#172d38","accent":"#9bdce7","shell-ink":"#e8f3f7","shell-muted":"#b2c8d3","shell-active":"#294958","shell-line":"#435e6b","ink":"#213746","muted":"#536b7a","paper":"#f5f8fa","line":"#d7e3e9","link":"#246276","surface":"#ffffff","soft":"#f0f5f8","tint":"#e5f0f4","focus":"#559bac","primary":"#246276","primary-hover":"#1e5366","chart":"#35869a","primary-ink":"#ffffff"},"dark":{"brand-background":"#32768b","brand-ink":"#172d38","brand-paper":"#fff7de","sidebar":"#172d38","accent":"#9bdce7","shell-ink":"#e8f3f7","shell-muted":"#b2c8d3","shell-active":"#294958","shell-line":"#435e6b","ink":"#e0eef3","muted":"#afc4cf","paper":"#101f28","line":"#344956","link":"#90d9e6","surface":"#1a2d38","soft":"#162731","tint":"#233f4c","focus":"#67b8cb","primary":"#286b7b","primary-hover":"#307e90","chart":"#65bfd0","primary-ink":"#ffffff"}},"warm":{"light":{"brand-background":"#9b673e","brand-ink":"#39291f","brand-paper":"#fff0d6","sidebar":"#33281f","accent":"#efc99e","shell-ink":"#f7eee3","shell-muted":"#d0bfae","shell-active":"#574233","shell-line":"#735b48","ink":"#3b2c23","muted":"#76614f","paper":"#faf7f2","line":"#e6dcd0","link":"#805334","surface":"#fffefa","soft":"#f7f1e8","tint":"#f0e4d6","focus":"#b18459","primary":"#805334","primary-hover":"#6b442b","chart":"#a4774d","primary-ink":"#ffffff"},"dark":{"brand-background":"#9b673e","brand-ink":"#39291f","brand-paper":"#fff0d6","sidebar":"#33281f","accent":"#efc99e","shell-ink":"#f7eee3","shell-muted":"#d0bfae","shell-active":"#574233","shell-line":"#735b48","ink":"#f2e8dc","muted":"#c7b6a5","paper":"#211a15","line":"#564336","link":"#e6bf96","surface":"#30251d","soft":"#2a211b","tint":"#483425","focus":"#d2a16e","primary":"#865632","primary-hover":"#98643d","chart":"#c69565","primary-ink":"#ffffff"}},"ibroadcast":{"light":{"brand-background":"#235b96","brand-ink":"#142c4a","brand-paper":"#eff6ff","sidebar":"#162234","accent":"#a0dafa","shell-ink":"#ecedf1","shell-muted":"#b7bec9","shell-active":"#184e8e","shell-line":"#30445f","ink":"#1c3048","muted":"#53677f","paper":"#f4f7fb","line":"#d5dfeb","link":"#1c559b","surface":"#ffffff","soft":"#edf3fa","tint":"#e3edf9","focus":"#518ec5","primary":"#1c559b","primary-hover":"#174681","chart":"#347fc0","primary-ink":"#ffffff"},"dark":{"brand-background":"#235b96","brand-ink":"#142c4a","brand-paper":"#eff6ff","sidebar":"#162234","accent":"#a0dafa","shell-ink":"#ecedf1","shell-muted":"#b7bec9","shell-active":"#184e8e","shell-line":"#30445f","ink":"#eceef2","muted":"#b1bdcd","paper":"#0d1828","line":"#2d405b","link":"#9bd9f8","surface":"#1e2d43","soft":"#162234","tint":"#213d60","focus":"#5c99d6","primary":"#1c559b","primary-hover":"#2465b5","chart":"#69afe8","primary-ink":"#ffffff"}}};
  bases.apple = {"light":{"brand-background":"#fa2d48","brand-ink":"#3b0711","brand-paper":"#ffffff","sidebar":"#f2f2f7","accent":"#c8102e","shell-ink":"#1d1d1f","shell-muted":"#646469","shell-active":"#e4e4e9","shell-line":"#c7c7cc","ink":"#1d1d1f","muted":"#646469","paper":"#ffffff","line":"#d2d2d7","link":"#c8102e","surface":"#f5f5f7","soft":"#fafafa","tint":"#f6e6ea","focus":"#c8102e","primary":"#d60017","primary-hover":"#b80018","chart":"#d60017","primary-ink":"#ffffff","nav-icon":"#c8102e"},"dark":{"brand-background":"#fa2d48","brand-ink":"#1f1f1f","brand-paper":"#ffffff","sidebar":"#252526","accent":"#fa586a","shell-ink":"#f5f5f7","shell-muted":"#b0b0b5","shell-active":"#3a3335","shell-line":"#48484a","ink":"#f5f5f7","muted":"#b0b0b5","paper":"#1f1f1f","line":"#48484a","link":"#ff6476","surface":"#2c2c2e","soft":"#242426","tint":"#3a292f","focus":"#ff6476","primary":"#d60017","primary-hover":"#bf0014","chart":"#fa586a","primary-ink":"#ffffff","nav-icon":"#ff6476"}};
  // Sidebar icons are optional: absent overrides keep the navigation's current text colour.
  const roles = Object.freeze([...Object.keys(bases.forest.light), "nav-icon"]);
  const builtins = Object.freeze(["forest", "ocean", "warm", "ibroadcast", "apple"]);
  const hex = value => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
  const validId = value => typeof value === "string" && /^custom-[a-z0-9-]{8,64}$/.test(value);
  const empty = () => ({version: 1, active: null, themes: []});
  function cleanTheme(value) {
    if (!value || !validId(value.id) || typeof value.name !== "string" || !value.name.trim()
        || value.name.trim().length > 60 || !builtins.includes(value.base)) return null;
    const result = {id: value.id, name: value.name.trim(), base: value.base, light: {}, dark: {}};
    for (const mode of ["light", "dark"]) {
      const colours = value[mode];
      if (!colours || typeof colours !== "object" || Array.isArray(colours)
          || Object.keys(colours).some(role => !roles.includes(role) || !hex(colours[role]))) return null;
      for (const role of roles) if (Object.hasOwn(colours, role)) result[mode][role] = colours[role].toLowerCase();
    }
    return result;
  }
  const fileLimit = 16384;
  function exportTheme(value) {
    const theme = cleanTheme(value);
    if (!theme) throw Error("Enter a name and valid six-digit hex colours before exporting.");
    const {name, base, light, dark} = theme;
    return JSON.stringify({format: "tagcast-theme", version: 1, theme: {name, base, light, dark}}, null, 2) + "\n";
  }
  function importTheme(raw, id) {
    let value;
    try {
      if (typeof raw !== "string" || raw.length > fileLimit) throw Error();
      value = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch { throw Error("Choose a valid Tagcast theme JSON file, up to 16 KB."); }
    if (value?.format !== "tagcast-theme" || value.version !== 1
        || Object.keys(value).some(key => !["format", "version", "theme"].includes(key))
        || !value.theme || typeof value.theme !== "object" || Array.isArray(value.theme)
        || Object.keys(value.theme).some(key => !["name", "base", "light", "dark"].includes(key))) {
      throw Error("This file is not a supported Tagcast theme (version 1).");
    }
    const theme = cleanTheme({...value.theme, id});
    if (!theme) throw Error("The theme needs a name, a built-in base palette and valid six-digit hex colours.");
    return theme; // A new local identity; importing never overwrites or activates a saved theme.
  }
  function decode(raw) {
    try {
      if (typeof raw !== "string" || raw.length > 65536) return empty();
      const value = JSON.parse(raw);
      if (value?.version !== 1 || !Array.isArray(value.themes) || value.themes.length > limit) return empty();
      const themes = value.themes.map(cleanTheme);
      if (themes.some(theme => !theme) || new Set(themes.map(theme => theme.id)).size !== themes.length) return empty();
      return {version: 1, themes, active: themes.some(theme => theme.id === value.active) ? value.active : null};
    } catch { return empty(); }
  }
  function read() { try { return decode(localStorage.getItem(key)); } catch { return empty(); } }
  function readPalette() { try { return localStorage.getItem("tagcast-palette"); } catch { return "forest"; } }
  let store = read(), applied = "", fallbackPalette = readPalette();
  const snapshot = () => structuredClone(store);
  const active = () => store.themes.find(theme => theme.id === store.active) || null;
  const mode = () => typeof document !== "undefined" && (document.documentElement.dataset.theme === "dark"
    || (!document.documentElement.dataset.theme && globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches)) ? "dark" : "light";
  function colours(theme, appearance) { return {...bases[theme.base][appearance], ...theme[appearance]}; }
  function apply() {
    if (typeof document === "undefined") return;
    const root = document.documentElement, theme = active(), overrides = theme ? theme[mode()] : {};
    if (theme) { root.dataset.palette = theme.base; root.dataset.customTheme = theme.id; }
    else { delete root.dataset.customTheme;
      if (builtins.includes(fallbackPalette) && fallbackPalette !== "forest") root.dataset.palette = fallbackPalette; else delete root.dataset.palette;
    }
    for (const role of roles) {
      if (overrides[role]) root.style?.setProperty?.(`--palette-${role}`, overrides[role]);
      else root.style?.removeProperty?.(`--palette-${role}`);
    }
    const identity = JSON.stringify([root.dataset.theme, root.dataset.palette, theme?.id, overrides]);
    if (identity !== applied) { applied = identity; document.dispatchEvent?.(new Event("tagcast-theme-change")); }
  }
  function commit(next) {
    // Persist first: failed storage must not pretend a draft was saved or lose an active theme.
    localStorage.setItem(key, JSON.stringify(next)); store = next; apply(); return snapshot();
  }
  function save(value, activate = false) {
    const theme = cleanTheme(value);
    if (!theme) throw Error("Enter a name and valid six-digit hex colours.");
    const next = snapshot(), index = next.themes.findIndex(item => item.id === theme.id);
    if (index < 0 && next.themes.length >= limit) throw Error(`Keep at most ${limit} custom themes. Delete an unused theme first.`);
    if (index < 0) next.themes.push(theme); else next.themes[index] = theme;
    if (activate) next.active = theme.id;
    return commit(next);
  }
  function activate(id) {
    if (!store.themes.some(theme => theme.id === id)) throw Error("This theme is no longer available.");
    return commit({...snapshot(), active: id});
  }
  function remove(id) { const next = snapshot(); next.themes = next.themes.filter(theme => theme.id !== id); if (next.active === id) next.active = null; return commit(next); }
  function builtin(palette) {
    if (!builtins.includes(palette)) palette = "forest";
    fallbackPalette = palette;
    try { localStorage.setItem("tagcast-palette", palette); if (store.active) commit({...snapshot(), active: null}); }
    catch { store = {...store, active: null}; }
    apply();
    // A private/unavailable store still permits an immediate built-in choice.
    if (typeof document !== "undefined") { if (palette === "forest") delete document.documentElement.dataset.palette; else document.documentElement.dataset.palette = palette; }
    return palette;
  }
  function contrast(a, b) {
    const luminance = value => { const c = value.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; };
    const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
  }
  if (typeof document !== "undefined") {
    try { const appearance = localStorage.getItem("tagcast-theme"); if (["light", "dark"].includes(appearance)) document.documentElement.dataset.theme = appearance; } catch { /* Private window. */ }
    apply();
    globalThis.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => { apply(); if (typeof showTheme === "function") showTheme(); });
    globalThis.addEventListener?.("storage", event => { if ([key, "tagcast-palette", "tagcast-theme", null].includes(event.key)) { store = read(); fallbackPalette = readPalette(); const appearance = (() => { try { return localStorage.getItem("tagcast-theme"); } catch { return null; } })(); if (["light", "dark"].includes(appearance)) document.documentElement.dataset.theme = appearance; else delete document.documentElement.dataset.theme; apply(); if (typeof showTheme === "function") showTheme(); } });
  }
  return Object.freeze({key, roles, builtins, limit, fileLimit, hex, cleanTheme, exportTheme, importTheme, decode, snapshot, active, mode, colours, apply, save, activate, remove, builtin, contrast});
})();
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.TagcastThemes;
