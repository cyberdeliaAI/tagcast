"use strict";

// The header and Settings → Interface → Language share one preference. The server stores it in
// config.json (never at iBroadcast) so browsers and the desktop app agree; this profile keeps
// a copy for the next start. Switching only rewrites interface text: no reload, no requests
// besides saving the choice, and playback, the queue, drafts and history stay untouched.
const interfaceLanguage = {version: 0, saving: false, status: "", statusKey: "", saved: Promise.resolve()};

function interfaceLanguageVersion() { return interfaceLanguage.version; }

function renderHeaderLanguage() {
  const button = $("#language-button"), menu = $("#language-menu");
  if (!button || !menu) return;
  const current = TagcastI18n.languages().find(language => language.tag === TagcastI18n.language);
  const label = TagcastI18n.text("page.language.choose", {language: current?.name || "English"});
  button.setAttribute("aria-label", label); button.title = label;
  button.setAttribute("aria-busy", String(interfaceLanguage.saving));
  $("#language-code").textContent = (current?.tag || "en").toUpperCase();
  const focused = document.activeElement?.dataset?.interfaceLanguage;
  const choice = TagcastI18n.choice || "auto";
  const options = [{tag: "auto", name: TagcastI18n.text("page.language.automatic")}, ...TagcastI18n.languages()];
  menu.innerHTML = options.map(language => `<button type="button" role="menuitemradio" aria-checked="${choice === language.tag}" tabindex="${choice === language.tag ? "0" : "-1"}" data-interface-language="${escapeHtml(language.tag)}" ${language.tag === "auto" ? "" : `lang="${escapeHtml(language.tag)}"`}><span class="language-check" aria-hidden="true">${choice === language.tag ? "✓" : ""}</span><span>${language.status && language.status !== "complete" ? TagcastI18n.html("settings.language.preview", {language: language.name}) : escapeHtml(language.name)}</span></button>`).join("");
  menu.setAttribute("aria-label", TagcastI18n.text("settings.language.label"));
  if (focused && !menu.hidden) menu.querySelector(`[data-interface-language="${focused}"]`)?.focus({preventScroll: true});
  const status = $("#header-language-status");
  const fallback = !interfaceLanguage.saving && TagcastI18n.resolve(choice) !== TagcastI18n.language;
  const statusKey = interfaceLanguage.statusKey === "settings.language.saved" ? "" : interfaceLanguage.statusKey;
  status.textContent = fallback ? TagcastI18n.text("page.language.loadFailed") : statusKey
    ? TagcastI18n.text(statusKey, {error: interfaceLanguage.status}) : "";
  status.hidden = !status.textContent;
}

function setHeaderLanguageMenu(open, restoreFocus = false) {
  const menu = $("#language-menu"), panel = $("#language-panel"), button = $("#language-button");
  if (!menu || !panel || !button) return;
  panel.hidden = !open; menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) {
    setThemeMenu(false);
    menu.querySelector('[aria-checked="true"]')?.focus({preventScroll: true});
  } else if (restoreFocus) button.focus({preventScroll: true});
}

function languageSettingsSection() {
  const choice = TagcastI18n.choice || "auto", current = TagcastI18n.languages().find(l => l.tag === TagcastI18n.language);
  const automatic = TagcastI18n.languages().find(l => l.tag === TagcastI18n.resolve("auto"))?.name || "English";
  const options = [`<option value="auto" ${choice === "auto" ? "selected" : ""}>${TagcastI18n.html("settings.language.automatic", {language: automatic})}</option>`,
    ...TagcastI18n.languages().map(l => `<option value="${escapeHtml(l.tag)}" lang="${escapeHtml(l.tag)}" ${choice === l.tag ? "selected" : ""}>${l.status === "complete"
      ? escapeHtml(l.name) : TagcastI18n.html("settings.language.preview", {language: l.name})}</option>`)];
  const status = interfaceLanguage.statusKey ? TagcastI18n.html(interfaceLanguage.statusKey, {error: interfaceLanguage.status}) : "";
  const partial = current?.status === "complete" ? "" : `<p class="muted">${TagcastI18n.html("settings.language.partial")}</p>`;
  // No name attribute: an immediate preference never marks the server settings form as changed.
  return `<section class="language-settings" data-settings-category="interface" data-language-settings>
    <h3>${TagcastI18n.html("settings.language.heading")} <span class="settings-mode">${TagcastI18n.html("settings.language.mode")}</span></h3>
    <label class="field">${TagcastI18n.html("settings.language.label")}<select id="interface-language" ${interfaceLanguage.saving ? 'aria-busy="true"' : ""}>${options.join("")}</select></label>
    <p class="muted">${TagcastI18n.html("settings.language.scope")}</p>${partial}
    <p class="muted" id="interface-language-status" role="status">${status}</p>
    </section>`;
}

// Redraws only this section, in place: it keeps the Settings category's visibility and focus.
function renderLanguageSettings() {
  renderHeaderLanguage();
  const section = document.querySelector("[data-language-settings]");
  if (!section?.isConnected || typeof section.insertAdjacentHTML !== "function") return;
  const focused = document.activeElement?.id === "interface-language", hidden = section.hidden;
  section.insertAdjacentHTML("afterend", languageSettingsSection());
  section.remove();
  const fresh = document.querySelector("[data-language-settings]");
  if (fresh) fresh.hidden = hidden;
  if (focused) $("#interface-language")?.focus({preventScroll: true});
}

