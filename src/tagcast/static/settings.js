"use strict";

// Page navigation changes presentation only; the existing controls/save API retain ownership.
const SETTINGS_CATEGORIES = {
  interface: ["Interface", "Immediate preferences for this browser. No Save is needed."],
  appearance: ["Appearance", "Create and save your own colour themes. Local to this browser or app profile."],
  playback: ["Playback", "Display and gapless choices are local. Save streaming, play reporting and device preferences below."],
  discovery: ["Discovery", "Choose optional background information and discovery tools. Save changes to apply."],
  sources: ["Sources & keys", "Choose online providers and manage keys on this computer. Save changes to apply."],
  data: ["Data & exports", "Export saved metadata and choose whether to enable music uploads. Save upload preferences to apply."],
  about: ["About & updates", "Check releases and find the community. Save changes to apply the automatic update preference."],
};
const settingsView = {category: "interface", rendered: false, baseline: "", dirty: false, saving: false, editor: null};

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
  else { updateSettingsPage(); if (entering) resumeMetadataExport(); }
  if (focus) { $("#settings-category-title").focus({preventScroll: true}); window.scrollTo?.({top: 0}); }
}

function updateSettingsPage() {
  const [label, description] = SETTINGS_CATEGORIES[settingsView.category];
  $("#settings-nav").innerHTML = Object.entries(SETTINGS_CATEGORIES).map(([key, [title]]) =>
    `<a href="#/settings/${key}" data-settings-category-link="${key}" ${key === settingsView.category ? 'aria-current="page"' : ""}>${title}</a>`).join("");
  $("#settings-category-title").textContent = label;
  $("#settings-category-description").textContent = description;
  for (const section of document.querySelectorAll("#settings-content [data-settings-category]")) {
    section.hidden = section.dataset.settingsCategory !== settingsView.category;
  }
  const back = document.querySelector("[data-settings-return]");
  if (back) back.hidden = !settingsView.editor;
  if (settingsView.category === "appearance") mountThemeEditor();
  updateSettingsSaveState();
}

function updateSettingsSaveState() {
  settingsView.dirty = settingsView.rendered && settingsFormSnapshot() !== settingsView.baseline;
  const save = $("#settings-save"), bar = $("#settings-save-bar");
  if (save) { save.disabled = settingsView.saving; save.textContent = settingsView.saving ? "Saving…" : "Save changes"; }
  if (bar) bar.hidden = !lookup.sources.length || (!settingsView.dirty && ["interface", "appearance", "data"].includes(settingsView.category));
  const hint = $("#settings-save-hint");
  if (hint) hint.textContent = settingsView.dirty ? "Unsaved server preferences · Save applies changes from every category."
    : "Server preferences apply after Save. Immediate preferences are already applied.";
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

document.addEventListener("click", event => {
  const category = event.target.closest("[data-settings-category-link]");
  if (category) {
    event.preventDefault();
    showSettings(category.dataset.settingsCategoryLink);
  }
  if (event.target.closest("[data-settings-discard]") && !settingsView.saving) {
    renderSettingsContent(); $("#settings-category-title").focus({preventScroll: true}); $("#settings-feedback").textContent = "Pending server preferences discarded. Immediate choices are kept.";
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
