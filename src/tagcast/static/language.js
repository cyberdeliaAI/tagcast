"use strict";

// Settings → Interface → Language. The local Tagcast server stores the choice in its own
// config.json (never at iBroadcast) so browsers and the desktop app agree; this profile keeps
// a copy for the next start. Switching only rewrites interface text: no reload, no requests
// besides saving the choice, and playback, the queue, drafts and history stay untouched.
const interfaceLanguage = {version: 0, saving: false, status: "", statusKey: ""};

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
    <label class="field">${TagcastI18n.html("settings.language.label")}<select id="interface-language" ${interfaceLanguage.saving ? "disabled" : ""}>${options.join("")}</select></label>
    <p class="muted">${TagcastI18n.html("settings.language.scope")}</p>${partial}
    <p class="muted" id="interface-language-status" role="status">${status}</p>
    </section>`;
}

function renderLanguageSettings() {
  const section = document.querySelector("[data-language-settings]");
  if (!section?.isConnected || typeof section.insertAdjacentHTML !== "function") return;
  const focused = document.activeElement?.id === "interface-language";
  section.insertAdjacentHTML("afterend", languageSettingsSection());
  section.remove();
  if (focused) $("#interface-language")?.focus();
}

async function chooseInterfaceLanguage(value) {
  const version = ++interfaceLanguage.version;
  interfaceLanguage.saving = true; interfaceLanguage.statusKey = "settings.language.saving"; interfaceLanguage.status = "";
  await TagcastI18n.use(value);
  renderLanguageSettings();
  try {
    await api("/api/settings/interface", {language: TagcastI18n.choice});
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

TagcastI18n.subscribe(() => renderLanguageSettings());
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
