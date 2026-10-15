"use strict";

// Moving tracks to iBroadcast's trash from the album page: choose tracks, review them,
// then send. iBroadcast keeps them in its trash; Tagcast can't take them back out.

const trashIcon = '<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';

function albumDiscs() {
  return shelfIds(albumView.id).map(id => state.details.get(id)).filter(Boolean);
}

function trashBar(discs) {
  const count = albumView.trash.size, all = discs.reduce((n, d) => n + d.tracks.length, 0);
  const suggestion = trashSuggestion(discs);
  return `<section class="trash-suggestion"><p><strong>Suggested copies</strong> · Prefer FLAC over MP3, then the newest upload in the same format. Different artists, clearly different durations, unknown formats or tied uploads may need a manual comparison. This compares metadata, not audio.</p>
    <p>${suggestion.remove.length ? `${suggestion.remove.length} ${suggestion.remove.length === 1 ? "copy suggested" : "copies suggested"} for the trash.` : "No clear preference between the repeated tracks."} Use a selection button or tick tracks, then review your choice before confirming.</p>
    ${uploadGroups(discs)}</section>
    <div class="selection-bar trash-bar"><strong>${count} of ${all} tracks selected for the trash</strong>${suggestion.remove.length ? '<button class="button small" data-trash-suggested>Select suggested copies</button>' : ""}${extraCopies(discs).length ? '<button class="button small" data-trash-duplicates title="Same track number and title; keeps the first copy regardless of format or upload date">Select extra copies</button>' : ""}<button class="button small" data-trash-all>${count === all ? "Select none" : "Select all"}</button><button class="button small" data-trash-cancel>Cancel</button><button class="button small primary" data-trash-review ${count ? "" : "disabled"}>Review →</button></div>`;
}

const trashCheck = t => `<input type="checkbox" class="trash-check" data-trash-track="${escapeHtml(t.id)}" aria-label="Select ${escapeHtml(t.title)} for the trash" ${albumView.trash.has(String(t.id)) ? "checked" : ""}>`;

function trashUploadedAt(track) {
  const value = String(track.uploaded_at || track.uploaded_on || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(value)) return "";
  const date = new Date(value.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) return "";
  if (value.length === 19 && (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59)) return value.slice(0, 10);
  return value;
}

function trashSuggestion(discs) {
  const choices = new Map(), remove = [];
  for (const disc of discs) {
    const groups = new Map();
    for (const track of disc.tracks) {
      const key = duplicateTrackPosition(track);
      if (key) { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(track); }
    }
    for (const tracks of groups.values()) {
      if (tracks.length < 2) continue;
      const manual = reason => tracks.forEach(t => choices.set(String(t.id), {choice: "manual", reason}));
      const artists = new Set(tracks.map(t => String(t.artist || "").trim().toLocaleLowerCase()).filter(Boolean));
      const lengths = tracks.map(t => Number(t.length)).filter(n => n > 0);
      const titles = new Set(tracks.map(t => titleKey(t.title)));
      if (artists.size > 1) { manual("Different track artists; compare manually."); continue; }
      if (lengths.length && Math.max(...lengths) - Math.min(...lengths) > 2) {
        manual("Durations differ by more than two seconds; compare versions."); continue;
      }
      if (titles.size > 1 && (lengths.length !== tracks.length || artists.size !== 1)) {
        manual("Different titles and incomplete comparison metadata."); continue;
      }
      const formats = new Set(tracks.map(t => t.format || ""));
      if (formats.has("") || formats.size > 1 && [...formats].some(f => !["FLAC", "MP3"].includes(f))) {
        manual("Unknown or incomparable file formats."); continue;
      }
      const flac = formats.has("FLAC") && formats.has("MP3");
      let keep = flac ? tracks.filter(t => t.format === "FLAC") : [...tracks];
      // A missing date or time cannot be treated as an older upload.
      if (keep.every(t => trashUploadedAt(t))) {
        const day = keep.map(t => trashUploadedAt(t).slice(0, 10)).sort().at(-1);
        keep = keep.filter(t => trashUploadedAt(t).slice(0, 10) === day);
        if (keep.every(t => trashUploadedAt(t).length === 19)) {
          const newest = keep.map(trashUploadedAt).sort().at(-1);
          keep = keep.filter(t => trashUploadedAt(t) === newest);
        }
      }
      const retained = new Set(keep.map(t => String(t.id)));
      for (const track of tracks) {
        const id = String(track.id), preferred = retained.has(id);
        let reason = preferred ? keep.length > 1 ? "No unique newest copy; compare these copies." : flac ? "Preferred FLAC copy." : "Newest upload in this format."
          : flac && track.format === "MP3" ? "FLAC copy available." : "Older upload in this format.";
        if (titles.size > 1) reason += " Titles differ; compare versions before confirming.";
        const choice = preferred ? keep.length > 1 ? "manual" : "keep" : "trash";
        choices.set(id, {choice, reason});
        if (!preferred) remove.push(id);
      }
    }
  }
  return {choices, remove};
}

