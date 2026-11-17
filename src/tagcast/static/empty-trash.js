"use strict";

// Opening Settings is read-only; only this explicit review reads the current trash.
const emptyTrashView = {request: 0, review: null, reading: false, busy: false, acknowledged: false,
  details: null, session: null, invalidated: false, terminal: false, error: "", focus: null};

function emptyTrashPanel() {
  return `<section class="history-settings" data-settings-category="data"><h3>${TagcastI18n.html("trashEmpty.heading")}</h3><p class="muted">${TagcastI18n.html("trashEmpty.description")}</p><button type="button" class="button small" data-empty-trash-open ${!live() || !state.connection.connected || saving || checking ? "disabled" : ""}>${TagcastI18n.html("trashEmpty.action")}</button></section>`;
}

function emptyTrashCurrent(request) {
  const view = emptyTrashView;
  return request === view.request && !view.invalidated && live() && !state.loading
    && view.session === state.connection.playback_session && view.details === state.details;
}

function resetEmptyTrashReview() {
  const view = emptyTrashView;
  view.invalidated = true; view.request += 1;
  if (view.busy) return; // An accepted request/read-back must finish; never retry it.
  view.review = null; view.reading = false; view.terminal = true;
  view.error = TagcastI18n.text("errors.trash_empty.session");
  if ($("#empty-trash").open) renderEmptyTrashReview();
}

function updateEmptyTrashControls() {
  const button = document.querySelector("[data-empty-trash-open]");
  if (button) button.disabled = !live() || !state.connection.connected || state.loading || saving || checking;
  const view = emptyTrashView;
  if (!view.busy && !view.invalidated && $("#empty-trash").open && !emptyTrashCurrent(view.request)) resetEmptyTrashReview();
}

function validEmptyTrashPage(data, expected) {
  return data && Number.isSafeInteger(data.count) && data.count >= 0 && data.count <= 10000
    && Number.isSafeInteger(data.offset) && data.offset >= 0 && data.offset % 50 === 0
    && data.offset < Math.max(1, data.count) && data.limit === 50
    && typeof data.review === "string" && (data.count ? /^[\w-]{20,128}$/.test(data.review) : data.review === "")
    && typeof data.digest === "string" && /^[a-f0-9]{64}$/.test(data.digest)
    && (!expected || data.review === expected.review && data.count === expected.count && data.digest === expected.digest)
    && Array.isArray(data.tracks) && data.tracks.length === Math.min(50, data.count - data.offset)
    && data.tracks.every(row => row && typeof row.id === "string" && /^[1-9][0-9]*$/.test(row.id)
      && [row.title, row.artist, row.album].every(value => typeof value === "string" && value.length <= 1000));
}

