"use strict";

// A local colour draft, independent of metadata forms and server preferences.
const themeEditorView = {draft: null, baseline: null, mode: "dark", invalid: {}, notice: "", error: ""};
const themeRoleLabels = {paper: "Page background", surface: "Cards and controls", ink: "Main text", muted: "Secondary text", link: "Links", primary: "Primary button", "primary-ink": "Primary button text", "primary-hover": "Primary button hover", focus: "Keyboard focus", soft: "Subtle surface", tint: "Selection and hover", line: "Borders", sidebar: "Sidebar and player", "shell-ink": "Sidebar text", "shell-muted": "Sidebar secondary text", "shell-active": "Active navigation", "shell-line": "Sidebar borders", "nav-icon": "Sidebar icons", accent: "Player accent", "brand-background": "Logo background", "brand-ink": "Logo ink", "brand-paper": "Logo paper", chart: "Charts"};
const themeBasicRoles = ["paper", "surface", "ink", "muted", "link", "primary", "primary-ink"];
const themePaletteLabel = value => ({forest: "Forest", ocean: "Ocean", warm: "Warm", ibroadcast: "iBroadcast inspired", apple: "Apple Music Classic"}[value] || "Forest");
function themeNewId() { return `custom-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`}`; }
function themeEditorDirty() { return Boolean(themeEditorView.draft && (Object.keys(themeEditorView.invalid).length || JSON.stringify(themeEditorView.draft) !== themeEditorView.baseline)); }
function themeEditorLoad(theme) {
  themeEditorView.draft = structuredClone(theme);
  themeEditorView.baseline = JSON.stringify(theme);
  themeEditorView.invalid = {}; themeEditorView.error = ""; themeEditorView.notice = "";
}
function themeEditorBase(base) { return {id: themeNewId(), name: `My ${themePaletteLabel(base)}`, base, light: {}, dark: {}}; }
function themeEditorPanel() { return '<section class="theme-editor-section" data-settings-category="appearance"><div id="theme-editor"></div></section>'; }
function mountThemeEditor() {
  if (!themeEditorView.draft) {
    themeEditorView.mode = TagcastThemes.mode();
    themeEditorLoad(TagcastThemes.active() || themeEditorBase(document.documentElement.dataset.palette || "forest"));
  }
  renderThemeEditor();
}
function themeRoleControl(role) {
  const v = themeEditorView, colours = TagcastThemes.colours(v.draft, v.mode), value = v.invalid[role] ?? colours[role] ?? "";
  const optional = role === "nav-icon", picker = colours[role] || colours["shell-muted"];
  const baseIcon = TagcastThemes.colours({base: v.draft.base, light: {}, dark: {}}, v.mode)["nav-icon"];
  const reset = optional && !baseIcon ? "Follow sidebar text" : `Restore ${themeRoleLabels[role].toLowerCase()} from base palette`;
  const note = baseIcon ? "Optional override. Leave blank or reset to restore this palette's icon colour." : "Optional. Leave blank or reset to follow sidebar text, including hover and selection.";
  return `<div class="theme-colour"><label for="theme-hex-${role}">${themeRoleLabels[role]}</label><div><input type="color" value="${picker}" data-theme-colour="${role}" aria-label="${themeRoleLabels[role]} colour picker"><input id="theme-hex-${role}" type="text" class="theme-hex" value="${escapeHtml(value)}" maxlength="7" spellcheck="false" autocomplete="off" data-theme-hex="${role}" aria-label="${themeRoleLabels[role]} hex colour" ${optional ? 'placeholder="Base colour" aria-describedby="theme-nav-icon-note"' : ""} ${Object.hasOwn(v.invalid, role) ? 'aria-invalid="true"' : ""}><button type="button" class="text-action" data-theme-inherit="${role}" aria-label="${reset}" title="${reset}">↶</button></div>${optional ? `<small id="theme-nav-icon-note">${note}</small>` : ""}</div>`;
}
function themePreviewMarkup() {
  return `<div class="theme-preview" id="theme-preview" aria-label="Custom theme component preview"><div class="theme-sample-top"><strong>${document.querySelector(".brand-mark")?.outerHTML || ""}Tagcast<span>.</span></strong><small>Component preview</small></div><div class="theme-sample-layout"><div class="theme-sample-sidebar"><strong>Workspace</strong><span>${document.querySelector("#show-artists .nav-icon")?.outerHTML || ""}Album artists</span><span class="theme-sample-active">${document.querySelector("#all-albums .nav-icon")?.outerHTML || ""}Albums</span><span>${document.querySelector("#show-tracks .nav-icon")?.outerHTML || ""}Tracks</span><span>${document.querySelector("#show-playlists .nav-icon")?.outerHTML || ""}Playlists</span><small>Sample library</small></div><div class="theme-sample-content"><h3>Your albums<span>.</span></h3><label class="theme-sample-search">Search example<input type="search" placeholder="Search albums or artists" aria-label="Preview search field"></label><div class="theme-sample-actions"><button type="button" class="theme-sample-primary">Play album</button><button type="button">Queue</button><button type="button" disabled>Edit</button></div><div class="theme-sample-card"><div class="theme-sample-cover" aria-hidden="true">T</div><div><strong>After Hours</strong><p>The Tagcast Ensemble</p><small>2026 · 8 tracks · 39:14</small></div></div><table aria-label="Preview track table"><thead><tr><th>#</th><th>Title / Artist</th><th>Time</th></tr></thead><tbody><tr class="theme-sample-playing"><td>▶</td><td>Blue in the evening<small>The Tagcast Ensemble</small></td><td>4:27</td></tr><tr><td>2</td><td>A quieter place</td><td>5:06</td></tr></tbody></table><div class="theme-sample-dialog"><strong>Review your draft</strong><p>Check changes before saving.</p><div class="theme-sample-chart" role="img" aria-label="Preview chart colour"><span></span></div><span class="theme-sample-ok">Confirmed</span> <span class="theme-sample-warning">Needs review</span></div></div></div><div class="theme-sample-player"><button type="button" aria-label="Preview pause button">Ⅱ</button><span>2:22</span><span class="theme-sample-progress"></span><span>4:27</span></div><p class="theme-sample-caption">Example components only · no playback or library actions</p></div>`;
}
function renderThemeEditor() {
  const node = $("#theme-editor"); if (!node || !themeEditorView.draft) return;
  const v = themeEditorView, saved = TagcastThemes.snapshot().themes, existing = saved.some(t => t.id === v.draft.id);
  node.innerHTML = `<p class="muted">Create a colour theme from an existing palette. Changes stay in the preview until you choose Save &amp; use. Saved themes are local to this browser or desktop profile.</p><div class="theme-editor-toolbar"><label class="field">Start from or edit<select id="theme-edit-choice">${TagcastThemes.builtins.map(base => `<option value="base:${base}" ${!existing && base === v.draft.base ? "selected" : ""}>${themePaletteLabel(base)} · new theme</option>`).join("")}${saved.map(t => `<option value="${t.id}" ${t.id === v.draft.id ? "selected" : ""}>${escapeHtml(t.name)}</option>`).join("")}</select></label><button type="button" class="button small" id="theme-copy">Duplicate draft</button><button type="button" class="button small" id="theme-import">Import JSON…</button><button type="button" class="button small" id="theme-export">Export JSON</button><input id="theme-import-file" type="file" accept=".json,application/json" aria-label="Import a Tagcast theme JSON file" hidden></div><form id="theme-editor-form"><div class="theme-editor-layout"><div class="theme-editor-controls"><label class="field" for="theme-name">Theme name<input id="theme-name" type="text" maxlength="60" value="${escapeHtml(v.draft.name)}" required></label><p class="muted">Based on ${themePaletteLabel(v.draft.base)}. Unchanged colours inherit from that palette.</p><div class="theme-variant" role="group" aria-label="Edit colour variant"><button type="button" class="button small" data-theme-mode="light" aria-pressed="${v.mode === "light"}">Light</button><button type="button" class="button small" data-theme-mode="dark" aria-pressed="${v.mode === "dark"}">Dark</button></div><p class="muted">Editing a variant does not change the app's Light, Dark or Auto preference.</p>${themeBasicRoles.map(themeRoleControl).join("")}<details class="theme-advanced" ${v.advanced ? "open" : ""}><summary>Sidebar, player and other colours</summary>${TagcastThemes.roles.filter(role => !themeBasicRoles.includes(role)).map(themeRoleControl).join("")}</details><button type="button" class="text-action" id="theme-reset-variant">Restore ${v.mode} colours from base</button></div><div class="theme-editor-preview-column">${themePreviewMarkup()}<div class="theme-contrast" id="theme-contrast" aria-label="Preview contrast checks"></div></div></div><p id="theme-editor-feedback" role="status" aria-live="polite"></p><div class="theme-editor-actions"><button type="submit" class="button primary" id="theme-save-use">Save &amp; use</button><button type="button" class="button" id="theme-save">Save theme</button><button type="button" class="button" id="theme-discard">Discard changes</button><button type="button" class="text-action" id="theme-delete" ${existing ? "" : "hidden"}>Delete saved theme…</button></div></form><details class="theme-editor-help"><summary>About custom themes</summary><p class="muted">Each theme has separate Light and Dark colours. Auto follows your system as before. Your draft stays here while you browse; saving is explicit. The built-in palettes are never overwritten. Warning/error colours keep their meaning. Native audio controls, system output pickers and window borders follow browser or operating-system styling.</p><p class="muted">Contrast checks cover representative colour pairs, not every possible screen. Use the text fields to enter six-digit hex colours, for example #246276. Reset arrows restore individual colours. Import/export shares one theme as a small JSON file with its name, base palette and Light/Dark colour overrides. Export includes the current valid draft, without saving it. Import creates a new preview; choose Save theme or Save &amp; use to keep it. Existing themes, account details and other settings are never included or replaced.</p></details>`;
  const advanced = node.querySelector(".theme-advanced"); advanced?.addEventListener("toggle", () => { v.advanced = advanced.open; });
  themeEditorPreview(); themeEditorFeedback();
}
function themeEditorFeedback() {
  const node = $("#theme-editor-feedback"); if (!node) return;
  node.textContent = themeEditorView.error || themeEditorView.notice;
  node.className = themeEditorView.error ? "error-text" : "muted";
  const invalid = Object.keys(themeEditorView.invalid).length > 0 || !themeEditorView.draft?.name.trim();
  for (const id of ["theme-save", "theme-save-use", "theme-export"]) if ($(`#${id}`)) $(`#${id}`).disabled = invalid;
}
function themeEditorPreview() {
  if (!themeEditorView.draft) return;
  const colours = TagcastThemes.colours(themeEditorView.draft, themeEditorView.mode), preview = $("#theme-preview");
  if (!preview) return;
  for (const role of TagcastThemes.roles) {
    if (colours[role]) preview.style?.setProperty?.(`--palette-${role}`, colours[role]);
    // Block an active theme's optional icon override from leaking into another draft.
    else preview.style?.setProperty?.(`--palette-${role}`, "initial");
  }
  const checks = [["Main text", "ink", "paper", 4.5], ["Secondary text", "muted", "surface", 4.5], ["Links", "link", "paper", 4.5], ["Button text", "primary-ink", "primary", 4.5], ["Sidebar text", "shell-ink", "sidebar", 4.5], ["Sidebar secondary text", "shell-muted", "sidebar", 4.5], ["Active navigation", "shell-ink", "shell-active", 4.5], ["Keyboard focus", "focus", "surface", 3]];
  if (colours["nav-icon"]) checks.push(["Sidebar icons", "nav-icon", "sidebar", 3], ["Selected sidebar icons", "nav-icon", "shell-active", 3]);
  $("#theme-contrast").innerHTML = '<h3>Contrast checks</h3>' + checks.map(([label, foreground, background, target]) => {
    const ratio = TagcastThemes.contrast(colours[foreground], colours[background]);
    return `<p><span>${label}</span><span>${ratio.toFixed(1)}:1 · ${ratio >= target ? "Pass" : "Low contrast"}</span></p>`;
  }).join("") + '<small>Representative pairs. Low contrast is a warning; your colour choices are kept.</small>';
}
function themeEditorColour(role, value, picker) {
  if (!TagcastThemes.roles.includes(role)) return;
  const v = themeEditorView;
  const inherit = role === "nav-icon" && value === "" && !picker;
  if (TagcastThemes.hex(value) || inherit) {
    if (inherit) delete v.draft[v.mode][role];
    else v.draft[v.mode][role] = value.toLowerCase();
    delete v.invalid[role];
    const other = document.querySelector(picker ? `[data-theme-hex="${role}"]` : `[data-theme-colour="${role}"]`);
    const colours = TagcastThemes.colours(v.draft, v.mode);
    if (other) { other.value = inherit ? colours[role] || colours["shell-muted"] : value; other.removeAttribute("aria-invalid"); }
    if (inherit && document.getElementById(`theme-hex-${role}`)) document.getElementById(`theme-hex-${role}`).value = colours[role] || "";
    document.getElementById(`theme-hex-${role}`)?.removeAttribute("aria-invalid");
    v.error = ""; v.notice = "Unsaved preview changes."; themeEditorPreview();
  } else { v.invalid[role] = value; document.getElementById(`theme-hex-${role}`)?.setAttribute("aria-invalid", "true"); v.error = "Use a six-digit hex colour such as #246276. The preview keeps the last valid colour."; }
  themeEditorFeedback();
}
function saveCustomTheme(use) {
  const v = themeEditorView;
  if (Object.keys(v.invalid).length) return;
  try {
    TagcastThemes.save(v.draft, use); v.draft = TagcastThemes.cleanTheme(v.draft); v.baseline = JSON.stringify(v.draft);
    v.error = ""; v.notice = use ? "Theme saved and applied. Light / Dark / Auto is unchanged." : "Theme saved. Choose it in the Theme menu, or Save & use here.";
    showTheme(); renderThemeEditor(); $(use ? "#theme-save-use" : "#theme-save").focus({preventScroll: true});
  } catch (error) { v.error = `Theme could not be saved. ${error?.name === "QuotaExceededError" || error?.name === "SecurityError" ? "Browser storage is unavailable or full. Your draft is kept." : error.message}`; themeEditorFeedback(); }
}
function exportCustomTheme() {
  const v = themeEditorView;
  if (!v.draft || Object.keys(v.invalid).length) return;
  try {
    const data = TagcastThemes.exportTheme(v.draft);
    const url = URL.createObjectURL(new Blob([data], {type: "application/json"}));
    try {
      const link = document.createElement("a"); link.href = url;
      const name = v.draft.name.normalize("NFKD").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "custom";
      link.download = `tagcast-theme-${name}.json`; link.click();
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    v.error = ""; v.notice = "Theme JSON exported. Your draft and active theme are unchanged.";
  } catch (error) { v.error = `Theme could not be exported. ${error.message}`; }
  themeEditorFeedback();
}
async function importCustomTheme(file) {
  const v = themeEditorView, draft = v.draft;
  const signature = JSON.stringify([draft, v.invalid]);
  try {
    if (!file || !Number.isFinite(file.size) || file.size <= 0 || file.size > TagcastThemes.fileLimit) {
      throw Error("Choose one Tagcast theme JSON file, up to 16 KB.");
    }
    const imported = TagcastThemes.importTheme(await file.text(), themeNewId());
    // A slow local file read must not replace a newer draft or repaint another page.
    if (v.draft !== draft || JSON.stringify([v.draft, v.invalid]) !== signature
        || state.screen !== "settings" || settingsView.category !== "appearance") return;
    if (themeEditorDirty() && !confirm("Discard the unsaved theme draft and preview the imported theme?")) return;
    const baseline = v.baseline;
    themeEditorLoad(imported); v.baseline = baseline;
    v.notice = "Imported as a new, unsaved preview. Choose Save theme or Save & use to keep it.";
    renderThemeEditor(); $("#theme-name").focus({preventScroll: true});
  } catch (error) {
    if (v.draft !== draft || JSON.stringify([v.draft, v.invalid]) !== signature
        || state.screen !== "settings" || settingsView.category !== "appearance") return;
    v.error = `Theme could not be imported. ${error.message}`; themeEditorFeedback();
  }
}
document.addEventListener("input", event => {
  if (!themeEditorView.draft) return;
  const target = event.target;
  if (target.id === "theme-name") { themeEditorView.draft.name = target.value; themeEditorView.notice = "Unsaved preview changes."; themeEditorFeedback(); }
  if (target.dataset?.themeColour) themeEditorColour(target.dataset.themeColour, target.value, true);
  if (target.dataset?.themeHex) themeEditorColour(target.dataset.themeHex, target.value, false);
});
document.addEventListener("change", event => {
  const target = event.target;
  if (target.id === "theme-import-file") {
    const file = target.files?.[0]; target.value = "";
    if (file) importCustomTheme(file);
    return;
  }
  if (target.id !== "theme-edit-choice") return;
  if (themeEditorDirty() && !confirm("Discard the unsaved theme draft and open another theme?")) { renderThemeEditor(); return; }
  const base = target.value.slice(5);
  const theme = target.value.startsWith("base:") ? (TagcastThemes.builtins.includes(base) ? themeEditorBase(base) : null) : TagcastThemes.snapshot().themes.find(t => t.id === target.value);
  if (theme) { themeEditorLoad(theme); renderThemeEditor(); $("#theme-edit-choice").focus({preventScroll: true}); }
});
// The preview search field is illustrative, not a shortcut to saving the theme.
document.addEventListener("keydown", event => {
  if (event.key === "Enter" && event.target.closest?.("#theme-preview input")) event.preventDefault();
});
document.addEventListener("submit", event => { if (event.target.id === "theme-editor-form") { event.preventDefault(); saveCustomTheme(true); } });
document.addEventListener("click", event => {
  const button = event.target.closest?.("[data-theme-mode], [data-theme-inherit], #theme-copy, #theme-import, #theme-export, #theme-save, #theme-discard, #theme-delete, #theme-reset-variant");
  if (!button || !themeEditorView.draft) return;
  const v = themeEditorView;
  if (button.dataset.themeMode) { if (Object.keys(v.invalid).length) { v.error = "Correct or reset invalid colours before changing variant."; themeEditorFeedback(); return; } v.mode = button.dataset.themeMode; v.error = ""; renderThemeEditor(); document.querySelector(`[data-theme-mode="${v.mode}"]`)?.focus({preventScroll: true}); }
  else if (button.dataset.themeInherit) { const role = button.dataset.themeInherit; delete v.draft[v.mode][role]; delete v.invalid[role]; v.error = ""; renderThemeEditor(); document.querySelector(`[data-theme-inherit="${role}"]`)?.focus({preventScroll: true}); }
  else if (button.id === "theme-reset-variant") { v.draft[v.mode] = {}; v.invalid = {}; v.error = ""; renderThemeEditor(); $("#theme-reset-variant").focus({preventScroll: true}); }
  else if (button.id === "theme-copy") { if (Object.keys(v.invalid).length) { v.error = "Correct invalid colours before duplicating the draft."; themeEditorFeedback(); return; } const copy = {...structuredClone(v.draft), id: themeNewId(), name: `${v.draft.name} copy`.slice(0, 60)}; themeEditorLoad(copy); renderThemeEditor(); $("#theme-name").focus(); }
  else if (button.id === "theme-import") $("#theme-import-file").click();
  else if (button.id === "theme-export") exportCustomTheme();
  else if (button.id === "theme-save") saveCustomTheme(false);
  else if (button.id === "theme-discard") { themeEditorLoad(JSON.parse(v.baseline)); renderThemeEditor(); $("#theme-discard").focus({preventScroll: true}); }
  else if (button.id === "theme-delete" && confirm(`Delete the saved theme “${v.draft.name}”? Built-in palettes are kept.`)) {
    try { TagcastThemes.remove(v.draft.id); themeEditorLoad(themeEditorBase(document.documentElement.dataset.palette || "forest")); showTheme(); renderThemeEditor(); $("#theme-edit-choice").focus(); }
    catch { v.error = "The saved theme could not be deleted. Your theme is kept."; themeEditorFeedback(); }
  }
});
window.addEventListener("beforeunload", event => { if (themeEditorDirty()) { event.preventDefault(); event.returnValue = ""; } });
