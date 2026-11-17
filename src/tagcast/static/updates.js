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

// A bounded Markdown subset, not provider HTML. Every text/attribute is escaped;
// only our fixed tags and credential-free HTTPS links can enter the dialog.
const UPDATE_NOTES_LIMIT = 50000;

function updateNotesURL(value) {
  if (value.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(value)) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

function updateNotesLinkEnd(text, start) {
  let depth = 0;
  for (let i = start; i < Math.min(text.length, start + 8193); i++) {
    if (text[i] === "(") depth += 1;
    if (text[i] === ")") { if (!depth) return i; depth -= 1; }
  }
  return -1;
}

function updateNotesInline(text, budget, depth = 0, links = true) {
  const html = [], tokens = /`+|!\[|\[|https:\/\/|\*{1,2}|_{1,2}/g;
  let copied = 0, match;
  const append = (start, end, markup) => {
    html.push(escapeHtml(text.slice(copied, start)), markup);
    copied = end; tokens.lastIndex = end;
  };
  // A shared attempt budget also bounds unmatched delimiters and nested labels.
  while (budget.inline > 0 && (match = tokens.exec(text))) {
    budget.inline -= 1;
    const marker = match[0], start = match.index, body = start + marker.length;
    if (marker[0] === "`") {
      const end = text.indexOf(marker, body);
      if (end > body) append(start, end + marker.length, `<code>${escapeHtml(text.slice(body, end))}</code>`);
    } else if (marker === "[" || marker === "![") {
      const labelEnd = text.indexOf("](", body);
      if (labelEnd < body) continue;
      const end = updateNotesLinkEnd(text, labelEnd + 2);
      if (end < 0) continue;
      const label = text.slice(body, labelEnd), url = updateNotesURL(text.slice(labelEnd + 2, end));
      const markup = marker === "[" && links && label && !label.includes("[") && url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${updateNotesInline(label, budget, depth + 1, false)}</a>`
        : escapeHtml(text.slice(start, end + 1));
      append(start, end + 1, markup);
    } else if (marker === "https://") {
      if (!links || start && !/[\s(]/.test(text[start - 1])) continue;
      let end = body;
      while (end < text.length && !/[\s<>"'`]/.test(text[end])) end += 1;
      let value = text.slice(start, end).replace(/[.,;:!?]+$/, "");
      let balance = 0;
      for (const char of value) { if (char === "(") balance += 1; else if (char === ")") balance -= 1; }
      while (balance < 0 && value.endsWith(")")) { value = value.slice(0, -1); balance += 1; }
      const url = updateNotesURL(value);
      if (url) append(start, start + value.length, `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a>`);
      else append(start, end, escapeHtml(text.slice(start, end)));
    } else if (depth < 2 && /\S/.test(text[body] || "") && !(marker.length === 1 && /[\w*_]/.test(text[start - 1] || ""))) {
      const end = text.indexOf(marker, body);
      if (end > body && /\S/.test(text[end - 1]) && !(marker.length === 1 && /[\w*_]/.test(text[end + 1] || ""))) {
        const tag = marker.length === 2 ? "strong" : "em";
        append(start, end + marker.length, `<${tag}>${updateNotesInline(text.slice(body, end), budget, depth + 1, links)}</${tag}>`);
      }
    }
  }
  html.push(escapeHtml(text.slice(copied)));
  return html.join("");
}

function updateNotesCells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
}

function renderReleaseNotes(markdown) {
  if (typeof markdown !== "string") return "";
  const bounded = markdown.slice(0, UPDATE_NOTES_LIMIT);
  if (!bounded.trim()) return "";
  const lines = bounded.replace(/\r\n?/g, "\n").replace(/\u0000/g, "\ufffd").split("\n");
  const html = [], budget = {inline: 1500, cells: 2000};
  const inline = text => updateNotesInline(text, budget);
  let paragraph = [], list = null;
  const endParagraph = () => { if (paragraph.length) html.push(`<p>${inline(paragraph.join(" "))}</p>`); paragraph = []; };
  const endList = () => {
    if (list) html.push(`<${list.tag}>${list.items.map(item => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const endBlocks = () => { endParagraph(); endList(); };
  const tableLine = line => /^\s*\|.*\|\s*$/.test(line);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], fence = /^ {0,3}(`{3,}|~{3,})[^\n]*$/.exec(line);
    if (fence) {
      endBlocks();
      const code = [], closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      for (i++; i < lines.length && !closing.test(lines[i]); i++) code.push(lines[i]);
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { endBlocks(); continue; }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+)$/.exec(line);
    if (heading) {
      endBlocks();
      const level = Math.min(6, heading[1].length + 2);
      let label = heading[2].trimEnd(), end = label.length;
      while (end && label[end - 1] === "#") end -= 1;
      if (end && /\s/.test(label[end - 1])) label = label.slice(0, end).trimEnd();
      html.push(`<h${level}>${inline(label)}</h${level}>`);
      continue;
    }
    if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}\s*$/.test(line)) { endBlocks(); html.push("<hr>"); continue; }
    if (tableLine(line) && tableLine(lines[i + 1] || "")) {
      const head = updateNotesCells(line), separator = updateNotesCells(lines[i + 1]);
      if (head.length <= 20 && head.length <= budget.cells && head.length === separator.length && separator.every(cell => /^:?-{2,}:?$/.test(cell))) {
        endBlocks();
        const rows = []; budget.cells -= head.length;
        for (i += 2; i < lines.length && tableLine(lines[i]); i++) {
          const cells = updateNotesCells(lines[i]);
          if (cells.length !== head.length || head.length > budget.cells) break;
          budget.cells -= head.length; rows.push(cells);
        }
        i--;
        html.push(`<table><thead><tr>${head.map(cell => `<th scope="col">${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        continue;
      }
    }
    const item = /^\s*(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/.exec(line);
    if (item) {
      endParagraph();
      const tag = item[1] ? "ul" : "ol";
      if (!list || list.tag !== tag) { endList(); list = {tag, items: []}; }
      list.items.push(item[3]); continue;
    }
    if (list && /^\s+\S/.test(line)) { list.items[list.items.length - 1] += " " + line.trim(); continue; }
    endList(); paragraph.push(line.trim());
  }
  endBlocks();
  return html.join("\n");
}

function renderUpdateDetails(url) {
  const data = updateNotice.data, error = data.error || updateErrorText();
  $("#updates-content").innerHTML = `<p><strong>${TagcastI18n.html("updates.dialog.available", {version: data.latest})}</strong> ${TagcastI18n.html("updates.dialog.running", {version: data.current})}</p>
    ${data.name ? `<p class="muted">${escapeHtml(data.name)}</p>` : ""}
    ${typeof data.notes === "string" && data.notes ? `<div class="update-notes" tabindex="0">${renderReleaseNotes(data.notes)}</div>` : ""}
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
