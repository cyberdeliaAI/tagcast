"use strict";

// Album-local sidecars reuse individual, single-use lyrics reviews and saves.
let albumLyricsImport = null;

function lyricsImportTitle(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase().replace(/[‘’'“”"]/g, "")
    .replace(/[\s._–—-]+/g, " ").trim();
}

function lyricsImportFilename(name) {
  const stem = String(name).replace(/\.(lrc|txt)$/i, "");
  const disc = stem.match(/^(?:(?:cd|disc)\s*(\d{1,2})[\s._-]+|(\d{1,2})[-_])(?:(\d{2,3}))[\s._-]+(.+)$/i);
  if (disc) return {disc: Number(disc[1] || disc[2]), track: Number(disc[3]), title: lyricsImportTitle(disc[4])};
  const track = stem.match(/^\s*(\d{1,3})[\s._–—-]+(.+)$/);
  return {disc: null, track: track ? Number(track[1]) : 0, title: lyricsImportTitle(track ? track[2] : stem)};
}

function lyricsImportText(value) {
  if (typeof value !== "string" || value.includes("\0")) throw Error("Invalid lyrics text.");
  const text = value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
    .replace(/^\s*\[(?:ar|al|ti|au|by|offset|length|re|ve):[^\]\n]*\]\s*$/gim, "")
    .replace(/^(?:\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+[ \t]*/gm, "")
    .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, "").trim();
  if (!text || text.length > 50000) throw Error("Choose nonempty lyrics of at most 50,000 characters.");
  return text;
}

function lyricsImportDecode(buffer) {
  const bytes = new Uint8Array(buffer);
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? "utf-16le"
    : bytes[0] === 254 && bytes[1] === 255 ? "utf-16be" : "utf-8";
  return new TextDecoder(encoding, {fatal: true}).decode(bytes);
}

function lyricsImportScope() {
  return {combine_sets: Boolean(state.connection.combine_sets), albums: shelfIds(albumView.id).map(id => {
    const album = state.details.get(id);
    return {id: String(id), name: album.name, artist: album.artist,
      tracks: album.tracks.map(t => ({id: String(t.id), title: t.title, artist: t.artist, track: t.track}))
        .sort((a, b) => Number(a.id) - Number(b.id))};
  })};
}

function lyricsImportCurrent(job) {
  return albumLyricsImport === job && job.details === state.details && job.session === state.connection.playback_session
    && live() && !state.loading && state.screen === "album" && job.album === albumView.id
    && job.request === albumView.request && state.connection.premium !== false;
}

function resetAlbumLyricsImport() {
  if (albumLyricsImport) albumLyricsImport.stop = true;
  albumLyricsImport = null;
  $("#lyrics-import-status").classList.remove("operation-status"); $("#lyrics-import-status").dataset.working = "false";
  $("#lyrics-import").close(); $("#lyrics-import-content").innerHTML = "";
}

function closeAlbumLyricsImport() {
  const job = albumLyricsImport;
  if (job?.busy) { job.stop = true; $("#lyrics-import-status").textContent = "Stopping after the current request. Accepted saves still finish their check."; return; }
  if (job?.files.length && job.stage !== "done" && !confirm("Discard this unsaved lyrics import?")) return;
  const focus = job?.focus;
  resetAlbumLyricsImport();
  if (focus?.isConnected) focus.focus({preventScroll: true});
}

function openAlbumLyricsImport() {
  if (!live() || state.loading || state.connection.premium === false || trackLyrics.busy
      || saving || checking || document.querySelector("dialog[open]") || albumView.trash) return;
  const tracks = shelfIds(albumView.id).flatMap(id => {
    const disc = state.details.get(id);
    return disc.tracks.map(track => ({...track, id: String(track.id), disc: disc.disc || 0}));
  });
  if (!tracks.length || tracks.length > 100 || new Set(tracks.map(t => t.id)).size !== tracks.length) {
    toast("Import lyrics for an album of up to 100 distinct tracks."); return;
  }
  if (trackLyrics.details !== state.details) { resetTrackLyrics(); trackLyrics.details = state.details; }
  cancelAlbumLyricsCheck(); renderAlbumLyricsCheck();
  albumLyricsImport = {details: state.details, session: state.connection.playback_session, album: albumView.id,
    request: albumView.request, scope: lyricsImportScope(), tracks, files: [], pairs: new Map(), manual: new Set(),
    stage: "match", rows: [], busy: false, stop: false, selectedTrack: tracks[0].id, selectedFile: null,
    focus: document.activeElement, fileRead: 0, nextFile: 0};
  $("#lyrics-import-title").textContent = `Import lyrics · ${state.details.get(shelfIds(albumView.id)[0]).name}`;
  $("#lyrics-import-status").textContent = "Choose or drop LRC/TXT files. Nothing is saved until you review and confirm.";
  renderAlbumLyricsImport(); $("#lyrics-import").showModal(); $("#lyrics-import-pick").focus();
}

function autoMatchAlbumLyrics(job) {
  for (const id of job.pairs.keys()) if (!job.manual.has(id)) job.pairs.delete(id);
  const used = new Set(job.pairs.values());
  const candidates = job.files.filter(f => f.text && !used.has(f.id)).map(file => ({file,
    tracks: job.tracks.filter(t => !job.manual.has(t.id) && file.match.track > 0
      && t.track === file.match.track && lyricsImportTitle(t.title) === file.match.title
      && (file.match.disc === null || t.disc === file.match.disc))}));
  for (const item of candidates) {
    if (item.tracks.length !== 1) continue;
    const id = item.tracks[0].id;
    if (candidates.filter(c => c.tracks.some(t => t.id === id)).length === 1) job.pairs.set(id, item.file.id);
  }
}

async function addAlbumLyricsFiles(files) {
  const job = albumLyricsImport;
  if (!job || !lyricsImportCurrent(job) || job.busy || job.stage !== "match") return;
  const selected = [...files];
  if (!selected.length) return;
  if (job.files.length + selected.length > 100
      || selected.reduce((sum, file) => sum + file.size, job.files.reduce((sum, f) => sum + f.size, 0)) > 5 * 1024 * 1024) {
    toast("Choose up to 100 lyrics files, at most 5 MB in total."); return;
  }
  $("#lyrics-import-status").textContent = "Reading local lyrics files…";
  job.busy = true; const request = ++job.fileRead; renderAlbumLyricsImport();
  for (const file of selected) {
    if (!lyricsImportCurrent(job) || request !== job.fileRead || job.stop) break;
    const item = {id: String(job.nextFile++), name: file.name, size: file.size, text: "", error: "", match: lyricsImportFilename(file.name)};
    try {
      if (!/\.(lrc|txt)$/i.test(file.name) || file.name.length > 255 || file.size > 512000) throw Error("Choose an LRC/TXT file of at most 500 KB.");
      item.text = lyricsImportText(lyricsImportDecode(await file.arrayBuffer()));
    } catch (error) { item.error = error.message; }
    if (!lyricsImportCurrent(job) || request !== job.fileRead) return;
    job.files.push(item);
  }
  job.busy = false;
  if (!lyricsImportCurrent(job)) return;
  job.stop = false; autoMatchAlbumLyrics(job);
  $("#lyrics-import-status").textContent = `${job.pairs.size} linked. Check the links, then review existing and imported text.`;
  renderAlbumLyricsImport();
}

function renderAlbumLyricsImport() {
  const job = albumLyricsImport;
  if (!job || !lyricsImportCurrent(job)) return;
  const scrolls = [...$("#lyrics-import-content").querySelectorAll(".lyrics-import-list")].map(list => list.scrollTop);
  const busy = job.busy, matched = job.pairs.size;
  $("#lyrics-import-status").classList.toggle("operation-status", busy);
  $("#lyrics-import-status").dataset.working = String(busy);
  const fileFor = id => job.files.find(f => f.id === job.pairs.get(id));
  if (job.stage === "match") {
    const chosen = job.files.find(f => f.id === job.selectedFile);
    $("#lyrics-import-content").innerHTML = `<p>Match files to this album. Automatic links require a unique track number and title. You can link other files manually.</p>
      <div class="lyrics-import-columns"><section aria-label="Album tracks"><h3>Album tracks</h3><div class="lyrics-import-list">${job.tracks.map(t => `<div class="lyrics-import-row"><button type="button" class="button lyrics-import-choice" data-lyrics-import-track="${escapeHtml(t.id)}" aria-pressed="${job.selectedTrack === t.id}" ${busy ? "disabled" : ""}><strong>${t.disc ? `Disc ${t.disc} · ` : ""}${t.track || "–"} · ${escapeHtml(t.title)}</strong><small>${escapeHtml(t.artist)}</small><small>${escapeHtml(fileFor(t.id)?.name || "Not linked")}</small></button>${job.pairs.has(t.id) ? `<button type="button" class="text-action" data-lyrics-import-unlink="${escapeHtml(t.id)}" aria-label="Unlink lyrics for ${escapeHtml(t.title)}" ${busy ? "disabled" : ""}>Unlink</button>` : ""}</div>`).join("")}</div></section>
      <section aria-label="Imported lyrics files"><h3>LRC / TXT files</h3><button type="button" class="button" id="lyrics-import-pick" ${busy ? "disabled" : ""}>Choose files…</button><input id="lyrics-import-files" type="file" accept=".lrc,.txt" multiple hidden><p class="muted">Drop files anywhere in this dialog. Up to 100 files / 5 MB.</p><div class="lyrics-import-list">${job.files.map(f => {
        const track = job.tracks.find(t => job.pairs.get(t.id) === f.id);
        return `<div class="lyrics-import-row"><button type="button" class="button lyrics-import-choice" data-lyrics-import-file="${f.id}" aria-pressed="${job.selectedFile === f.id}" ${busy || f.error ? "disabled" : ""}><strong>${escapeHtml(f.name)}</strong><small>${escapeHtml(f.error || (track ? `Linked: ${track.track || "–"} · ${track.title}` : "Not linked · choose a track and link manually"))}</small></button><button type="button" class="text-action" data-lyrics-import-remove="${f.id}" aria-label="Remove ${escapeHtml(f.name)} from import" ${busy ? "disabled" : ""}>Remove</button></div>`;
      }).join("") || '<p class="muted">No files selected.</p>'}</div></section></div>
      <div class="lyrics-actions"><button type="button" class="button" id="lyrics-import-link" ${busy || !chosen?.text || !job.selectedTrack ? "disabled" : ""}>Link selected track and file</button><span>${matched} linked · ${job.tracks.length - matched} tracks without an import</span></div>
      <label class="field"><span>Selected file preview · ordinary lyrics text</span><textarea readonly rows="5">${escapeHtml(chosen?.text || "Choose a file on the right to preview its lyrics.")}</textarea></label><p class="muted">LRC timing markers are removed. Original files stay unchanged. Existing lyrics are checked during review.</p>`;
  } else {
    $("#lyrics-import-content").innerHTML = `<p>${job.stage === "done" ? "Import results" : "Check the complete Before and After text. Existing lyrics are kept unless you explicitly choose replacement."}</p>${job.rows.map((row, index) => `<section class="lyrics-import-review"><h3>${row.track.track || "–"} · ${escapeHtml(row.track.title)}</h3><p>${escapeHtml(row.file.name)} · <strong data-lyrics-import-result="${index}">${escapeHtml(row.status)}</strong></p>${row.before?.trim() && row.before !== row.after && job.stage === "review" ? `<label class="checkline"><input type="checkbox" data-lyrics-import-replace="${index}" ${row.replace ? "checked" : ""} ${busy ? "disabled" : ""}> Replace existing lyrics for this track</label>` : ""}<details><summary>Before / After</summary><div class="lyrics-import-columns"><div><h4>Before</h4><pre class="lyrics-text">${escapeHtml(row.before || "No lyrics")}</pre></div><div><h4>After · imported text</h4><pre class="lyrics-text">${escapeHtml(row.after)}</pre></div></div></details>${row.error ? `<p class="error-text">${escapeHtml(row.error)}</p>` : ""}</section>`).join("")}`;
  }
  [...$("#lyrics-import-content").querySelectorAll(".lyrics-import-list")].forEach((list, i) => { list.scrollTop = scrolls[i] || 0; });
  $("#lyrics-import-back").hidden = !["review", "done"].includes(job.stage);
  $("#lyrics-import-back").disabled = busy;
  $("#lyrics-import-review").hidden = job.stage !== "match";
  $("#lyrics-import-review").disabled = busy || !matched;
  $("#lyrics-import-save").hidden = job.stage !== "review";
  $("#lyrics-import-save").disabled = busy || !job.rows.some(r => r.status === "Ready" || r.status === "Replace existing lyrics");
  $("#lyrics-import-stop").hidden = !busy;
  $("#lyrics-import-close").textContent = busy ? "Stop after current request" : "Close";
}

async function reviewAlbumLyricsImport() {
  const job = albumLyricsImport;
  if (!job || job.busy || !lyricsImportCurrent(job) || !job.pairs.size || job.stage !== "match") return;
  job.rows = []; job.busy = true; job.stop = false; renderAlbumLyricsImport();
  try {
    for (const track of job.tracks) {
      if (!lyricsImportCurrent(job) || job.stop) return;
      const file = job.files.find(f => f.id === job.pairs.get(track.id));
      if (!file) continue;
      $("#lyrics-import-status").textContent = `Checking existing lyrics… ${job.rows.length + 1} of ${job.pairs.size}`;
      const data = await api(`/api/lyrics?${new URLSearchParams({...lyricsSelection(track), refresh: "1"})}`);
      if (!lyricsImportCurrent(job) || job.stop) return;
      if (!data.can_save || typeof data.before_token !== "string") throw Error("Saving imported lyrics requires an active Premium account. Nothing was saved.");
      const before = data.native_text;
      if (typeof before !== "string") throw Error("Existing lyrics could not be checked. Nothing was saved.");
      job.rows.push({track, file, before, after: file.text, beforeToken: data.before_token, replace: false,
        status: before === file.text ? "Unchanged" : before.trim() ? "Keep existing lyrics" : "Ready"});
    }
    if (!lyricsImportCurrent(job) || job.stop) return;
    job.stage = "review";
    $("#lyrics-import-status").textContent = "Review ready. Nothing has been saved. Tracks without a linked file stay unchanged.";
  } catch (error) { if (lyricsImportCurrent(job)) $("#lyrics-import-status").textContent = error.message; }
  finally {
    job.busy = false;
    if (lyricsImportCurrent(job)) {
      if (job.stop) $("#lyrics-import-status").textContent = "Review stopped. Nothing was saved.";
      job.stop = false; renderAlbumLyricsImport();
    }
  }
}

async function saveAlbumLyricsImport() {
  const job = albumLyricsImport;
  if (!job || job.busy || trackLyrics.busy || saving || checking || job.stage !== "review" || !lyricsImportCurrent(job)) return;
  const rows = job.rows.filter(r => r.status === "Ready" || r.status === "Replace existing lyrics");
  if (!rows.length) return;
  job.busy = true; job.stop = false; trackLyrics.busy = true;
  job.stage = "saving"; for (const row of rows) row.status = "Not sent";
  renderAlbumLyricsImport();
  const status = $("#lyrics-import-status");
  status.classList.add("operation-status"); status.dataset.working = "true";
  try {
    for (const row of rows) {
      if (!lyricsImportCurrent(job) || job.stop) break;
      let sending = false;
      try {
        row.status = "Checking before save"; status.textContent = `Checking ${row.track.title} before saving…`;
        renderAlbumLyricsImport();
        const prepared = await api("/api/lyrics/review", {...lyricsSelection(row.track), album_scope: job.scope,
          before_token: row.beforeToken, lyrics: row.after, replace_existing: row.replace});
        if (!lyricsImportCurrent(job) || job.stop) { row.status = "Not sent"; break; }
        if (prepared.before !== row.before || prepared.after !== row.after) throw Error("The prepared text differs from your review. Check the lyrics again.");
        row.status = "Saving / checking"; status.textContent = `Saving ${row.track.title} and checking iBroadcast…`;
        renderAlbumLyricsImport(); sending = true;
        const entry = lyricsEntry(lyricsSelection(row.track));
        entry.data = null; entry.error = ""; refreshAlbumLyricsLabels();
        const result = await api("/api/lyrics/save", {id: prepared.id, approved: true});
        if (result.status !== "saved") throw Error("The save could not be confirmed. Check iBroadcast before trying again.");
        row.status = "Saved and confirmed"; row.error = result.cache_error || "";
        if (lyricsImportCurrent(job)) {
          entry.draft = null; entry.data = {source: "ibroadcast", status: "ready", text: row.after,
            native_text: row.after, persisted: true, can_save: true, can_lookup: false};
          refreshAlbumLyricsLabels();
        }
      } catch (error) {
        row.status = sending ? "Unconfirmed · check iBroadcast" : "Blocked · not sent";
        row.error = error.message; job.stop = true;
      }
      if (!lyricsImportCurrent(job) || job.stop) break;
    }
  } finally {
    job.busy = false; trackLyrics.busy = false; job.stage = "done";
    status.classList.remove("operation-status"); status.dataset.working = "false";
    if (lyricsImportCurrent(job)) {
      status.textContent = `${job.rows.filter(r => r.status === "Saved and confirmed").length} saved and confirmed. ${job.stop ? "Stopped; remaining changes were not sent." : "Finished."} No request will be retried automatically.`;
      renderAlbumLyricsImport();
    }
  }
}

document.addEventListener("click", event => {
  const target = event.target;
  if (target.closest("#lyrics-import-close")) { closeAlbumLyricsImport(); return; }
  const job = albumLyricsImport;
  if (!job || job.busy || !lyricsImportCurrent(job)) {
    if (job && target.closest("#lyrics-import-stop")) job.stop = true;
    return;
  }
  if (target.closest("#lyrics-import-review")) return reviewAlbumLyricsImport();
  if (target.closest("#lyrics-import-save")) return saveAlbumLyricsImport();
  if (target.closest("#lyrics-import-back")) { job.stage = "match"; job.rows = []; $("#lyrics-import-status").textContent = "Adjust the links, then review the current lyrics again."; renderAlbumLyricsImport(); return; }
  if (target.closest("#lyrics-import-pick")) { $("#lyrics-import-files").click(); return; }
  const track = target.closest("[data-lyrics-import-track]"), file = target.closest("[data-lyrics-import-file]");
  const unlink = target.closest("[data-lyrics-import-unlink]");
  const remove = target.closest("[data-lyrics-import-remove]");
  if (remove && job.stage === "match") {
    const id = remove.dataset.lyricsImportRemove;
    job.files = job.files.filter(f => f.id !== id);
    for (const [trackId, fileId] of job.pairs) if (fileId === id) job.pairs.delete(trackId);
    if (job.selectedFile === id) job.selectedFile = null;
    autoMatchAlbumLyrics(job); renderAlbumLyricsImport(); return;
  }
  if (track) { job.selectedTrack = track.dataset.lyricsImportTrack; job.selectedFile = job.pairs.get(job.selectedTrack) ?? job.selectedFile; }
  if (file) job.selectedFile = file.dataset.lyricsImportFile;
  if (unlink) { job.pairs.delete(unlink.dataset.lyricsImportUnlink); job.manual.add(unlink.dataset.lyricsImportUnlink); }
  if (target.closest("#lyrics-import-link") && job.selectedTrack && job.selectedFile !== null) {
    for (const [id, selected] of job.pairs) if (selected === job.selectedFile) { job.pairs.delete(id); job.manual.add(id); }
    job.pairs.set(job.selectedTrack, job.selectedFile); job.manual.add(job.selectedTrack);
  }
  if (track || file || unlink || target.closest("#lyrics-import-link")) {
    renderAlbumLyricsImport();
    const selector = track ? `[data-lyrics-import-track="${job.selectedTrack}"]` : file ? `[data-lyrics-import-file="${job.selectedFile}"]` : "#lyrics-import-link";
    $("#lyrics-import-content").querySelector(selector)?.focus({preventScroll: true});
  }
});
document.addEventListener("change", event => {
  const job = albumLyricsImport;
  if (!job || job.busy || !lyricsImportCurrent(job)) return;
  if (event.target.id === "lyrics-import-files") { addAlbumLyricsFiles(event.target.files); return; }
  const index = event.target.dataset?.lyricsImportReplace;
  if (index === undefined || job.stage !== "review" || !job.rows[Number(index)]) return;
  const row = job.rows[Number(index)]; row.replace = event.target.checked;
  row.status = row.replace ? "Replace existing lyrics" : "Keep existing lyrics";
  $("#lyrics-import-content").querySelector(`[data-lyrics-import-result="${index}"]`).textContent = row.status;
  $("#lyrics-import-save").disabled = !job.rows.some(r => r.status === "Ready" || r.status === "Replace existing lyrics");
});
for (const name of ["dragover", "drop"]) $("#lyrics-import").addEventListener(name, event => {
  event.preventDefault();
  if (name === "drop") addAlbumLyricsFiles(event.dataTransfer.files);
});
$("#lyrics-import").addEventListener("cancel", event => { event.preventDefault(); closeAlbumLyricsImport(); });
$("#lyrics-import").addEventListener("close", () => {
  if (albumLyricsImport) { albumLyricsImport.stop = true; albumLyricsImport = null; }
  $("#lyrics-import-content").innerHTML = "";
});
window.addEventListener("beforeunload", event => {
  if (albumLyricsImport?.files.length && albumLyricsImport.stage !== "done") {
    event.preventDefault(); event.returnValue = "";
  }
});
