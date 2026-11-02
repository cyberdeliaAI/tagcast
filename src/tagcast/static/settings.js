"use strict";

// Page navigation changes presentation only; the existing controls/save API retain ownership.
// Each category lists the keys of its title and description.
const SETTINGS_CATEGORIES = {
  interface: ["settings.category.interface", "settings.category.interfaceNote"],
  appearance: ["settings.category.appearance", "settings.category.appearanceNote"],
  playback: ["settings.category.playback", "settings.category.playbackNote"],
  discovery: ["settings.category.discovery", "settings.category.discoveryNote"],
  sources: ["settings.category.sources", "settings.category.sourcesNote"],
  data: ["settings.category.data", "settings.category.dataNote"],
  about: ["settings.category.about", "settings.category.aboutNote"],
};
const settingsView = {category: "interface", rendered: false, baseline: "", dirty: false, saving: false, editor: null, stale: false, feedback: null};

function settingsFormSnapshot(form = $("#settings-form")) {
  return JSON.stringify([...(form?.querySelectorAll("input[name], select[name], [data-source-toggle]") || [])]
    .map(input => [input.name || input.dataset.sourceToggle, input.type === "checkbox" ? input.checked : input.value]));
}

function openSettings(category) {
  if ($("#editor").open) {
    settingsView.editor = {draft: editing, details: state.details, focus: document.activeElement};
    $("#editor").close(); // DOM inputs/draft remain intact; pending library replacement stays deferred.
    category ||= "sources";
  }
  if (settingsView.rendered && !settingsView.dirty && !settingsView.saving) settingsView.rendered = false;
  showSettings(category || settingsView.category);
}

function showSettings(category = "interface", focus = true) {
  const entering = state.screen !== "settings";
  settingsView.category = Object.hasOwn(SETTINGS_CATEGORIES, category) ? category : "interface";
  showScreen("settings");
  if (!settingsView.rendered) renderSettingsContent();
  else {
    // The language changed while Settings was closed and still holds a server draft.
    if (settingsView.stale) refreshSettingsLanguage();
    updateSettingsPage(); if (entering) resumeMetadataExport();
  }
  if (focus) { $("#settings-category-title").focus({preventScroll: true}); window.scrollTo?.({top: 0}); }
}

// mountEditor: false leaves an already shown theme editor and its draft markup untouched.
function updateSettingsPage(mountEditor = true) {
  const [label, description] = SETTINGS_CATEGORIES[settingsView.category];
  $("#settings-nav").innerHTML = Object.entries(SETTINGS_CATEGORIES).map(([key, [title]]) =>
    `<a href="#/settings/${key}" data-settings-category-link="${key}" ${key === settingsView.category ? 'aria-current="page"' : ""}>${TagcastI18n.html(title)}</a>`).join("");
  $("#settings-category-title").textContent = TagcastI18n.text(label);
  $("#settings-category-description").textContent = TagcastI18n.text(description);
  settingsShowCategory();
  const back = document.querySelector("[data-settings-return]");
  if (back) back.hidden = !settingsView.editor;
  if (settingsView.category === "appearance" && mountEditor) mountThemeEditor();
  updateSettingsSaveState();
}

function settingsShowCategory() {
  for (const section of document.querySelectorAll("#settings-content [data-settings-category]")) {
    section.hidden = section.dataset.settingsCategory !== settingsView.category;
  }
}

function updateSettingsSaveState() {
  settingsView.dirty = settingsView.rendered && settingsFormSnapshot() !== settingsView.baseline;
  const save = $("#settings-save"), bar = $("#settings-save-bar");
  if (save) { save.disabled = settingsView.saving; save.textContent = TagcastI18n.text(settingsView.saving ? "settings.save.saving" : "settings.save.button"); }
  if (bar) bar.hidden = !lookup.sources.length || (!settingsView.dirty && ["interface", "appearance", "data"].includes(settingsView.category));
  const hint = $("#settings-save-hint");
  if (hint) hint.textContent = TagcastI18n.text(settingsView.dirty ? "settings.save.hintDirty" : "settings.save.hint");
}

// The feedback line is kept as a function, so it can be shown again in another language.
function setSettingsFeedback(message) {
  settingsView.feedback = message || null;
  $("#settings-feedback").textContent = message ? message() : "";
}

// A selector for the focused Settings control: its id, else its name and data attributes.
function settingsFocusSelector(node) {
  if (!node?.closest?.("#settings") || typeof node.getAttributeNames !== "function") return "";
  const quote = value => `"${String(value).replace(/["\\]/g, "\\$&")}"`;
  if (node.id) return `[id=${quote(node.id)}]`;
  const data = node.getAttributeNames().filter(name => name === "name" || name.startsWith("data-"));
  return data.length ? node.localName + data.map(name => `[${name}=${quote(node.getAttribute(name))}]`).join("") : "";
}