function renderEmptyTrashReview() {
  const view = emptyTrashView, data = view.review;
  $("#empty-trash-close").disabled = view.busy;
  $("#empty-trash-content").innerHTML = data ? `<p><strong>${TagcastI18n.html("trashEmpty.count", {count: data.count})}</strong></p>
    ${data.count && !view.terminal ? `<div class="warn-box" id="empty-trash-warning">${TagcastI18n.html("trashEmpty.warning")}</div><div class="empty-trash-list" aria-label="${TagcastI18n.html("trashEmpty.tracks")}">${data.tracks.map((track, index) => `<article><strong>${TagcastI18n.html("trashEmpty.position", {position: data.offset + index + 1})} ${escapeHtml(track.title || "–")}</strong><div class="muted">${escapeHtml([track.artist, track.album].filter(Boolean).join(" · ")) || "–"}</div></article>`).join("")}</div><div class="empty-trash-pager"><button type="button" class="button small" id="empty-trash-previous" ${view.reading || view.busy || !data.offset ? "disabled" : ""}>${TagcastI18n.html("trashEmpty.previous")}</button><span>${TagcastI18n.html("trashEmpty.page", {start: data.offset + 1, end: data.offset + data.tracks.length, total: data.count})}</span><button type="button" class="button small" id="empty-trash-next" ${view.reading || view.busy || data.offset + data.tracks.length >= data.count ? "disabled" : ""}>${TagcastI18n.html("trashEmpty.next")}</button></div><label class="checkline"><input type="checkbox" id="empty-trash-acknowledge" ${view.acknowledged ? "checked" : ""} ${view.reading || view.busy ? "disabled" : ""}> ${TagcastI18n.html("trashEmpty.acknowledge")}</label>` : !data.count ? `<p>${TagcastI18n.html("trashEmpty.empty")}</p>` : ""}` : "";
  $("#empty-trash-footer").innerHTML = view.busy ? "" : `<button type="button" class="button" data-close="empty-trash">${TagcastI18n.html("common.close")}</button>${data?.count && !view.terminal ? `<button type="button" class="button danger" id="empty-trash-save" aria-describedby="empty-trash-warning" ${!view.acknowledged || view.reading || saving || checking ? "disabled" : ""}>${TagcastI18n.html("trashEmpty.submit")}</button>` : view.error || view.terminal ? `<button type="button" class="button" data-empty-trash-open>${TagcastI18n.html("trashEmpty.reviewAgain")}</button>` : ""}`;
  if (view.error) { setActionStatus("#empty-trash-status", view.error); $("#empty-trash-status").classList.add("error-text"); }
  else $("#empty-trash-status").classList.remove("error-text");
}

async function openEmptyTrashReview() {
  const view = emptyTrashView;
  if (!live() || !state.connection.connected || state.loading || saving || checking || view.busy || view.reading) return;
  if (!$("#empty-trash").open) view.focus = document.activeElement;
  view.details = state.details; view.session = state.connection.playback_session;
  view.review = null; view.acknowledged = false; view.error = ""; view.invalidated = false; view.terminal = false; view.reading = true;
  const request = ++view.request;
  renderEmptyTrashReview(); setActionStatus("#empty-trash-status", TagcastI18n.text("trashEmpty.loading"), true);
  if (!$("#empty-trash").open) $("#empty-trash").showModal();
  $("#empty-trash-title").focus();
  try {
    const data = await api("/api/trash/empty/review", {session: view.session});
    if (!emptyTrashCurrent(request) || !$("#empty-trash").open) return;
    if (!validEmptyTrashPage(data)) throw TagcastI18n.failure("trash_empty.shape");
    view.review = data;
  } catch (error) { if (emptyTrashCurrent(request)) view.error = TagcastI18n.errorText(error); }
  finally {
    if (request === view.request) { view.reading = false; setActionStatus("#empty-trash-status", ""); renderEmptyTrashReview(); }
  }
}

async function pageEmptyTrash(offset) {
  const view = emptyTrashView, review = view.review, request = view.request;
  if (!review || view.busy || view.reading || !emptyTrashCurrent(request)) return;
  view.reading = true; renderEmptyTrashReview(); setActionStatus("#empty-trash-status", TagcastI18n.text("trashEmpty.loading"), true);
  try {
    const data = await api("/api/trash/empty/page", {session: view.session, review: review.review, offset});
    if (!emptyTrashCurrent(request)) return;
    if (!validEmptyTrashPage(data, review) || data.offset !== offset) throw TagcastI18n.failure("trash_empty.shape");
    view.review = data;
  } catch (error) {
    if (emptyTrashCurrent(request)) { view.error = TagcastI18n.errorText(error); view.review = null; }
  } finally {
    if (request === view.request) { view.reading = false; setActionStatus("#empty-trash-status", ""); renderEmptyTrashReview(); }
  }
}

