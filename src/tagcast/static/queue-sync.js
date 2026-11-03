"use strict";

// One explicitly connected browser owns the bridge. Other tabs cannot play its queue.
// `error` is "" or a function that returns the message in the current interface language.
const queueSync = {enabled: false, active: false, browser: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`,
  view: null, timer: null, publishing: false, applying: false, allowed: false, choicePending: false, request: 0, revision: -1, error: ""};
// Display keys for the bridge's status, role and repeat codes; unknown codes are shown as sent.
const QUEUE_SYNC_STATUS = {connected: "queueSync.status.connected", connecting: "queueSync.status.connecting", reconnecting: "queueSync.status.reconnecting", disconnected: "queueSync.status.disconnected"};
const QUEUE_SYNC_ROLES = {player: "queueSync.role.player", controller: "queueSync.role.controller"};
const QUEUE_SYNC_REPEAT = {none: "queueSync.repeat.none", queue: "queueSync.repeat.queue", track: "queueSync.repeat.track"};
const queueSyncCode = (keys, code) => Object.hasOwn(keys, code) ? TagcastI18n.html(keys[code]) : escapeHtml(code);
const queueSyncFailure = error => () => TagcastI18n.errorText(error);

function applyQueueSettings(data) {
  lookup.queueSync = data.queue_sync === true; queueSync.enabled = lookup.queueSync;
  $("#devices-button").hidden = !queueSync.enabled;
  if (!queueSync.enabled) {
    clearTimeout(queueSync.timer); queueSync.active = false; queueSync.view = null; queueSync.allowed = false; queueSync.choicePending = false;
    $("#player").hidden = !player.queue.length;
    document.body.classList.toggle("has-player", Boolean(player.queue.length));
  }
}

function localPlaybackAllowed() {
  if (!queueSync.active) return true;
  const v = queueSync.view;
  return v?.owner === queueSync.browser && v.own && v.state?.role === "player" && queueSync.allowed;
}

function bridgeBody(action) {
  return {action, browser: queueSync.browser, session: state.connection.playback_session};
}

function encodedLocalQueue() {
  const track = player.queue[player.index];
  if (queueSync.handover && queueSync.handover.entry !== track) queueSync.handover = null;
  const normal = player.queue.filter(t => !t.upNext), next = player.queue.slice(Math.max(0, player.index)).filter(t => t.upNext);
  return {tracks: normal.map(t => Number(t.id)), play_next: next.map(t => Number(t.id)),
    current_song: Number(track?.id) || 0, name: track?.title || "", pause: audio.paused || !track,
    shuffle: Boolean(player.shuffle), start_position: queueSync.handover?.position ?? (Number(audio.currentTime) || 0), start_time: Date.now() / 1000,
    volume: Number.isFinite(audio.volume) ? audio.volume : 1,
    data: {play_from: track?.upNext ? "play_next" : "tracks", repeat_mode: player.repeat, crossfade: false,
      play_index: player.index < 0 ? 0 : player.queue.slice(0, player.index).filter(t => !t.upNext).length}};
}

async function publishQueueState() {
  if (!queueSync.active || queueSync.applying || !localPlaybackAllowed() || queueSync.publishing || queueSync.view?.status !== "connected") return;
  queueSync.publishing = true;
  const session = state.connection.playback_session;
  try {
    const view = await api("/api/queue-sync", {...bridgeBody("state"), revision: queueSync.view.revision, state: encodedLocalQueue()});
    if (session !== state.connection.playback_session || !queueSync.active) return;
    queueSync.view = view; queueSync.revision = view.revision; queueSync.error = ""; return true;
  } catch (error) { queueSync.error = queueSyncFailure(error); }
  finally { queueSync.publishing = false; }
}

function scheduleQueuePublish() {
  clearTimeout(queueSync.publishTimer);
  if (queueSync.active && !queueSync.applying) queueSync.publishTimer = setTimeout(publishQueueState, 250);
}

async function restoreQueue(view, resume = false) {
  const q = view.state, data = q?.data;
  if (!data || !view.own || q.role !== "player" || view.owner !== queueSync.browser) return;
  const request = ++queueSync.request, details = state.details, session = state.connection.playback_session;
  queueSync.applying = true;
  try {
    const index = Math.min(data.play_index, q.tracks.length), insert = data.play_from === "play_next" ? index : Math.min(index + 1, q.tracks.length), ids = [...q.tracks.slice(0, insert), ...q.play_next, ...q.tracks.slice(insert)];
    const fingerprint = `${ids.join(",")}:${index}:${q.play_next.length}`;
    let rows = player.queue;
    if (fingerprint !== queueSync.fingerprint || player.queue !== queueSync.restoredRows) {
      rows = await selectedQueueTracks(ids, () => request === queueSync.request && details === state.details && session === state.connection.playback_session);
      for (let i = insert; i < insert + q.play_next.length; i += 1) rows[i].upNext = true;
    }
    if (request !== queueSync.request || session !== state.connection.playback_session || !queueSync.active) return;
    queueSync.fingerprint = fingerprint; queueSync.restoredRows = rows;
    const currentIndex = data.play_from === "play_next" ? insert : index;
    const changed = player.queue[player.index]?.id !== rows[currentIndex]?.id;
    player.queue = rows; player.index = rows.length ? currentIndex : -1; player.repeat = data.repeat_mode; player.shuffle = q.shuffle;
    const desired = Number(q.start_position) + (q.pause ? 0 : Math.max(0, Date.now() / 1000 - Number(q.start_time)));
    audio.volume = q.volume;
    if (rows[currentIndex] && (changed || !audio.getAttribute("src"))) {
      const wasAllowed = queueSync.allowed;
      queueSync.allowed = true; playCurrent(false); queueSync.allowed = wasAllowed || resume;
      audio.pause();
      audio.addEventListener("loadedmetadata", () => {
        if (request === queueSync.request && session === state.connection.playback_session && queueSync.active && player.queue[player.index] === rows[currentIndex]) { audio.currentTime = Math.min(desired, Number.isFinite(audio.duration) ? audio.duration : desired); if (resume && !q.pause) audio.play().catch(() => toast(TagcastI18n.text("queueSync.toast.allowAudio"))); }
      }, {once: true});
    } else if (rows[currentIndex]) {
      if (Math.abs((audio.currentTime || 0) - desired) > 3) audio.currentTime = desired;
      if (q.pause || !queueSync.allowed) audio.pause(); else if (audio.paused) audio.play().catch(() => toast(TagcastI18n.text("queueSync.toast.allowAudio")));
    } else audio.pause();
    markPlaying(); renderStreamQuality();
  } catch (error) { queueSync.error = () => TagcastI18n.text("errors.queueSync.restoreFailed", {error: TagcastI18n.errorText(error)}); }
  finally { if (request === queueSync.request) queueSync.applying = false; }
}

async function pollQueue() {
  clearTimeout(queueSync.timer);
  if (!queueSync.enabled || (!queueSync.active && !$("#devices-dialog").open) || !live()) return;
  const session = state.connection.playback_session;
  try {
    const view = await api("/api/queue-sync");
    if (session !== state.connection.playback_session || !queueSync.enabled) return;
    queueSync.view = view;
    if (view.authenticated === false) {
      queueSync.active = false; queueSync.allowed = false;
      state.connection.connected = false; state.connection.playback_session = "";
      queueSync.error = () => TagcastI18n.text("errors.queueSync.sessionEnded");
      useLocal(demoLibrary(), "demo"); updateChrome(); render(); renderDevices(); return;
    }
    if (queueSync.active && view.session !== session) { queueSync.active = false; queueSync.allowed = false; }
    if (queueSync.active && !localPlaybackAllowed()) { audio.pause(); playReporting.watch = null; }
    if (queueSync.active && !queueSync.choicePending && view.revision !== queueSync.revision && !queueSync.publishing) {
      queueSync.revision = view.revision;
      if (view.own && view.state?.role === "player") await restoreQueue(view);
    }
    if (view.state?.role === "controller") { queueSync.allowed = false; audio.pause(); playReporting.watch = null; closeVisualPlayer(); }
    const controlling = queueSync.active && (!view.own || view.state?.role === "controller");
    $("#player").hidden = controlling || !player.queue.length;
    document.body.classList.toggle("has-player", !controlling && Boolean(player.queue.length));
    if (typeof syncSystemPlayback === "function") syncSystemPlayback();
    renderDevices(false);
  } catch (error) { queueSync.error = queueSyncFailure(error); renderDevices(false); }
  if (queueSync.active || $("#devices-dialog").open) queueSync.timer = setTimeout(pollQueue, 1000);
}

function renderDevices(force = true) {
  if (!$("#devices-dialog").open) return;
  const problem = queueSync.error ? queueSync.error() : "";
  const signature = JSON.stringify([queueSync.view, problem, TagcastI18n.language]);
  if (!force && (signature === queueSync.devicesSignature || document.activeElement?.closest?.("#remote-controls"))) return;
  queueSync.devicesSignature = signature;
  const v = queueSync.view, q = v?.state || {}, owner = !v?.owner || v.owner === queueSync.browser;
  const status = v?.status || "disconnected", connected = status === "connected";
  // Device names, the track name and server errors are shown as reported.
  const counts = [TagcastI18n.html("queueSync.devices.queued", {count: q.tracks?.length || 0}), TagcastI18n.html("queueSync.devices.upNext", {count: q.play_next?.length || 0}),
    ...q.shuffle ? [TagcastI18n.html("queueSync.devices.shuffle")] : []].join(" · ");
  $("#devices-content").innerHTML = `<p class="muted">${TagcastI18n.html("queueSync.devices.intro")}</p><p role="status">${queueSyncCode(QUEUE_SYNC_STATUS, status)}${q.role ? ` · ${queueSyncCode(QUEUE_SYNC_ROLES, q.role)} · ${TagcastI18n.html(v.own ? "queueSync.devices.ownQueue" : "queueSync.devices.remote")}` : ""}</p>${problem || v?.error ? `<p class="error-box">${escapeHtml(problem || v.error)}</p>` : ""}${!owner ? `<p>${TagcastI18n.html("queueSync.devices.otherTab")}</p><button class="button small" data-device-force>${TagcastI18n.html("queueSync.devices.forceDisconnect")}</button>` : `<div class="device-list"><button class="button" data-device-connect="">${TagcastI18n.html("queueSync.devices.connectOwn")}</button>${(v?.devices || []).filter(d => d.joinable).map(d => `<button class="button" data-device-connect="${escapeHtml(d.id)}">${TagcastI18n.html("queueSync.devices.control", {device: d.name || d.id})}</button>`).join("")}</div>${connected ? `<h3>${q.name ? escapeHtml(q.name) : TagcastI18n.html("queueSync.devices.noTrack")}</h3><p>${counts}</p><div class="album-detail-actions">${v.own && q.role === "player" ? `<button class="button" data-device-local>${TagcastI18n.html("queueSync.devices.useLocal")}</button><button class="button" data-device-resume>${TagcastI18n.html("queueSync.devices.restore")}</button>` : `<button class="button" data-device-command="previous">${TagcastI18n.html("queueSync.devices.previous")}</button><button class="button primary" data-device-command="pause">${TagcastI18n.html("queueSync.devices.playPause")}</button><button class="button" data-device-command="next">${TagcastI18n.html("queueSync.devices.next")}</button>`}</div>${!v.own || q.role === "controller" ? `<form id="remote-controls"><label>${TagcastI18n.html("queueSync.controls.position")} <input name="position" type="number" min="0" max="86400" value="${Math.floor(q.start_position || 0)}"></label><label>${TagcastI18n.html("queueSync.controls.volume")} <input name="volume" type="range" min="0" max="1" step="0.05" value="${q.volume ?? 0.8}"></label><label>${TagcastI18n.html("queueSync.controls.repeat")} <select name="repeat">${["none", "queue", "track"].map(r => `<option value="${r}" ${q.data?.repeat_mode === r ? "selected" : ""}>${queueSyncCode(QUEUE_SYNC_REPEAT, r)}</option>`).join("")}</select></label><button class="button small">${TagcastI18n.html("queueSync.controls.apply")}</button></form>` : ""}` : ""}<button class="button small" data-device-disconnect ${status === "disconnected" ? "disabled" : ""}>${TagcastI18n.html("queueSync.devices.disconnect")}</button>`}${v?.library_changed ? `<p class="muted">${TagcastI18n.html("queueSync.devices.libraryChanged")}</p>` : ""}`;
}

async function connectQueue(target = "") {
  if (!queueSync.enabled || !live()) return;
  try {
    queueSync.view = await api("/api/queue-sync", {...bridgeBody("connect"), target});
    queueSync.active = true; queueSync.allowed = false; queueSync.choicePending = !target; queueSync.request += 1; queueSync.revision = -1; queueSync.fingerprint = null;
    queueSync.error = ""; audio.pause(); playReporting.watch = null; pollQueue();
  } catch (error) { queueSync.error = queueSyncFailure(error); renderDevices(); }
}

async function remoteCommand(command, form = null) {
  const v = queueSync.view;
  if (!v?.state?.data || v.status !== "connected") return;
  const q = JSON.parse(JSON.stringify(v.state)), d = q.data;
  // Snapshot the remote playhead before pausing or moving to another track.
  q.start_position += q.pause ? 0 : Math.max(0, Date.now() / 1000 - q.start_time);
  q.start_time = Date.now() / 1000;
  if (command === "pause") q.pause = !q.pause;
  if (command === "next") {
    if (d.play_from === "play_next") { q.play_next.shift(); d.play_from = q.play_next.length ? "play_next" : "tracks"; }
    else { d.play_index += 1; if (q.play_next.length) d.play_from = "play_next"; }
    if (d.play_from === "tracks" && d.play_index >= q.tracks.length) {
      if (d.repeat_mode === "queue") d.play_index = 0; else { d.play_index = Math.max(0, q.tracks.length - 1); q.pause = true; }
    }
    q.current_song = d.play_from === "play_next" ? q.play_next[0] || 0 : q.tracks[d.play_index] || 0;
    q.start_position = 0;
  }
  if (command === "previous") { d.play_from = "tracks"; d.play_index = Math.max(0, d.play_index - 1); q.current_song = q.tracks[d.play_index] || 0; q.start_position = 0; }
  if (form) { q.start_position = Number(form.elements.position.value); q.volume = Number(form.elements.volume.value); d.repeat_mode = form.elements.repeat.value; }
  try { queueSync.view = await api("/api/queue-sync", {...bridgeBody("state"), revision: v.revision, state: q}); queueSync.revision = queueSync.view.revision; queueSync.error = ""; }
  catch (error) { queueSync.error = queueSyncFailure(error); }
  renderDevices();
}

$("#devices-button").addEventListener("click", () => { $("#devices-dialog").showModal(); renderDevices(); pollQueue(); });
// A language change redraws an open Devices dialog from the last view, without a request.
// Remote control values being edited stay; focus returns to the same button.
TagcastI18n.subscribe(() => {
  const content = $("#devices-content"), active = document.activeElement;
  if (!$("#devices-dialog").open || active?.closest?.("#remote-controls")) return;
  const inside = active && content.contains?.(active) && typeof active.getAttributeNames === "function";
  const data = inside ? active.getAttributeNames().filter(name => name.startsWith("data-device-")) : [];
  renderDevices(false);
  if (!data.length || (document.activeElement && document.activeElement !== document.body)) return;
  const match = [...content.querySelectorAll("button")].find(node => data.every(name => node.getAttribute(name) === active.getAttribute(name)));
  match?.focus({preventScroll: true});
});
for (const event of ["play", "pause", "seeked", "volumechange", "ended"]) audio.addEventListener(event, scheduleQueuePublish);
document.addEventListener("click", async event => {
  const target = event.target, device = target.closest("[data-device-connect]");
  if (device) return connectQueue(device.dataset.deviceConnect);
  if (target.closest("[data-queue-reconnect]")) {
    if (!lookup.queueSync) { toast(TagcastI18n.text("queueSync.toast.enableFirst")); return; }
    if (state.connection.using_default_client !== false) {
      connectView("ready"); $("#connect").showModal(); return;
    }
    try { const result = await api("/api/auth/browser", {}); window.open(result.url, "_blank", "noopener"); }
    catch (error) { toast(TagcastI18n.errorText(error)); }
  }
  if (target.closest("[data-device-disconnect], [data-device-force]")) {
    if (target.closest("[data-device-force]") && !confirm(TagcastI18n.text("queueSync.confirm.force"))) return;
    try { await api("/api/queue-sync", {...bridgeBody("disconnect"), force: Boolean(target.closest("[data-device-force]"))}); queueSync.active = false; queueSync.allowed = false; queueSync.choicePending = false; queueSync.request += 1; queueSync.view = null; clearTimeout(queueSync.timer); $("#player").hidden = !player.queue.length; document.body.classList.toggle("has-player", Boolean(player.queue.length)); renderDevices(); }
    catch (error) { toast(TagcastI18n.errorText(error)); }
  }
  if (target.closest("[data-device-local]")) { queueSync.allowed = true; if (await publishQueueState()) queueSync.choicePending = false; else queueSync.allowed = false; renderDevices(); }
  if (target.closest("[data-device-resume]")) { queueSync.choicePending = false; queueSync.allowed = true; await restoreQueue(queueSync.view, true); if (player.queue.length) await audio.play().catch(() => toast(TagcastI18n.text("queueSync.toast.pressPlay"))); $("#devices-dialog").close(); scheduleQueuePublish(); }
  const command = target.closest("[data-device-command]");
  if (command) remoteCommand(command.dataset.deviceCommand);
});
document.addEventListener("submit", event => {
  if (event.target.id === "remote-controls") { event.preventDefault(); remoteCommand("controls", event.target); }
});

window.addEventListener("pagehide", () => {
  if (!queueSync.active || queueSync.view?.owner !== queueSync.browser) return;
  fetch("/api/queue-sync", {method: "POST", headers: {"X-Tagcast": "1", "Content-Type": "application/json"}, body: JSON.stringify(bridgeBody("disconnect")), keepalive: true}).catch(() => {});
});