function settingsRestoreFocus(selector) {
  const active = document.activeElement;
  if (!selector || (active && active !== document.body)) return;
  const find = () => { try { return document.querySelector(selector); } catch { return null; } };
  const node = find();
  if (!node) return;
  if (!node.disabled) { node.focus({preventScroll: true}); return; }
  // The language select stays disabled while its new choice is saved. Return focus to it
  // once it is enabled again, unless focus has moved elsewhere in the meantime.
  if (typeof MutationObserver !== "function") return;
  const observer = new MutationObserver(() => {
    const current = document.activeElement, next = find();
    if (current && current !== document.body) observer.disconnect();
    else if (next && !next.disabled) { observer.disconnect(); next.focus({preventScroll: true}); }
  });
  observer.observe($("#settings"), {subtree: true, childList: true, attributes: true, attributeFilter: ["disabled"]});
  setTimeout(() => observer.disconnect(), 15000);
}

// Replaces everything around the kept parts; kept nodes never move, so their inputs, caret
// and focus stay as they are. Returns false when this browser cannot parse a fragment.
function settingsSplice(content, markup, kept) {
  if (typeof document.createRange !== "function" || kept.some(([node]) => node.parentNode !== content)) return false;
  const fresh = document.createRange().createContextualFragment(markup), nodes = kept.map(([node]) => node);
  for (const node of [...content.childNodes]) if (!nodes.includes(node)) node.remove();
  let next = content.firstChild;
  for (const node of [...fresh.childNodes]) {
    const old = kept.find(([, selector]) => node.matches?.(selector))?.[0];
    if (old) next = old.nextSibling;
    else content.insertBefore(node, next);
  }
  return true;
}

// A language change rewrites Settings from the data already loaded: no requests, no polling or
// other timer restarts. Parts that hold unsaved input stay exactly as they are: the server form
// with a pending draft or a save in progress, and the theme editor with its draft (its labels
// follow when it is shown again). Category, scroll position, open disclosures and focus stay.
function refreshSettingsLanguage() {
  settingsView.stale = false;
  const content = $("#settings-content"), top = window.scrollY, focus = settingsFocusSelector(document.activeElement);
  const keepForm = settingsView.saving || settingsFormSnapshot() !== settingsView.baseline;
  const editor = $("#theme-editor")?.firstElementChild ? $("#theme-editor").closest?.(".theme-editor-section") : null;
  const kept = [[editor, ".theme-editor-section"], [keepForm ? $("#settings-form") : null, "#settings-form"]].filter(([node]) => node);
  const disclosures = () => [...(content.querySelectorAll?.("details") || [])].filter(node => !kept.some(([part]) => part.contains?.(node)));
  const open = disclosures().map(node => node.open);
  if (!kept.length) content.innerHTML = settingsContentMarkup();
  else settingsSplice(content, settingsContentMarkup(), kept); // Without fragments the old text stays.
  disclosures().forEach((node, index) => { if (open[index]) node.open = true; });
  if (!keepForm) settingsView.baseline = settingsFormSnapshot();
  updateSettingsPage(!editor);
  if (typeof renderMetadataExport === "function") renderMetadataExport();
  if (settingsView.feedback) $("#settings-feedback").textContent = settingsView.feedback();
  if (window.scrollY !== top) window.scrollTo?.({top});
  settingsRestoreFocus(focus);
  // Later listeners may redraw a section of their own (the language section): keep it in its category.
  Promise.resolve().then(settingsShowCategory);
}

function settingsPageLeft() { clearTimeout(metadataExportView.timer); }
function resumeSettingsEditor() {
  const previous = settingsView.editor;
  if (!previous) return;
  settingsView.editor = null;
  if (previous.draft === editing && previous.details === state.details && !$("#editor").open) {
    $("#editor").showModal();
    previous.focus?.focus?.({preventScroll: true});
  }
}
function closeSettings() { goBack("artists"); }

TagcastI18n.subscribe(() => {
  if (!settingsView.rendered) return;
  if (state.screen === "settings") refreshSettingsLanguage();
  else settingsView.stale = true;
});
document.addEventListener("click", event => {
  const category = event.target.closest("[data-settings-category-link]");
  if (category) {
    event.preventDefault();
    showSettings(category.dataset.settingsCategoryLink);
  }
  if (event.target.closest("[data-settings-discard]") && !settingsView.saving) {
    renderSettingsContent(); $("#settings-category-title").focus({preventScroll: true}); setSettingsFeedback(() => TagcastI18n.text("settings.save.discarded"));
  }
  if (event.target.closest("[data-settings-return]")) closeSettings();
});
for (const name of ["input", "change"]) document.addEventListener(name, event => {
  if (event.target.closest?.("#settings-form")) updateSettingsSaveState();
});
document.addEventListener("invalid", event => {
  const section = event.target.closest?.("[data-settings-category]");
  if (section && state.screen === "settings") showSettings(section.dataset.settingsCategory, false);
}, true);
window.addEventListener("beforeunload", event => {
  if (!settingsView.dirty && !settingsView.saving && !settingsView.editor) return;
  event.preventDefault(); event.returnValue = "";
});
