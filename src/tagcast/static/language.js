"use strict";

// Settings → Interface → Language. The local Tagcast server stores the choice in its own
// config.json (never at iBroadcast) so browsers and the desktop app agree; this profile keeps
// a copy for the next start. Switching only rewrites interface text: no reload, no requests
// besides saving the choice, and playback, the queue, drafts and history stay untouched.
const interfaceLanguage = {version: 0, saving: false, status: "", statusKey: "", saved: Promise.resolve()};

function interfaceLanguageVersion() { return interfaceLanguage.version; }

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
  const section = document.querySelector("[data-language-settings]");
  if (!section?.isConnected || typeof section.insertAdjacentHTML !== "function") return;
  const focused = document.activeElement?.id === "interface-language", hidden = section.hidden;
  section.insertAdjacentHTML("afterend", languageSettingsSection());
  section.remove();
  const fresh = document.querySelector("[data-language-settings]");
  if (fresh) fresh.hidden = hidden;
  if (focused) $("#interface-language")?.focus({preventScroll: true});
}

async function chooseInterfaceLanguage(value) {
  const version = ++interfaceLanguage.version;
  interfaceLanguage.saving = true; interfaceLanguage.statusKey = "settings.language.saving"; interfaceLanguage.status = "";
  await TagcastI18n.use(value);
  renderLanguageSettings();
  // The select stays usable while saving; saves run one after another so the newest choice is
  // also the one the server keeps.
  const language = TagcastI18n.choice, previous = interfaceLanguage.saved;
  const saving = interfaceLanguage.saved = previous.catch(() => {}).then(() => api("/api/settings/interface", {language}));
  try {
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
document.addEventListener("change", event => {
  if (event.target?.id === "interface-language") chooseInterfaceLanguage(event.target.value);
});
// Other tabs of this browser profile follow at once. Other browsers and the desktop app read
// the server's choice when they start or reload their settings.
window.addEventListener("storage", event => {
  if (event.key === "tagcast-language" && event.newValue && event.newValue !== TagcastI18n.choice) {
    interfaceLanguage.version += 1;
    TagcastI18n.use(event.newValue, {remember: false});
  }
});
