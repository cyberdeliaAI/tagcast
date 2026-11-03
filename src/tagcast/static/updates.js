"use strict";

// Notifications only: installing and restarting remain the user's choice.
// `error` holds the interface text key of a failed check, translated when shown.
const updateNotice = {data: null, automatic: true, busy: false, error: "", settingsRevision: 0};

function updateReleaseURL() {
  const data = updateNotice.data;
  if (!data?.available || !/^\d+\.\d+\.\d+$/.test(data.latest || "")) return "";
  return `https://github.com/cyberdeliaAI/tagcast/releases/tag/v${data.latest}`;
}

function updateErrorText() {
  return updateNotice.error ? TagcastI18n.text(updateNotice.error) : "";
}

function updateStatusText() {
  if (updateNotice.busy) return TagcastI18n.text("updates.status.checking");
  if (updateNotice.error) return updateErrorText();
  const data = updateNotice.data;
  if (data?.error) return data.error;
  if (updateReleaseURL()) return TagcastI18n.text("updates.status.available", {latest: data.latest, current: data.current});
  if (data?.state === "current") return TagcastI18n.text("updates.status.current", {current: data.current});
  return TagcastI18n.text(updateNotice.automatic ? "updates.status.automatic" : "updates.status.manual");
}

// Static labels carry data-i18n, so they follow a language change without rebuilding
// the Settings form; the status line is updated by renderUpdateNotice().
function updateSettingsPanel() {
  return `<section class="updates-settings" data-settings-category="about"><h3 data-i18n="updates.settings.heading">${TagcastI18n.html("updates.settings.heading")}</h3>
    <label class="checkline" data-i18n="updates.settings.automatic"><input type="checkbox" name="auto_updates" ${updateNotice.automatic ? "checked" : ""}> ${TagcastI18n.html("updates.settings.automatic")}</label>
    <p class="muted" data-i18n="updates.settings.note">${TagcastI18n.html("updates.settings.note")}</p>
    <p id="updates-settings-status" class="muted" aria-live="polite">${escapeHtml(updateStatusText())}</p>
    <div class="update-actions"><button type="button" class="button small" id="check-updates" data-check-updates data-i18n="updates.settings.check" ${updateNotice.busy ? "disabled" : ""}>${TagcastI18n.html("updates.settings.check")}</button>
    <button type="button" class="text-action" id="settings-update-details" data-update-details data-i18n="updates.settings.details" ${updateReleaseURL() ? "" : "hidden"}>${TagcastI18n.html("updates.settings.details")}</button></div></section>`;
}

function applyUpdateSettings(data) {
  updateNotice.settingsRevision += 1;
  updateNotice.automatic = data.auto_updates !== false;
}

function renderUpdateNotice() {
  const url = updateReleaseURL(), data = updateNotice.data;
  const button = $("#update-button");
  button.hidden = !url;
  button.textContent = url ? TagcastI18n.text("updates.button", {version: data.latest}) : "";
  const status = $("#updates-settings-status");
  if (status) status.textContent = updateStatusText();
  const check = $("#check-updates");
  if (check) check.disabled = updateNotice.busy;
  const details = $("#settings-update-details");
  if (details) details.hidden = !url;
}

async function checkForUpdates(manual = false) {
  if (updateNotice.busy) return;
  const revision = updateNotice.settingsRevision;
  updateNotice.busy = true; updateNotice.error = ""; renderUpdateNotice();
  try {
    const data = await api(manual ? "/api/updates/check" : "/api/updates", manual ? {} : undefined);
    updateNotice.data = data;
    if (revision === updateNotice.settingsRevision) updateNotice.automatic = data.auto_updates !== false;
  } catch (error) {
    updateNotice.error = error.status === 404 ? "updates.error.restart" : "updates.error.failed";
  } finally {
    updateNotice.busy = false; renderUpdateNotice();
  }
}

function renderUpdateDetails(url) {
  const data = updateNotice.data, error = data.error || updateErrorText();
  $("#updates-content").innerHTML = `<p><strong>${TagcastI18n.html("updates.dialog.available", {version: data.latest})}</strong> ${TagcastI18n.html("updates.dialog.running", {version: data.current})}</p>
    ${data.name ? `<p class="muted">${escapeHtml(data.name)}</p>` : ""}
    <p>${TagcastI18n.html("updates.dialog.release")}</p>
    <p>${TagcastI18n.html("updates.dialog.restart")}</p>
    ${error ? `<p class="muted">${escapeHtml(error)} ${TagcastI18n.html("updates.dialog.lastCheck")}</p>` : ""}
    <div class="dialog-footer"><button class="button" data-close="updates">${TagcastI18n.html("updates.dialog.later")}</button><a class="button primary" href="${url}" target="_blank" rel="noopener noreferrer">${TagcastI18n.html("updates.dialog.view")}</a></div>`;
}

function openUpdateDetails() {
  const url = updateReleaseURL();
  if (!url) return;
  renderUpdateDetails(url);
  $("#updates").showModal();
}

$("#update-button").addEventListener("click", openUpdateDetails);
document.addEventListener("click", event => {
  if (event.target.closest("[data-check-updates]")) checkForUpdates(true);
  if (event.target.closest("[data-update-details]")) openUpdateDetails();
});

// The top bar button, the Settings status line and an open release dialog follow a
// language change from memory; no update check is started.
TagcastI18n.subscribe(() => {
  renderUpdateNotice();
  const url = updateReleaseURL();
  if (url && $("#updates").open) renderUpdateDetails(url);
});
