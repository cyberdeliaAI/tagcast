"use strict";

// A local colour draft, independent of metadata forms and server preferences.
const themeEditorView = {draft: null, baseline: null, mode: "dark", invalid: {}, notice: "", error: ""};
// The key of each colour role's label.
const themeRoleLabels = {paper: "themeEditor.role.paper", surface: "themeEditor.role.surface", ink: "themeEditor.role.ink", muted: "themeEditor.role.muted", link: "themeEditor.role.link", primary: "themeEditor.role.primary", "primary-ink": "themeEditor.role.primaryInk", "primary-hover": "themeEditor.role.primaryHover", focus: "themeEditor.role.focus", soft: "themeEditor.role.soft", tint: "themeEditor.role.tint", line: "themeEditor.role.line", sidebar: "themeEditor.role.sidebar", "shell-ink": "themeEditor.role.shellInk", "shell-muted": "themeEditor.role.shellMuted", "shell-active": "themeEditor.role.shellActive", "shell-line": "themeEditor.role.shellLine", "nav-icon": "themeEditor.role.navIcon", accent: "themeEditor.role.accent", "brand-background": "themeEditor.role.brandBackground", "brand-ink": "themeEditor.role.brandInk", "brand-paper": "themeEditor.role.brandPaper", chart: "themeEditor.role.chart"};
const themeBasicRoles = ["paper", "surface", "ink", "muted", "link", "primary", "primary-ink"];
// Built-in palette names. Generic words follow the interface language; "Apple Music Classic"
// and "Amber" stay names. Saved theme names keep their original language.
const themePaletteNames = {forest: "Forest", ocean: "Ocean", warm: "Warm", ibroadcast: "iBroadcast inspired", apple: "Apple Music Classic", amber: "Amber"};
const themePaletteKeys = {forest: "themeEditor.palette.forest", ocean: "themeEditor.palette.ocean", warm: "themeEditor.palette.warm", ibroadcast: "themeEditor.palette.ibroadcast"};
function themePaletteLabel(value) {
  const base = Object.hasOwn(themePaletteNames, value) ? value : "forest";
  return Object.hasOwn(themePaletteKeys, base) ? TagcastI18n.text(themePaletteKeys[base]) : themePaletteNames[base];
}
function themeNewId() { return `custom-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`}`; }
function themeEditorDirty() { return Boolean(themeEditorView.draft && (Object.keys(themeEditorView.invalid).length || JSON.stringify(themeEditorView.draft) !== themeEditorView.baseline)); }
function themeEditorLoad(theme) {
  themeEditorView.draft = structuredClone(theme);
  themeEditorView.baseline = JSON.stringify(theme);
  themeEditorView.invalid = {}; themeEditorView.error = ""; themeEditorView.notice = "";
}
function themeEditorBase(base) { return {id: themeNewId(), name: `My ${themePaletteNames[base] || "Forest"}`, base, light: {}, dark: {}}; }
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
  const label = TagcastI18n.text(themeRoleLabels[role]);
  const reset = optional && !baseIcon ? TagcastI18n.html("themeEditor.role.follow") : TagcastI18n.html("themeEditor.role.restore", {role: label.toLowerCase()});
  const note = baseIcon ? TagcastI18n.html("themeEditor.role.overrideNote") : TagcastI18n.html("themeEditor.role.followNote");
  return `<div class="theme-colour"><label for="theme-hex-${role}">${TagcastI18n.html(themeRoleLabels[role])}</label><div><input type="color" value="${picker}" data-theme-colour="${role}" aria-label="${TagcastI18n.html("themeEditor.role.picker", {role: label})}"><input id="theme-hex-${role}" type="text" class="theme-hex" value="${escapeHtml(value)}" maxlength="7" spellcheck="false" autocomplete="off" data-theme-hex="${role}" aria-label="${TagcastI18n.html("themeEditor.role.hex", {role: label})}" ${optional ? `placeholder="${TagcastI18n.html("themeEditor.role.basePlaceholder")}" aria-describedby="theme-nav-icon-note"` : ""} ${Object.hasOwn(v.invalid, role) ? 'aria-invalid="true"' : ""}><button type="button" class="text-action" data-theme-inherit="${role}" aria-label="${reset}" title="${reset}">↶</button></div>${optional ? `<small id="theme-nav-icon-note">${note}</small>` : ""}</div>`;
}
function themePreviewMarkup() {
  // Album, artist and track names in the preview are sample data and stay as they are.
  return `<div class="theme-preview" id="theme-preview" aria-label="${TagcastI18n.html("themeEditor.preview.label")}"><div class="theme-sample-top"><strong>${document.querySelector(".brand-mark")?.outerHTML || ""}Tagcast<span>.</span></strong><small>${TagcastI18n.html("themeEditor.preview.components")}</small></div><div class="theme-sample-layout"><div class="theme-sample-sidebar"><strong>${TagcastI18n.html("themeEditor.preview.workspace")}</strong><span>${document.querySelector("#show-artists .nav-icon")?.outerHTML || ""}${TagcastI18n.html("themeEditor.preview.albumArtists")}</span><span class="theme-sample-active">${document.querySelector("#all-albums .nav-icon")?.outerHTML || ""}${TagcastI18n.html("themeEditor.preview.albums")}</span><span>${document.querySelector("#show-tracks .nav-icon")?.outerHTML || ""}${TagcastI18n.html("themeEditor.preview.tracks")}</span><span>${document.querySelector("#show-playlists .nav-icon")?.outerHTML || ""}${TagcastI18n.html("themeEditor.preview.playlists")}</span><small>${TagcastI18n.html("themeEditor.preview.library")}</small></div><div class="theme-sample-content"><h3>${TagcastI18n.html("themeEditor.preview.heading")}<span>.</span></h3><label class="theme-sample-search">${TagcastI18n.html("themeEditor.preview.search")}<input type="search" placeholder="${TagcastI18n.html("themeEditor.preview.searchPlaceholder")}" aria-label="${TagcastI18n.html("themeEditor.preview.searchLabel")}"></label><div class="theme-sample-actions"><button type="button" class="theme-sample-primary">${TagcastI18n.html("themeEditor.preview.play")}</button><button type="button">${TagcastI18n.html("themeEditor.preview.queue")}</button><button type="button" disabled>${TagcastI18n.html("themeEditor.preview.edit")}</button></div><div class="theme-sample-card"><div class="theme-sample-cover" aria-hidden="true">T</div><div><strong>After Hours</strong><p>The Tagcast Ensemble</p><small>2026 · ${TagcastI18n.html("common.count.tracks", {count: 8})} · 39:14</small></div></div><table aria-label="${TagcastI18n.html("themeEditor.preview.table")}"><thead><tr><th>#</th><th>${TagcastI18n.html("themeEditor.preview.titleArtist")}</th><th>${TagcastI18n.html("themeEditor.preview.time")}</th></tr></thead><tbody><tr class="theme-sample-playing"><td>▶</td><td>Blue in the evening<small>The Tagcast Ensemble</small></td><td>4:27</td></tr><tr><td>2</td><td>A quieter place</td><td>5:06</td></tr></tbody></table><div class="theme-sample-dialog"><strong>${TagcastI18n.html("themeEditor.preview.dialogHeading")}</strong><p>${TagcastI18n.html("themeEditor.preview.dialogText")}</p><div class="theme-sample-chart" role="img" aria-label="${TagcastI18n.html("themeEditor.preview.chart")}"><span></span></div><span class="theme-sample-ok">${TagcastI18n.html("themeEditor.preview.confirmed")}</span> <span class="theme-sample-warning">${TagcastI18n.html("themeEditor.preview.needsReview")}</span></div></div></div><div class="theme-sample-player"><button type="button" aria-label="${TagcastI18n.html("themeEditor.preview.pause")}">Ⅱ</button><span>2:22</span><span class="theme-sample-progress"></span><span>4:27</span></div><p class="theme-sample-caption">${TagcastI18n.html("themeEditor.preview.caption")}</p></div>`;
}
function renderThemeEditor() {
  const node = $("#theme-editor"); if (!node || !themeEditorView.draft) return;
  const v = themeEditorView, saved = TagcastThemes.snapshot().themes, existing = saved.some(t => t.id === v.draft.id);
  node.innerHTML = `<p class="muted">${TagcastI18n.html("themeEditor.intro")}</p><div class="theme-editor-toolbar"><label class="field">${TagcastI18n.html("themeEditor.choice.label")}<select id="theme-edit-choice">${TagcastThemes.builtins.map(base => `<option value="base:${base}" ${!existing && base === v.draft.base ? "selected" : ""}>${TagcastI18n.html("themeEditor.choice.newTheme", {palette: themePaletteLabel(base)})}</option>`).join("")}${saved.map(t => `<option value="${t.id}" ${t.id === v.draft.id ? "selected" : ""}>${escapeHtml(t.name)}</option>`).join("")}</select></label><button type="button" class="button small" id="theme-copy">${TagcastI18n.html("themeEditor.actions.duplicate")}</button><button type="button" class="button small" id="theme-import">${TagcastI18n.html("themeEditor.actions.import")}</button><button type="button" class="button small" id="theme-export">${TagcastI18n.html("themeEditor.actions.export")}</button><input id="theme-import-file" type="file" accept=".json,application/json" aria-label="${TagcastI18n.html("themeEditor.actions.importLabel")}" hidden></div><form id="theme-editor-form"><div class="theme-editor-layout"><div class="theme-editor-controls"><label class="field" for="theme-name">${TagcastI18n.html("themeEditor.name")}<input id="theme-name" type="text" maxlength="60" value="${escapeHtml(v.draft.name)}" required></label><p class="muted">${TagcastI18n.html("themeEditor.basedOn", {palette: themePaletteLabel(v.draft.base)})}</p><div class="theme-variant" role="group" aria-label="${TagcastI18n.html("themeEditor.variant.label")}"><button type="button" class="button small" data-theme-mode="light" aria-pressed="${v.mode === "light"}">${TagcastI18n.html("themeEditor.variant.light")}</button><button type="button" class="button small" data-theme-mode="dark" aria-pressed="${v.mode === "dark"}">${TagcastI18n.html("themeEditor.variant.dark")}</button></div><p class="muted">${TagcastI18n.html("themeEditor.variant.note")}</p>${themeBasicRoles.map(themeRoleControl).join("")}<details class="theme-advanced" ${v.advanced ? "open" : ""}><summary>${TagcastI18n.html("themeEditor.advanced")}</summary>${TagcastThemes.roles.filter(role => !themeBasicRoles.includes(role)).map(themeRoleControl).join("")}</details><button type="button" class="text-action" id="theme-reset-variant">${TagcastI18n.html(v.mode === "light" ? "themeEditor.resetLight" : "themeEditor.resetDark")}</button></div><div class="theme-editor-preview-column">${themePreviewMarkup()}<div class="theme-contrast" id="theme-contrast" aria-label="${TagcastI18n.html("themeEditor.contrast.label")}"></div></div></div><p id="theme-editor-feedback" role="status" aria-live="polite"></p><div class="theme-editor-actions"><button type="submit" class="button primary" id="theme-save-use">${TagcastI18n.html("themeEditor.actions.saveUse")}</button><button type="button" class="button" id="theme-save">${TagcastI18n.html("themeEditor.actions.save")}</button><button type="button" class="button" id="theme-discard">${TagcastI18n.html("themeEditor.actions.discard")}</button><button type="button" class="text-action" id="theme-delete" ${existing ? "" : "hidden"}>${TagcastI18n.html("themeEditor.actions.delete")}</button></div></form><details class="theme-editor-help"><summary>${TagcastI18n.html("themeEditor.help.summary")}</summary><p class="muted">${TagcastI18n.html("themeEditor.help.variants")}</p><p class="muted">${TagcastI18n.html("themeEditor.help.sharing")}</p></details>`;
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
  const checks = [["themeEditor.role.ink", "ink", "paper", 4.5], ["themeEditor.role.muted", "muted", "surface", 4.5], ["themeEditor.role.link", "link", "paper", 4.5], ["themeEditor.contrast.buttonText", "primary-ink", "primary", 4.5], ["themeEditor.role.shellInk", "shell-ink", "sidebar", 4.5], ["themeEditor.role.shellMuted", "shell-muted", "sidebar", 4.5], ["themeEditor.role.shellActive", "shell-ink", "shell-active", 4.5], ["themeEditor.role.focus", "focus", "surface", 3]];
  if (colours["nav-icon"]) checks.push(["themeEditor.role.navIcon", "nav-icon", "sidebar", 3], ["themeEditor.contrast.selectedIcons", "nav-icon", "shell-active", 3]);
  $("#theme-contrast").innerHTML = `<h3>${TagcastI18n.html("themeEditor.contrast.heading")}</h3>` + checks.map(([label, foreground, background, target]) => {
    const ratio = TagcastThemes.contrast(colours[foreground], colours[background]);
    return `<p><span>${TagcastI18n.html(label)}</span><span>${escapeHtml(TagcastI18n.number(ratio, {minimumFractionDigits: 1, maximumFractionDigits: 1}))}:1 · ${TagcastI18n.html(ratio >= target ? "themeEditor.contrast.pass" : "themeEditor.contrast.low")}</span></p>`;
  }).join("") + `<small>${TagcastI18n.html("themeEditor.contrast.note")}</small>`;
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
    v.error = ""; v.notice = TagcastI18n.text("themeEditor.notice.unsaved"); themeEditorPreview();
  } else { v.invalid[role] = value; document.getElementById(`theme-hex-${role}`)?.setAttribute("aria-invalid", "true"); v.error = TagcastI18n.text("themeEditor.error.hex"); }
  themeEditorFeedback();
}
function saveCustomTheme(use) {
  const v = themeEditorView;
  if (Object.keys(v.invalid).length) return;
  try {
    TagcastThemes.save(v.draft, use); v.draft = TagcastThemes.cleanTheme(v.draft); v.baseline = JSON.stringify(v.draft);
    v.error = ""; v.notice = TagcastI18n.text(use ? "themeEditor.notice.savedUsed" : "themeEditor.notice.saved");
    showTheme(); renderThemeEditor(); $(use ? "#theme-save-use" : "#theme-save").focus({preventScroll: true});
  } catch (error) {
    v.error = error?.name === "QuotaExceededError" || error?.name === "SecurityError" ? TagcastI18n.text("themeEditor.error.storage")
      : TagcastI18n.text("themeEditor.error.save", {error: TagcastI18n.errorText(error)});
    themeEditorFeedback();
  }
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
    v.error = ""; v.notice = TagcastI18n.text("themeEditor.notice.exported");
  } catch (error) { v.error = TagcastI18n.text("themeEditor.error.export", {error: TagcastI18n.errorText(error)}); }
  themeEditorFeedback();
}
async function importCustomTheme(file) {
  const v = themeEditorView, draft = v.draft;
  const signature = JSON.stringify([draft, v.invalid]);
  try {
    if (!file || !Number.isFinite(file.size) || file.size <= 0 || file.size > TagcastThemes.fileLimit) {
      throw TagcastI18n.failure("themes.choose_file");
    }
    const imported = TagcastThemes.importTheme(await file.text(), themeNewId());
    // A slow local file read must not replace a newer draft or repaint another page.
    if (v.draft !== draft || JSON.stringify([v.draft, v.invalid]) !== signature
        || state.screen !== "settings" || settingsView.category !== "appearance") return;
    if (themeEditorDirty() && !confirm(TagcastI18n.text("themeEditor.confirm.importDiscard"))) return;
    const baseline = v.baseline;
    themeEditorLoad(imported); v.baseline = baseline;
    v.notice = TagcastI18n.text("themeEditor.notice.imported");
    renderThemeEditor(); $("#theme-name").focus({preventScroll: true});
  } catch (error) {
    if (v.draft !== draft || JSON.stringify([v.draft, v.invalid]) !== signature
        || state.screen !== "settings" || settingsView.category !== "appearance") return;
    v.error = TagcastI18n.text("themeEditor.error.import", {error: TagcastI18n.errorText(error)}); themeEditorFeedback();
  }
}
document.addEventListener("input", event => {
  if (!themeEditorView.draft) return;
  const target = event.target;
  if (target.id === "theme-name") { themeEditorView.draft.name = target.value; themeEditorView.notice = TagcastI18n.text("themeEditor.notice.unsaved"); themeEditorFeedback(); }
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
  if (themeEditorDirty() && !confirm(TagcastI18n.text("themeEditor.confirm.openDiscard"))) { renderThemeEditor(); return; }
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
  if (button.dataset.themeMode) { if (Object.keys(v.invalid).length) { v.error = TagcastI18n.text("themeEditor.error.variant"); themeEditorFeedback(); return; } v.mode = button.dataset.themeMode; v.error = ""; renderThemeEditor(); document.querySelector(`[data-theme-mode="${v.mode}"]`)?.focus({preventScroll: true}); }
  else if (button.dataset.themeInherit) { const role = button.dataset.themeInherit; delete v.draft[v.mode][role]; delete v.invalid[role]; v.error = ""; renderThemeEditor(); document.querySelector(`[data-theme-inherit="${role}"]`)?.focus({preventScroll: true}); }
  else if (button.id === "theme-reset-variant") { v.draft[v.mode] = {}; v.invalid = {}; v.error = ""; renderThemeEditor(); $("#theme-reset-variant").focus({preventScroll: true}); }
  else if (button.id === "theme-copy") { if (Object.keys(v.invalid).length) { v.error = TagcastI18n.text("themeEditor.error.duplicate"); themeEditorFeedback(); return; } const copy = {...structuredClone(v.draft), id: themeNewId(), name: `${v.draft.name} copy`.slice(0, 60)}; themeEditorLoad(copy); renderThemeEditor(); $("#theme-name").focus(); }
  else if (button.id === "theme-import") $("#theme-import-file").click();
  else if (button.id === "theme-export") exportCustomTheme();
  else if (button.id === "theme-save") saveCustomTheme(false);
  else if (button.id === "theme-discard") { themeEditorLoad(JSON.parse(v.baseline)); renderThemeEditor(); $("#theme-discard").focus({preventScroll: true}); }
  else if (button.id === "theme-delete" && confirm(TagcastI18n.text("themeEditor.confirm.delete", {name: v.draft.name}))) {
    try { TagcastThemes.remove(v.draft.id); themeEditorLoad(themeEditorBase(document.documentElement.dataset.palette || "forest")); showTheme(); renderThemeEditor(); $("#theme-edit-choice").focus(); }
    catch { v.error = TagcastI18n.text("themeEditor.error.delete"); themeEditorFeedback(); }
  }
});
window.addEventListener("beforeunload", event => { if (themeEditorDirty()) { event.preventDefault(); event.returnValue = ""; } });
