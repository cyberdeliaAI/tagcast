"use strict";

// One explicitly connected browser owns the bridge. Other tabs cannot play its queue.
const queueSync = {enabled: false, active: false, browser: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`,
  view: null, timer: null, publishing: false, applying: false, allowed: false, request: 0, revision: -1, error: ""};

function applyQueueSettings(data) {
  lookup.queueSync = data.queue_sync === true; queueSync.enabled = lookup.queueSync;
  $("#devices-button").hidden = !queueSync.enabled;
  if (!queueSync.enabled) {
    clearTimeout(queueSync.timer); queueSync.active = false; queueSync.view = null; queueSync.allowed = false;
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
  const normal = player.queue.filter(t => !t.upNext), next = player.queue.slice(Math.max(0, player.index)).filter(t => t.upNext);
  return {tracks: normal.map(t => Number(t.id)), play_next: next.map(t => Number(t.id)),
    current_song: Number(track?.id) || 0, name: track?.title || "", pause: audio.paused || !track,
    shuffle: Boolean(player.shuffle), start_position: Number(audio.currentTime) || 0, start_time: Date.now() / 1000,
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
    queueSync.view = view; queueSync.revision = view.revision; queueSync.error = "";
  } catch (error) { queueSync.error = error.message; }
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
        if (request === queueSync.request && session === state.connection.playback_session && queueSync.active && player.queue[player.index] === rows[currentIndex]) { audio.currentTime = Math.min(desired, Number.isFinite(audio.duration) ? audio.duration : desired); if (resume && !q.pause) audio.play().catch(() => toast("Press Play to allow audio in this browser.")); }
      }, {once: true});
    } else if (rows[currentIndex]) {
      if (Math.abs((audio.currentTime || 0) - desired) > 3) audio.currentTime = desired;
      if (q.pause || !queueSync.allowed) audio.pause(); else if (audio.paused) audio.play().catch(() => toast("Press Play to allow audio in this browser."));
    } else audio.pause();
    markPlaying(); renderStreamQuality();
  } catch (error) { queueSync.error = `Could not restore the queue: ${error.message}`; }
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
      queueSync.error = "iBroadcast ended this session. Reconnect your account.";
      useLocal(demoLibrary(), "demo"); updateChrome(); render(); renderDevices(); return;
    }
    if (queueSync.active && view.session !== session) { queueSync.active = false; queueSync.allowed = false; }
    if (queueSync.active && !localPlaybackAllowed()) { audio.pause(); playReporting.watch = null; }
    if (queueSync.active && view.revision !== queueSync.revision && !queueSync.publishing) {
      queueSync.revision = view.revision;
      if (view.own && view.state?.role === "player") await restoreQueue(view);
    }
    if (view.state?.role === "controller") { queueSync.allowed = false; audio.pause(); playReporting.watch = null; closeVisualPlayer(); }
    const controlling = queueSync.active && (!view.own || view.state?.role === "controller");
    $("#player").hidden = controlling || !player.queue.length;
    document.body.classList.toggle("has-player", !controlling && Boolean(player.queue.length));
    if (typeof syncSystemPlayback === "function") syncSystemPlayback();
    renderDevices(false);
  } catch (error) { queueSync.error = error.message; renderDevices(false); }
  if (queueSync.active || $("#devices-dialog").open) queueSync.timer = setTimeout(pollQueue, 1000);
}

function renderDevices(force = true) {
  if (!$("#devices-dialog").open) return;
  const signature = JSON.stringify([queueSync.view, queueSync.error]);
  if (!force && (signature === queueSync.devicesSignature || document.activeElement?.closest?.("#remote-controls"))) return;
  queueSync.devicesSignature = signature;
  const v = queueSync.view, q = v?.state || {}, owner = !v?.owner || v.owner === queueSync.browser;
  const status = v?.status || "disconnected", connected = status === "connected";
  $("#devices-content").innerHTML = `<p class="muted">Queue synchronisation is optional. Only one browser tab owns this connection. A remote controller never plays audio or records plays.</p><p role="status">${escapeHtml(status)}${q.role ? ` · ${escapeHtml(q.role)} · ${v.own ? "This app’s queue" : "Remote device"}` : ""}</p>${queueSync.error || v?.error ? `<p class="error-box">${escapeHtml(queueSync.error || v.error)}</p>` : ""}${!owner ? '<p>Another tab owns this connection. Disconnect it in that tab first.</p><button class="button small" data-device-force>Disconnect the other tab’s queue connection</button>' : `<div class="device-list"><button class="button" data-device-connect="">Connect this app’s queue</button>${(v?.devices || []).filter(d => d.joinable).map(d => `<button class="button" data-device-connect="${escapeHtml(d.id)}">Control ${escapeHtml(d.name || d.id)}</button>`).join("")}</div>${connected ? `<h3>${escapeHtml(q.name || "No current track")}</h3><p>${q.tracks?.length || 0} queued tracks · ${q.play_next?.length || 0} up next${q.shuffle ? ' · Shuffle is enabled on this device' : ''}</p><div class="album-detail-actions">${v.own && q.role === "player" ? '<button class="button" data-device-local>Use my current local queue</button><button class="button" data-device-resume>Restore and play here</button>' : '<button class="button" data-device-command="previous">⏮ Previous</button><button class="button primary" data-device-command="pause">Play / Pause</button><button class="button" data-device-command="next">Next ⏭</button>'}</div>${!v.own || q.role === "controller" ? `<form id="remote-controls"><label>Position (seconds) <input name="position" type="number" min="0" max="86400" value="${Math.floor(q.start_position || 0)}"></label><label>Volume <input name="volume" type="range" min="0" max="1" step="0.05" value="${q.volume ?? 0.8}"></label><label>Repeat <select name="repeat">${["none", "queue", "track"].map(r => `<option value="${r}" ${q.data?.repeat_mode === r ? "selected" : ""}>${r}</option>`).join("")}</select></label><button class="button small">Apply controls</button></form>` : ""}` : ""}<button class="button small" data-device-disconnect ${status === "disconnected" ? "disabled" : ""}>Disconnect queue</button>`}${v?.library_changed ? '<p class="muted">iBroadcast reports a library change. Use Reload library to refresh its contents.</p>' : ''}`;
}

async function connectQueue(target = "") {
  if (!queueSync.enabled || !live()) return;
  try {
    queueSync.view = await api("/api/queue-sync", {...bridgeBody("connect"), target});
    queueSync.active = true; queueSync.allowed = false; queueSync.revision = -1; queueSync.fingerprint = null;
    queueSync.error = ""; audio.pause(); playReporting.watch = null; pollQueue();
  } catch (error) { queueSync.error = error.message; renderDevices(); }
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
  catch (error) { queueSync.error = error.message; }
  renderDevices();
}

$("#devices-button").addEventListener("click", () => { $("#devices-dialog").showModal(); renderDevices(); pollQueue(); });
for (const event of ["play", "pause", "seeked", "volumechange", "ended"]) audio.addEventListener(event, scheduleQueuePublish);
document.addEventListener("click", async event => {
  const target = event.target, device = target.closest("[data-device-connect]");
  if (device) return connectQueue(device.dataset.deviceConnect);
  if (target.closest("[data-queue-reconnect]")) {
    if (!lookup.queueSync) { toast("Save Enable queue synchronisation first, then reconnect."); return; }
    if (state.connection.using_default_client !== false) {
      connectView("ready"); $("#connect").showModal(); return;
    }
    try { const result = await api("/api/auth/browser", {}); window.open(result.url, "_blank", "noopener"); }
    catch (error) { toast(error.message); }
  }
  if (target.closest("[data-device-disconnect], [data-device-force]")) {
    if (target.closest("[data-device-force]") && !confirm("Disconnect the other tab’s queue bridge? This does not stop a remote device’s audio.")) return;
    try { await api("/api/queue-sync", {...bridgeBody("disconnect"), force: Boolean(target.closest("[data-device-force]"))}); queueSync.active = false; queueSync.allowed = false; queueSync.view = null; clearTimeout(queueSync.timer); $("#player").hidden = !player.queue.length; document.body.classList.toggle("has-player", Boolean(player.queue.length)); renderDevices(); }
    catch (error) { toast(error.message); }
  }
  if (target.closest("[data-device-local]")) { queueSync.allowed = true; await publishQueueState(); renderDevices(); }
  if (target.closest("[data-device-resume]")) { queueSync.allowed = true; await restoreQueue(queueSync.view, true); if (player.queue.length) await audio.play().catch(() => toast("Press Play in the player.")); $("#devices-dialog").close(); scheduleQueuePublish(); }
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