async function chooseInterfaceLanguage(value, {remember = true} = {}) {
  const version = ++interfaceLanguage.version;
  interfaceLanguage.saving = true; interfaceLanguage.statusKey = "settings.language.saving"; interfaceLanguage.status = "";
  const loaded = TagcastI18n.use(value, {remember});
  // Capture and queue the choice before awaiting a catalog: load order must never reorder saves.
  const language = TagcastI18n.choice, previous = interfaceLanguage.saved;
  renderHeaderLanguage();
  const saving = interfaceLanguage.saved = previous.catch(() => {}).then(async () => {
    if (version !== interfaceLanguage.version) return;
    await loaded;
    if (version === interfaceLanguage.version) return api("/api/settings/interface", {language});
  });
  try {
    await loaded;
    if (version === interfaceLanguage.version) renderLanguageSettings();
    await saving;
    if (version === interfaceLanguage.version) interfaceLanguage.statusKey = "settings.language.saved";
  } catch (error) {
    if (version !== interfaceLanguage.version) return;
    // An older running server keeps the choice in this profile only.
    interfaceLanguage.statusKey = error.status === 404 ? "settings.language.localOnly" : "settings.language.saveFailed";
    interfaceLanguage.status = TagcastI18n.errorText(error);
  } finally {
    if (version === interfaceLanguage.version) { interfaceLanguage.saving = false; renderLanguageSettings(); }
  }
}

// Called with each /api/settings reply. The server's choice wins, unless this page chose a
// language after that request started.
function applyServerLanguage(data, version = interfaceLanguage.version) {
  const value = data?.interface_language;
  if (typeof value !== "string" || version !== interfaceLanguage.version || interfaceLanguage.saving) return;
  if (value !== TagcastI18n.choice) TagcastI18n.use(value);
}

// Tagcast Desktop: menus, window titles and native dialogs use the same language. Only the
// settled language is reported (not while a catalog is still loading, never pseudo-localization),
// with the plain desktop.* texts; the app keeps them for its next start.
function publishDesktopLanguage() {
  const desktop = window.tagcastDesktop, language = TagcastI18n.language;
  if (typeof desktop?.setInterface !== "function" || language === "en-XA" || TagcastI18n.resolve(TagcastI18n.choice) !== language) return;
  const labels = {};
  for (const key of Object.keys(globalThis.TagcastI18nEnglish?.messages || {})) {
    if (key.startsWith("desktop.")) labels[key.slice(8)] = TagcastI18n.text(key);
  }
  try { desktop.setInterface({language, labels}); } catch { /* the app keeps its current menus */ }
}

TagcastI18n.subscribe(() => { renderLanguageSettings(); publishDesktopLanguage(); });
publishDesktopLanguage();
renderHeaderLanguage();
setHeaderLanguageMenu(false);
$("#language-button")?.addEventListener("click", () => setHeaderLanguageMenu($("#language-panel").hidden));
$("#language-menu")?.addEventListener("click", event => {
  const value = event.target.closest?.("[data-interface-language]")?.dataset.interfaceLanguage;
  if (value === "auto" || TagcastI18n.languages().some(language => language.tag === value)) {
    // Rendering replaces the clicked row. Do not treat its detached target as an outside click.
    event.stopPropagation(); chooseInterfaceLanguage(value);
  }
});
$("#language-menu")?.addEventListener("keydown", event => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const buttons = [...$("#language-menu").querySelectorAll("[data-interface-language]")];
  if (!buttons.length) return;
  event.preventDefault();
  const current = buttons.indexOf(document.activeElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
    : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  buttons.forEach((button, index) => { button.tabIndex = index === next ? 0 : -1; });
  buttons[next].focus({preventScroll: true});
});
document.addEventListener("click", event => {
  if (!event.target.closest?.(".language-controls")) setHeaderLanguageMenu(false);
});
document.addEventListener("focusin", event => {
  if (!event.target.closest?.(".language-controls")) setHeaderLanguageMenu(false);
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("#language-panel")?.hidden) {
    event.preventDefault(); setHeaderLanguageMenu(false, true);
  }
});
document.addEventListener("change", event => {
  if (event.target?.id === "interface-language") chooseInterfaceLanguage(event.target.value);
});
// Other tabs of this browser profile follow at once. Other browsers and the desktop app read
// the server's choice when they start or reload their settings.
window.addEventListener("storage", event => {
  if (event.key === "tagcast-language" && event.newValue && event.newValue !== TagcastI18n.choice) {
    if (interfaceLanguage.saving) {
      // Our older write may still arrive after the other tab's save. Serialize its newer
      // choice behind it; do not write storage again or let the older completion own the UI.
      chooseInterfaceLanguage(event.newValue, {remember: false});
    } else {
      interfaceLanguage.version += 1;
      interfaceLanguage.statusKey = ""; interfaceLanguage.status = "";
      TagcastI18n.use(event.newValue, {remember: false}).then(renderLanguageSettings);
    }
  }
});