function uploadGroups(discs) {
  const open = $("#album-page .trash-upload-groups")?.open;
  const rows = [];
  for (const disc of discs) {
    const groups = new Map();
    for (const track of disc.tracks) {
      const date = trashUploadedAt(track).slice(0, 10), format = track.format || "Unknown format";
      const key = JSON.stringify([track.album_id || disc.id, date, format]);
      if (!groups.has(key)) groups.set(key, {date, format, tracks: []});
      groups.get(key).tracks.push(track);
    }
    for (const group of [...groups.values()].sort((a, b) => b.date.localeCompare(a.date) || a.format.localeCompare(b.format))) {
      const positions = [...new Set(group.tracks.map(duplicateTrackNumber).filter(Boolean))].sort((a, b) => a - b);
      rows.push(`<tr>${discs.length > 1 ? `<td>${disc.disc || "?"}</td>` : ""}<td>${group.date || "Unknown date"}</td><td>${escapeHtml(group.format)}</td><td>${group.tracks.length}</td><td>${positions.join(", ") || "Unknown"}</td></tr>`);
    }
  }
  return `<details class="trash-upload-groups"${open ? " open" : ""}><summary>Upload dates and formats</summary><p class="muted">Grouped by stored upload date and file format, per disc. Uploads on the same day can share a row.</p><table><thead><tr>${discs.length > 1 ? "<th>Disc</th>" : ""}<th>Uploaded</th><th>Format</th><th>Tracks</th><th>Track numbers</th></tr></thead><tbody>${rows.join("")}</tbody></table></details>`;
}

function trashTrackNote(track, suggestion) {
  const stamp = trashUploadedAt(track), result = suggestion.choices.get(String(track.id));
  const label = {keep: "Suggested keep", trash: "Suggested trash", manual: "Compare manually"};
  return `<small class="trash-track-info">Uploaded ${escapeHtml(stamp.replace("T", " ") || "date unknown")}${result ? ` · <span class="pill${result.choice === "keep" ? "" : " missing"}">${label[result.choice]}</span> ${escapeHtml(result.reason)}` : ""}</small>`;
}

// Every matching numbered title after the first one on its disc; review before sending.
function extraCopies(discs) {
  const ids = [];
  for (const d of discs) {
    const seen = new Set();
    for (const t of d.tracks) {
      const key = duplicateTrackKey(t);
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
    <section class="diff-group"><h3>${noun}</h3>${rows.map(({disc, track: t}) => `<p class="trash-row">${several ? `Disc ${disc.disc || "?"} · ` : ""}${t.track || "–"}. ${escapeHtml(t.title)} <span class="muted">· ${escapeHtml(t.artist)} · ${trackDuration(t.length)}${t.format ? ` · ${escapeHtml(t.format)}` : ""} · Uploaded ${escapeHtml(trashUploadedAt(t).replace("T", " ") || "date unknown")}</span></p>`).join("")}</section>
    <div class="dialog-footer"><span class="muted" id="trash-status"></span><button class="button" data-close="trash-review">Keep them</button><button class="button danger primary" id="trash-confirm">${trashIcon}Move ${noun} to the trash</button></div>`;
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
  if (event.target.closest("[data-trash-suggested]")) {
    albumView.trash = new Set(trashSuggestion(albumDiscs()).remove); renderAlbumView();
    $("[data-trash-suggested]")?.focus(); return;
  }
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
