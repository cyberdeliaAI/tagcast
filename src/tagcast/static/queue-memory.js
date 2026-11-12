"use strict";

// Restore IDs/occurrences only, against fresh metadata in the loaded account. No credentials,
// names, stream URLs, audio, drafts or output-device settings enter browser storage.
const queueMemory = {profile: "", session: "", attempted: "", restoring: false};
function queueMemoryOwner() {
  return live() && !state.loading && queueMemory.profile && queueMemory.session === state.connection.playback_session
    && (typeof queueSync === "undefined" || !queueSync.active && !queueSync.applying)
    && (typeof localPlaybackAllowed !== "function" || localPlaybackAllowed());
}
function bindQueueMemory(profile) {
  const valid = typeof profile === "string" && /^[a-f0-9]{64}$/.test(profile) ? profile : "";
  queueMemory.profile = valid; queueMemory.session = state.connection.playback_session;
}
function detachQueueMemory() {
  saveQueueMemory(); queueMemory.profile = ""; queueMemory.session = ""; queueMemory.attempted = "";
}
function saveQueueMemory(clear = false) {
  if (!queueMemoryOwner() || queueMemory.restoring) return;
  if (!player.queue.length && !clear) return;
  // Explicitly clearing also cancels a pending restore in this tab.
  queueMemory.attempted = queueMemory.session;
  if (player.queue.length > 10000) return;
  const runs = new Map();
  const entries = player.queue.map(track => {
    const entry = {id: String(track.id), upNext: track.upNext === true};
    const origin = typeof gaplessAlbumEntry === "function" ? gaplessAlbumEntry(track) : null;
    if (origin) {
      if (!runs.has(origin.run)) runs.set(origin.run, runs.size);
      entry.run = runs.get(origin.run); entry.order = origin.index; entry.length = origin.run.length;
    }
    return entry;
  });
  try { localStorage.setItem(`tagcast-queue-${queueMemory.profile}`, JSON.stringify({version: 1, entries,
    index: Math.min(Math.max(0, player.index), entries.length - 1), repeat: player.repeat, shuffle: player.shuffle})); } catch { /* private/full storage: playback continues */ }
}
function readQueueMemory(profile) {
  try {
    const raw = localStorage.getItem(`tagcast-queue-${profile}`);
    if (!raw || raw.length > 1500000) return null;
    const data = JSON.parse(raw);
    if (data?.version !== 1 || !Array.isArray(data.entries) || !data.entries.length || data.entries.length > 10000
      || !Number.isInteger(data.index) || data.index < 0 || data.index >= data.entries.length
      || !["none", "queue", "track"].includes(data.repeat) || typeof data.shuffle !== "boolean"
      || data.entries.some(entry => !entry || typeof entry.id !== "string" || !/^[1-9][0-9]{0,31}$/.test(entry.id))) return null;
    return data;
  } catch { return null; }
}
async function restoreQueueMemory() {
  if (!queueMemoryOwner() || queueMemory.attempted === queueMemory.session || player.queue.length) return;
  const {profile, session} = queueMemory, details = state.details, epoch = player.epoch;
  queueMemory.attempted = session;
  const saved = readQueueMemory(profile); if (!saved) return;
  const current = () => queueMemoryOwner() && profile === queueMemory.profile && session === queueMemory.session
    && details === state.details && epoch === player.epoch && !player.queue.length;
  const restored = [];
  try {
    for (let offset = 0; offset < saved.entries.length; offset += 1000) {
      if (!current()) return;
      const result = await api("/api/queue-tracks", {tracks: saved.entries.slice(offset, offset + 1000).map(entry => entry.id), restore: true, profile, session});
      if (!current()) return;
      if (!Array.isArray(result.tracks)) return;
      for (const track of result.tracks) {
        const position = offset + track.position, entry = saved.entries[position];
        if (!Number.isInteger(track.position) || track.position < 0 || track.position >= 1000 || !entry || track.id !== entry.id) return;
        const {details: metadata, ...playback} = track;
        restored.push({track: {...playback, upNext: entry.upNext === true}, position, metadata});
      }
    }
    if (!current() || !restored.length) return;
    queueMemory.restoring = true;
    player.queue = restored.map(item => item.track);
    if (typeof rememberWorkspaceQueueDetails === "function") for (const {track, metadata} of restored) {
      rememberWorkspaceQueueDetails(track, metadata || {track});
    }
    const next = restored.findIndex(item => item.position >= saved.index);
    player.index = next < 0 ? restored.length - 1 : next;
    player.repeat = saved.repeat; player.shuffle = saved.shuffle; player.epoch += 1;
    // Removed entries invalidate ordered-album preparation; ordinary playback remains safe.
    if (restored.length === saved.entries.length && typeof gaplessTrial !== "undefined") {
      const runs = new Map();
      for (const {track, position} of restored) {
        const entry = saved.entries[position];
        if (!entry.upNext && Number.isInteger(entry.run) && entry.run >= 0 && entry.run < 10000
          && Number.isInteger(entry.order) && Number.isInteger(entry.length) && entry.length > 0 && entry.length <= 10000
          && entry.order >= 0 && entry.order < entry.length) {
          if (!runs.has(entry.run)) runs.set(entry.run, {length: entry.length});
          gaplessTrial.origins.set(track, {run: runs.get(entry.run), index: entry.order});
        }
      }
    }
    player.resumePending = true;
    renderRepeatButton(); renderCurrentPlayerTrack(); gaplessRenderTransport();
  } catch { /* Keep the saved queue for the next restart; a failed read never starts playback. */ }
  finally { queueMemory.restoring = false; }
}
window.addEventListener("pagehide", () => saveQueueMemory());
