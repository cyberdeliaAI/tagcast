"use strict";

// Moving tracks to iBroadcast's trash from the album page: choose tracks, review them,
// then send. iBroadcast keeps them in its trash; Tagcast can't take them back out.

function albumDiscs() {
  return shelfIds(albumView.id).map(id => state.details.get(id)).filter(Boolean);
}

function trashBar(discs) {
  const count = albumView.trash.size, all = discs.reduce((n, d) => n + d.tracks.length, 0);
  return `<div class="selection-bar trash-bar"><strong>${count} of ${all} tracks selected for the trash</strong>${extraCopies(discs).length ? '<button class="button small" data-trash-duplicates>Select extra copies</button>' : ""}<button class="button small" data-trash-all>${count === all ? "Select none" : "Select all"}</button><button class="button small" data-trash-cancel>Cancel</button><button class="button small primary" data-trash-review ${count ? "" : "disabled"}>Review →</button></div>`;
}

const trashCheck = t => `<input type="checkbox" class="trash-check" data-trash-track="${escapeHtml(t.id)}" aria-label="Select ${escapeHtml(t.title)} for the trash" ${albumView.trash.has(String(t.id)) ? "checked" : ""}>`;

// Every copy of a title after the first one on its disc.
function extraCopies(discs) {
  const ids = [];
  for (const d of discs) {
    const seen = new Set();
    for (const t of d.tracks) {
      const key = titleKey(t.title);
      if (key && seen.has(key)) ids.push(String(t.id)); else seen.add(key);
    }
  }
  return ids;
}

function chosenTracks() {
  const chosen = albumView.trash || new Set();
  return albumDiscs().flatMap(d => d.tracks.filter(t => chosen.has(String(t.id))).map(t => ({disc: d, track: t})));
}

function showTrashReview() {
  const discs = albumDiscs(), rows = chosenTracks();
  if (!rows.length) return;
  const whole = rows.length === discs.reduce((n, d) => n + d.tracks.length, 0), several = discs.length > 1;
  const noun = `${rows.length} ${rows.length === 1 ? "track" : "tracks"}`;
  $("#trash-content").innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">MOVE TO THE TRASH</div><h2>${whole ? `${escapeHtml(discs[0].name)}: the whole album` : `${noun} of ${escapeHtml(discs[0].name)}`}</h2></div><button class="close" data-close="trash-review" aria-label="Close">×</button></div>
    <div class="warn-box">These tracks leave your library, in Tagcast and in every iBroadcast app. iBroadcast keeps them in its trash; Tagcast can't take them back out.${whole ? " Without tracks, the album disappears too." : ""}</div>
    <section class="diff-group"><h3>${noun}</h3>${rows.map(({disc, track: t}) => `<p class="trash-row">${several ? `Disc ${disc.disc || "?"} · ` : ""}${t.track || "–"}. ${escapeHtml(t.title)} <span class="muted">· ${escapeHtml(t.artist)} · ${trackDuration(t.length)}</span></p>`).join("")}</section>
    <div class="dialog-footer"><span class="muted" id="trash-status"></span><button class="button" data-close="trash-review">Keep them</button><button class="button primary" id="trash-confirm">Move ${noun} to the trash</button></div>`;
  $("#trash-review").showModal();
}

async function moveToTrash() {
  const rows = chosenTracks();
  if (!rows.length || saving) return;
  const tracks = rows.map(({disc, track}) => ({id: String(track.id), album_id: String(disc.id), title: track.title}));
  const album = rows[0].disc, button = $("#trash-confirm");
  saving = true;  // one write at a time, like metadata saves
  button.disabled = true; button.textContent = "Moving…";
  $("#trash-status").innerHTML = '<span class="spinner"></span>Checking iBroadcast…';
  try {
    const result = await api("/api/trash", {tracks});
    const albumOf = new Map(tracks.map(t => [t.id, t.album_id]));
    const entry = {scope: "album", trash: true, selection: [{id: album.id, name: album.name, artist: album.artist}],
      created: new Date().toISOString(), status: "sent", source: "ibroadcast", error: "",
      changes: result.results.map(r => ({kind: "track", id: r.id, albumId: albumOf.get(String(r.id)), label: r.label, status: r.status,
        fields: {trash: {before: "In your library", after: "In the trash"}}}))};
    state.history.unshift(entry);
    pendingAlbums = null;
    dropTracks(tracks.map(t => t.id));
    albumView.trash = null;
    $("#trash-review").close(); render();
    toast(`${tracks.length} ${tracks.length === 1 ? "track" : "tracks"} moved to the trash. Checking the result with iBroadcast in the background…`);
    followJob(result.job, entry);
  } catch (error) {
    if (error.status === 401) { state.connection.connected = false; updateChrome(); }
    button.disabled = false; button.textContent = "Try again";
    $("#trash-status").innerHTML = `<span class="error-text">${escapeHtml(error.message)}</span>`;
    if (error.status === 409) { button.textContent = "Reload library"; button.onclick = () => { $("#trash-review").close(); loadLive(); }; }
  } finally { saving = false; }
}

document.addEventListener("click", event => {
  if (event.target.closest("[data-trash-start]")) { albumView.trash = new Set(); renderAlbumView(); return; }
  if (!albumView.trash) return;
  if (event.target.closest("[data-trash-cancel]")) { albumView.trash = null; renderAlbumView(); return; }
  if (event.target.closest("[data-trash-all]")) {
    const all = albumDiscs().flatMap(d => d.tracks.map(t => String(t.id)));
    albumView.trash = new Set(albumView.trash.size === all.length ? [] : all); renderAlbumView(); return;
  }
  if (event.target.closest("[data-trash-duplicates]")) { albumView.trash = new Set(extraCopies(albumDiscs())); renderAlbumView(); return; }
  if (event.target.closest("[data-trash-review]")) { showTrashReview(); return; }
  const go = event.target.closest("#trash-confirm");
  if (go && !go.onclick) moveToTrash();
});
document.addEventListener("change", event => {
  if (!albumView.trash || !event.target.matches?.("[data-trash-track]")) return;
  if (event.target.checked) albumView.trash.add(event.target.dataset.trashTrack);
  else albumView.trash.delete(event.target.dataset.trashTrack);
  renderAlbumView();
});
