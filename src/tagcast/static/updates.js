"use strict";

// Notifications only: installing and restarting remain the user's choice.
// `error` holds the interface text key of a failed check, translated when shown.
const updateNotice = {data: null, automatic: true, busy: false, error: "", settingsRevision: 0};
const desktopUpdate = {data: null, explicit: false};

function desktopUpdateText() {
  const value = desktopUpdate.data;
  if (!value) return "";
  const errors = {download: "updates.desktop.error.download", preferences: "updates.desktop.error.preferences",
    install: "updates.desktop.error.install", uncertain: "updates.desktop.error.uncertain"};
  if (value.error) return TagcastI18n.text(errors[value.error] || errors.download);
  if (!value.supported) {
    const reasons = {homebrew: "updates.desktop.homebrew", server: "updates.desktop.server", test: "updates.desktop.test", signing: "updates.desktop.signing"};
    return TagcastI18n.text(reasons[value.reason] || "updates.desktop.manual");
  }
  const states = {checking: "updates.desktop.checking", ready: "updates.desktop.ready", finishing: "updates.desktop.finishing"};
  if (value.state === "downloading") return TagcastI18n.text("updates.desktop.progress", {percent: value.progress});
  return TagcastI18n.text(states[value.state] || "updates.desktop.available");
}

function desktopUpdatePanel() {
  const value = desktopUpdate.data;
  if (!value) return "";
  return `<section class="desktop-update"><p id="desktop-update-status" aria-live="polite">${escapeHtml(desktopUpdateText())}</p>
    ${value.supported ? `<label class="checkline"><input type="checkbox" id="desktop-update-auto" data-update-auto ${value.autoDownload ? "checked" : ""}> ${TagcastI18n.html("updates.desktop.autoDownload")}</label>
    <p class="muted">${TagcastI18n.html("updates.desktop.consent")}</p>
    <div class="update-actions"><button type="button" class="button primary" id="desktop-update-download" data-update-download>${TagcastI18n.html("updates.desktop.download")}</button>
    <button type="button" class="button primary" id="desktop-update-install" data-update-install>${TagcastI18n.html("updates.desktop.install")}</button>
    <button type="button" class="text-action" id="desktop-update-skip" data-update-skip>${TagcastI18n.html("updates.desktop.skip")}</button></div>` : ""}</section>`;
}

function refreshDesktopUpdateControls() {
  const value = desktopUpdate.data;
  if (!value || !$("#updates").open) return;
  const status = $("#desktop-update-status");
  if (status) status.textContent = desktopUpdateText();
  const busy = ["checking", "downloading", "finishing"].includes(value.state);
  const download = $("#desktop-update-download"), install = $("#desktop-update-install"), skip = $("#desktop-update-skip");
  if (download) { download.hidden = !value.supported || ["ready", "finishing"].includes(value.state); download.disabled = busy; }
  if (install) { install.hidden = !value.supported || !["ready", "finishing"].includes(value.state); install.disabled = busy; }
  if (skip) { skip.hidden = !value.supported; skip.disabled = busy; }
  const automatic = $("#desktop-update-auto");
  if (automatic) { automatic.checked = value.autoDownload; automatic.disabled = value.state === "finishing"; }
}

function applyDesktopUpdate(value) {
  if (!value || typeof value.supported !== "boolean") return;
  if (Number.isSafeInteger(value.revision) && Number.isSafeInteger(desktopUpdate.data?.revision)
      && value.revision < desktopUpdate.data.revision) return;
  const wasKnown = Boolean(desktopUpdate.data);
  desktopUpdate.data = value;
  renderUpdateNotice();
  if (!wasKnown && $("#updates").open && updateReleaseURL()) renderUpdateDetails(updateReleaseURL());
}

function updateReleaseURL() {
  const data = updateNotice.data;
  if (!data?.available || !/^\d+\.\d+\.\d+$/.test(data.latest || "")) return "";
  if (!desktopUpdate.explicit && desktopUpdate.data?.skipped === data.latest) return "";
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
  refreshDesktopUpdateControls();
}

async function checkForUpdates(manual = false) {
  if (updateNotice.busy) return;
  const revision = updateNotice.settingsRevision;
  updateNotice.busy = true; updateNotice.error = ""; renderUpdateNotice();
  try {
    const data = await api(manual ? "/api/updates/check" : "/api/updates", manual ? {} : undefined);
    updateNotice.data = data;
    desktopUpdate.explicit = manual;
    if (revision === updateNotice.settingsRevision) updateNotice.automatic = data.auto_updates !== false;
    if (data.available && window.tagcastUpdates) {
      window.tagcastUpdates.offer(data.latest, !manual && updateNotice.automatic).then(applyDesktopUpdate).catch(() => {});
    }
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
    ${typeof data.notes === "string" && data.notes ? `<pre class="update-notes" tabindex="0">${escapeHtml(data.notes.slice(0, 50000))}</pre>` : ""}
    ${desktopUpdatePanel()}
    <p>${TagcastI18n.html("updates.dialog.release")}</p>
    ${desktopUpdate.data?.supported ? "" : `<p>${TagcastI18n.html("updates.dialog.restart")}</p>`}
    ${error ? `<p class="muted">${escapeHtml(error)} ${TagcastI18n.html("updates.dialog.lastCheck")}</p>` : ""}
    <div class="dialog-footer"><button class="button" data-close="updates">${TagcastI18n.html("updates.dialog.later")}</button><a class="button primary" href="${url}" target="_blank" rel="noopener noreferrer">${TagcastI18n.html("updates.dialog.view")}</a></div>`;
  refreshDesktopUpdateControls();
}

function openUpdateDetails() {
  const url = updateReleaseURL();
  if (!url) return;
  renderUpdateDetails(url);
  $("#updates").showModal();
  refreshDesktopUpdateControls();
}

$("#update-button").addEventListener("click", openUpdateDetails);
document.addEventListener("click", event => {
  if (event.target.closest("[data-check-updates]")) checkForUpdates(true);
  if (event.target.closest("[data-update-details]")) openUpdateDetails();
  const version = updateNotice.data?.latest;
  if (event.target.closest("[data-update-download]")) window.tagcastUpdates?.download(version).then(applyDesktopUpdate).catch(() => {});
  if (event.target.closest("[data-update-install]")) window.tagcastUpdates?.install(version).then(applyDesktopUpdate).catch(() => {});
  if (event.target.closest("[data-update-skip]")) {
    window.tagcastUpdates?.skip(version).then(value => {
      applyDesktopUpdate(value);
      if (!value?.error && value?.skipped === version) { desktopUpdate.explicit = false; renderUpdateNotice(); $("#updates").close(); }
    }).catch(() => {});
  }
});

document.addEventListener("change", event => {
  if (event.target.matches?.("[data-update-auto]")) window.tagcastUpdates?.configure(event.target.checked).then(applyDesktopUpdate).catch(() => {});
});
document.addEventListener("DOMContentLoaded", () => {
  if (window.tagcastUpdates) {
    window.tagcastUpdates.onStatus(applyDesktopUpdate);
    window.tagcastUpdates.status().then(applyDesktopUpdate).catch(() => {});
  }
});

// The top bar button, the Settings status line and an open release dialog follow a
// language change from memory; no update check is started.
TagcastI18n.subscribe(() => {
  renderUpdateNotice();
  const url = updateReleaseURL();
  if (url && $("#updates").open) renderUpdateDetails(url);
});
