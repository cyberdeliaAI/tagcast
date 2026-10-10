"use strict";

// Notifications only: installing and restarting remain the user's choice.
const updateNotice = {data: null, automatic: true, busy: false, error: "", settingsRevision: 0};

function updateReleaseURL() {
  const data = updateNotice.data;
  if (!data?.available || !/^\d+\.\d+\.\d+$/.test(data.latest || "")) return "";
  return `https://github.com/cyberdeliaAI/tagcast/releases/tag/v${data.latest}`;
}

function updateStatusText() {
  if (updateNotice.busy) return "Checking for updates…";
  if (updateNotice.error) return updateNotice.error;
  const data = updateNotice.data;
  if (data?.error) return data.error;
  if (updateReleaseURL()) return `Tagcast ${data.latest} is available. You are running ${data.current}.`;
  if (data?.state === "current") return `Tagcast ${data.current} is up to date with the latest stable release.`;
  return updateNotice.automatic ? "Updates are checked at startup, at most once a day." : "Automatic update checks are off. You can still check manually.";
}

function updateSettingsPanel() {
  return `<section class="updates-settings"><h3>Tagcast updates</h3>
    <label class="checkline"><input type="checkbox" name="auto_updates" ${updateNotice.automatic ? "checked" : ""}> Automatically check for new stable releases</label>
    <p class="muted">Checks GitHub at startup, at most once a day. No account or library data is sent. Updating is manual.</p>
    <p id="updates-settings-status" class="muted" aria-live="polite">${escapeHtml(updateStatusText())}</p>
    <div class="update-actions"><button type="button" class="button small" id="check-updates" data-check-updates ${updateNotice.busy ? "disabled" : ""}>Check for updates</button>
    <button type="button" class="text-action" id="settings-update-details" data-update-details ${updateReleaseURL() ? "" : "hidden"}>View release &amp; downloads →</button></div></section>`;
}

function applyUpdateSettings(data) {
  updateNotice.settingsRevision += 1;
  updateNotice.automatic = data.auto_updates !== false;
}

function renderUpdateNotice() {
  const url = updateReleaseURL(), data = updateNotice.data;
  const button = $("#update-button");
  button.hidden = !url;
  button.textContent = url ? `Update available · ${data.latest}` : "";
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
    updateNotice.error = error.status === 404 ? "Restart Tagcast to use update checks: the running server is older than this page."
      : "Could not check for updates. Try again later or view GitHub releases.";
  } finally {
    updateNotice.busy = false; renderUpdateNotice();
  }
}

function openUpdateDetails() {
  const url = updateReleaseURL();
  if (!url) return;
  const data = updateNotice.data;
  $("#updates-content").innerHTML = `<p><strong>Tagcast ${escapeHtml(data.latest)} is available.</strong> You are running ${escapeHtml(data.current)}.</p>
    ${data.name ? `<p class="muted">${escapeHtml(data.name)}</p>` : ""}
    <p>Open the release page for the changes and standalone downloads for macOS, Windows and Linux, or the source archive.</p>
    <p>Stop the running Tagcast before starting the new version. Account settings are stored separately from the app.</p>
    ${data.error || updateNotice.error ? `<p class="muted">${escapeHtml(data.error || updateNotice.error)} This notification uses the last successful check.</p>` : ""}
    <div class="dialog-footer"><button class="button" data-close="updates">Later</button><a class="button primary" href="${url}" target="_blank" rel="noopener noreferrer">View release &amp; downloads ↗</a></div>`;
  $("#updates").showModal();
}

$("#update-button").addEventListener("click", openUpdateDetails);
document.addEventListener("click", event => {
  if (event.target.closest("[data-check-updates]")) checkForUpdates(true);
  if (event.target.closest("[data-update-details]")) openUpdateDetails();
});