async function saveEmptyTrash() {
  const view = emptyTrashView, review = view.review, request = view.request;
  if (!review?.count || !view.acknowledged || view.busy || view.reading || view.terminal || saving || checking || !emptyTrashCurrent(request)) return;
  if (!confirm(TagcastI18n.text("trashEmpty.confirm", {count: review.count}))) return;
  const entry = {emptyTrash: {count: review.count, digest: review.digest}, trash: true, source: "ibroadcast",
    created: new Date().toISOString(), status: "sent", error: "", selection: [],
    changes: [{kind: "trash", id: "empty", label: "iBroadcast trash", fields: {}, status: "sent"}]};
  view.busy = true; saving = true; state.history.unshift(entry); rememberHistory(); updateChrome();
  renderEmptyTrashReview(); setActionStatus("#empty-trash-status", TagcastI18n.text("trashEmpty.processing"), true);
  try {
    const result = await api("/api/trash/empty/save", {session: view.session, review: review.review, approved: true, acknowledged: true});
    if (!emptyTrashCurrent(request)) return;
    entry.error = result.error || "";
    setActionStatus("#empty-trash-status", TagcastI18n.text("trashEmpty.checking"), true);
    const job = await followJob(result.job, entry, null, () => emptyTrashCurrent(request));
    if (!job || request !== view.request || view.session !== state.connection.playback_session) return;
    view.details = state.details;
    if (job.state !== "done" || entry.status !== "saved") view.error = TagcastI18n.text("trashEmpty.unconfirmed");
    else { setActionStatus("#empty-trash-status", TagcastI18n.text("trashEmpty.done", {count: review.count})); toast(TagcastI18n.text("trashEmpty.done", {count: review.count})); }
  } catch (error) {
    entry.status = [401, 409].includes(error.status) ? "blocked" : error.status === 400 ? "failed" : "unverified";
    entry.error = error.message; entry.changes[0].status = entry.status;
    if (emptyTrashCurrent(request)) view.error = TagcastI18n.errorText(error);
  } finally {
    if (entry.status === "sent") { entry.status = "unverified"; entry.changes[0].status = "unverified"; }
    rememberHistory(); view.busy = false; saving = false; view.terminal = true;
    if (request !== view.request) view.error = TagcastI18n.text("trashEmpty.unconfirmed");
    setActionStatus("#empty-trash-status", undefined); renderEmptyTrashReview(); updateChrome();
  }
}

function emptyTrashHistoryMarkup(entry) {
  const count = Number.isSafeInteger(entry.emptyTrash?.count) && entry.emptyTrash.count >= 0 ? entry.emptyTrash.count : 0;
  return `<section class="history-item">${statusPill(entry.status)}<h3>${TagcastI18n.html("trashEmpty.heading")}</h3><p class="muted">${escapeHtml(historyDate(entry.created))}</p><p>${TagcastI18n.html("trashEmpty.count", {count})}</p>${entry.error ? `<div class="error-box">${escapeHtml(entry.error)}</div>` : ""}${entry.status === "saved" ? `<p>${TagcastI18n.html("trashEmpty.done", {count})}</p>` : `<p>${TagcastI18n.html("trashEmpty.unconfirmed")}</p>`}</section>`;
}

document.addEventListener("click", event => {
  if (event.target.closest("[data-empty-trash-open]")) openEmptyTrashReview();
  if (event.target.closest("#empty-trash-save")) saveEmptyTrash();
  if (event.target.closest("#empty-trash-previous")) pageEmptyTrash(emptyTrashView.review.offset - 50);
  if (event.target.closest("#empty-trash-next")) pageEmptyTrash(emptyTrashView.review.offset + 50);
});
$("#empty-trash").addEventListener("change", event => {
  if (event.target.id === "empty-trash-acknowledge" && !emptyTrashView.busy && !emptyTrashView.reading) {
    emptyTrashView.acknowledged = event.target.checked; $("#empty-trash-save").disabled = !event.target.checked;
  }
});
$("#empty-trash").addEventListener("cancel", event => { if (emptyTrashView.busy) event.preventDefault(); });
$("#empty-trash").addEventListener("close", () => {
  emptyTrashView.request += 1; emptyTrashView.review = null; emptyTrashView.reading = false;
  setActionStatus("#empty-trash-status", ""); if (emptyTrashView.focus?.isConnected) emptyTrashView.focus.focus();
  else document.querySelector("[data-empty-trash-open]")?.focus();
});
