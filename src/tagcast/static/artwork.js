"use strict";

// Album covers and artist images: pick a suggestion, an image iBroadcast already has,
// or your own file or address; compare old and new, then save. History can undo it.

const art = {target: null, options: [], choice: null, saved: [], artworkId: 0};  // saved: discs done
const MAX_IMAGE = 15 * 1024 * 1024;

function albumArtTarget() {
  const album = editing?.originals[0];
  if (!album) return null;
  const one = (a, label = a.name) => ({target: "album", id: String(a.id), label, current: a.artwork, artist: a.artist,
    album: a.name, tracks: a.tracks.length,
    before: {tracks: Object.fromEntries(a.tracks.map(t => [String(t.id), t.artwork_id || 0]))}});
  if (!editing.set) return one(album);
  // A set gets one cover: saved disc by disc, each disc with its own History entry and Undo.
  const discs = editing.originals.map(a => one(a, `${a.name} · Disc ${a.disc || "?"}`));
  return {...one(album), current: joinDiscs(editing.originals).artwork, tracks: discs.reduce((n, d) => n + d.tracks, 0), discs};
}

function artistArtTarget() {
  const album = editing?.originals[0];
  if (!album?.artist_id) return null;
  return {target: "artist", id: String(album.artist_id), label: album.artist, current: (album.artist_image || "").replace(/-150$/, "-300"),
    artist: album.artist, before: {artwork_id: album.artist_artwork_id || 0}};
}

function artistPageTarget(name, id = null) {
  let artist;
  for (const album of state.albums) {
    artist = albumArtistEntries(album).find(a => a.name === name && Number(a.id) > 0 && (id === null || String(a.id) === id));
    if (artist) break;
  }
  if (!artist) return null;
  return {target: "artist", id: String(artist.id), label: name, current: (artist.image || "").replace(/-150$/, "-300"),
    artist: name, before: {artwork_id: artist.artwork_id || 0}};
}

function openArtwork(target, preselect) {
  if (!target) return;
  if (!live()) { toast(TagcastI18n.text("artwork.connect")); return; }
  art.target = target; art.options = []; art.choice = null; art.saved = []; art.artworkId = 0;
  art.submitted = false;
  const isAlbum = target.target === "album", isPlaylist = target.target === "playlist";
  const eyebrow = TagcastI18n.html(isPlaylist ? "artwork.eyebrow.playlist" : isAlbum ? "artwork.eyebrow.album" : "artwork.eyebrow.artist");
  const scope = isPlaylist ? TagcastI18n.html("artwork.scope.playlist") : !isAlbum ? TagcastI18n.html("artwork.scope.artist")
    : target.discs ? TagcastI18n.html("artwork.scope.discs", {tracks: target.tracks, discs: target.discs.length}) : TagcastI18n.html("artwork.scope.album", {count: target.tracks});
  const choose = TagcastI18n.trusted(`<u>${TagcastI18n.html("artwork.own.chooseFile")}</u>`);
  $("#artwork-content").innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">${eyebrow}</div><h2>${escapeHtml(target.label)}</h2></div><div class="dialog-heading-actions">${isPlaylist ? `<button type="button" class="button small help-trigger" data-help-context="playlist-cover" aria-label="${TagcastI18n.html("artwork.help.playlist")}">?</button>` : ""}<button type="button" class="close" data-close="artwork" aria-label="${TagcastI18n.html("common.close")}">×</button></div></div>
    <div class="art-compare"><figure><figcaption>${TagcastI18n.html("artwork.compare.now")}</figcaption>${target.current ? `<img src="${escapeHtml(target.current)}" alt="${TagcastI18n.html("artwork.compare.currentAlt")}" referrerpolicy="no-referrer" data-image-error="current">` : `<div class="art-empty">${TagcastI18n.html("artwork.noImage")}</div>`}</figure><span class="art-arrow" aria-hidden="true">→</span><figure><figcaption>${TagcastI18n.html("artwork.compare.new")}</figcaption><div id="art-new"><div class="art-empty">${TagcastI18n.html("artwork.compare.choose")}</div></div><small id="art-size"></small></figure></div>
    ${isPlaylist ? "" : `<h3 class="art-heading">${TagcastI18n.html("artwork.suggestions.heading")}</h3>
    <div id="art-suggestions" class="art-grid"><p class="muted"><span class="spinner"></span>${TagcastI18n.html("artwork.suggestions.searching")}</p></div>
    <h3 class="art-heading">${TagcastI18n.html("artwork.related.heading")}</h3><div id="art-related" class="art-grid"><p class="muted"><span class="spinner"></span>${TagcastI18n.html("common.loading")}</p></div>
    `}<h3 class="art-heading">${TagcastI18n.html("artwork.own.heading")}</h3>
    <div class="art-own"><label class="art-drop" id="art-drop"><input type="file" id="art-file" accept="image/jpeg,image/png,image/webp,image/gif"> ${TagcastI18n.html("artwork.own.drop", {choose})}</label>
    <form id="art-url-form" class="connect-row"><input id="art-url" type="url" placeholder="${TagcastI18n.html("artwork.own.urlPlaceholder")}" aria-label="${TagcastI18n.html("artwork.own.urlLabel")}"><button class="button">${TagcastI18n.html("artwork.own.use")}</button></form></div>
    <div class="dialog-footer"><span class="muted" id="art-status">${scope}</span><button class="button" data-close="artwork">${TagcastI18n.html("common.cancel")}</button><button class="button primary" id="art-save" disabled>${TagcastI18n.html("artwork.save")}</button></div>`;
  $("#artwork").showModal();
  if (preselect) choose(addOption(preselect));
  if (!isPlaylist) { loadSuggestions(target); loadRelated(target); }
}

function addOption(option) {
  const existing = art.options.findIndex(o => (o.url && o.url === option.url) || (o.artwork_id && o.artwork_id === option.artwork_id));
  if (existing >= 0) return existing;
  art.options.push(option);
  return art.options.length - 1;
}

// An option's source is stored with its History entry in English ("Your file"); its
// sourceKey, when present, shows that source in the interface language.
const artSource = o => o.sourceKey ? TagcastI18n.text(o.sourceKey) : o.source;

function tile(index) {
  const o = art.options[index];
  return `<button class="art-tile ${art.choice === index ? "chosen" : ""}" data-art-choice="${index}" title="${escapeHtml(o.title || artSource(o))}"><img src="${escapeHtml(o.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-image-error="tile"><span>${escapeHtml(artSource(o))}</span></button>`;
}

function loadSuggestions(target) {
  const box = $("#art-suggestions");
  if (target.target === "playlist") { box.innerHTML = `<p class="muted">${TagcastI18n.html("artwork.suggestions.playlist")}</p>`; return; }
  const indexes = [];
  const show = () => { box.innerHTML = indexes.length ? indexes.map(tile).join("") : `<p class="muted">${TagcastI18n.html("artwork.suggestions.none")}</p>`; };
  if (target.target === "album" && coverChoices().length) {
    for (const option of coverChoices()) indexes.push(addOption(option));
    show(); return;
  }
  const kind = target.target === "album" ? "album" : "artist";
  const params = kind === "album" ? {artist: target.artist, album: target.album} : {name: target.artist};
  let waiting = fetchSuggestions(kind, params, (source, candidates) => {
    for (const c of candidates || []) {
      const url = kind === "album" ? c.cover : c.image;
      if (url && c.score >= 0.75) indexes.push(addOption({url, thumb: c.thumb || url, source: source.label, title: c.title || c.name}));
    }
    waiting -= 1;
    if (indexes.length || !waiting) show();
  }, "artwork").length;
  if (!waiting) box.innerHTML = `<p class="muted">${TagcastI18n.html("artwork.suggestions.noSources")}</p>`;
}

async function loadRelated(target) {
  const box = $("#art-related");
  if (target.target === "playlist") { box.innerHTML = `<p class="muted">${TagcastI18n.html("artwork.related.playlist")}</p>`; return; }
  try {
    const data = await api(`/api/artwork/related?${new URLSearchParams(target.target === "album" ? {album_id: target.id} : {artist_id: target.id})}`);
    const indexes = data.artwork.map(a => addOption({artwork_id: a.artwork_id, url: a.image, thumb: a.thumb, source: "iBroadcast"}));
    box.innerHTML = indexes.length ? indexes.map(tile).join("") : `<p class="muted">${TagcastI18n.html("artwork.related.none")}</p>`;
  } catch (error) { box.innerHTML = `<p class="muted">${escapeHtml(TagcastI18n.errorText(error))}</p>`; }
}

function choose(index) {
  art.choice = index;
  const o = art.options[index];
  for (const el of document.querySelectorAll(".art-tile")) el.classList.toggle("chosen", Number(el.dataset.artChoice) === index);
  $("#art-new").innerHTML = `<img src="${escapeHtml(o.data || o.url)}" alt="${TagcastI18n.html("artwork.compare.newAlt")}" referrerpolicy="no-referrer">`;
  $("#art-size").textContent = TagcastI18n.text("common.loading");
  const img = $("#art-new img");
  img.onload = () => {
    const w = img.naturalWidth, h = img.naturalHeight, notes = [];
    if (Math.min(w, h) < 500) notes.push(TagcastI18n.text("artwork.size.small"));
    if (Math.abs(w - h) > Math.max(w, h) * 0.03) notes.push(TagcastI18n.text("artwork.size.notSquare"));
    $("#art-size").textContent = [artSource(o), `${w} × ${h}`, notes.join(", ")].filter(Boolean).join(" · ");
  };
  img.onerror = () => { $("#art-size").textContent = TagcastI18n.text("artwork.size.failed"); $("#art-save").disabled = true; };
  $("#art-save").disabled = false;
}

function readFile(file) {
  if (!file) return;
  if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) { toast(TagcastI18n.text("artwork.file.type")); return; }
  if (file.size > MAX_IMAGE) { toast(TagcastI18n.text("artwork.file.size")); return; }
  const reader = new FileReader();
  reader.onload = () => choose(addOption({data: reader.result, name: file.name, thumb: reader.result, source: "Your file", sourceKey: "artwork.source.file", title: file.name}));
  reader.readAsDataURL(file);
}

async function saveArtwork() {
  const t = art.target, o = art.options[art.choice];
  if (!t || !o) return;
  if (t.target === "playlist") return savePlaylistCover(t, o);
  const save = $("#art-save"), status = $("#art-status"), discs = t.discs || [t];
  save.disabled = true; save.textContent = TagcastI18n.text("review.saving");
  try {
    for (const d of discs.filter(d => !art.saved.includes(d.id))) {
      setActionStatus("#art-status", discs.length > 1 ? TagcastI18n.text("artwork.status.savingDisc", {disc: art.saved.length + 1, count: discs.length}) : TagcastI18n.text("review.status.checkingAndSaving"), true);
      // After the first disc, the others reuse the image that is now in iBroadcast.
      const source = art.artworkId ? {artwork_id: art.artworkId} : o.artwork_id ? {artwork_id: o.artwork_id} : o.data ? {data: o.data, name: o.name} : {url: o.url};
      const result = await api("/api/artwork", {target: d.target, id: d.id, label: d.label, before: d.before, source});
      art.saved.push(d.id); art.artworkId = result.artwork_id;
      const entry = artworkEntry(d, result, o.source, d.current);
      state.history.unshift(entry);
      pendingAlbums = null;
      showNewArt(d, result);
      followJob(result.job, entry);
    }
    $("#artwork").close(); render();
    // Only album covers are saved per disc; artist images have one target.
    toast(TagcastI18n.text(t.target !== "album" ? "artwork.saved.image" : discs.length > 1 ? "artwork.saved.coverDiscs" : "artwork.saved.cover", {count: discs.length}));
  } catch (error) {
    if (art.saved.length) render();
    save.disabled = false; save.textContent = TagcastI18n.text(art.saved.length ? "artwork.saveOtherDiscs" : "common.tryAgain");
    const part = art.saved.length ? TagcastI18n.text("artwork.error.partial", {saved: art.saved.length, count: discs.length}) : "";
    $("#art-status").innerHTML = `<span class="error-text">${escapeHtml([part, TagcastI18n.errorText(error)].filter(Boolean).join(" "))}</span>`;
    if (error.status === 409) { save.textContent = TagcastI18n.text("common.reloadLibrary"); save.onclick = () => { $("#artwork").close(); $("#editor").close(); loadLive(); }; }
  } finally { if ($("#art-status") === status) setActionStatus("#art-status", undefined); }
}

function artworkEntry(t, result, from, beforeImage) {
  const field = t.target === "album" ? "cover" : "image";
  return {scope: t.target, selection: [{id: t.id, name: t.label, artist: t.artist}], created: new Date().toISOString(),
    status: "sent", source: "ibroadcast", error: "",
    changes: result.results.map(r => ({...r, albumId: t.id, fields: {[field]: {before: beforeImage ? "previous image" : "", after: `image from ${from}`}}})),
    artwork: {target: t.target, id: t.id, label: t.label, artist: t.artist, previous: result.previous, artwork_id: result.artwork_id, before: beforeImage, after: result.image}};
}

// Show the new image right away; the read-back replaces the album list afterwards.
function showNewArt(t, result) {
  if (t.target === "album") {
    state.albums = state.albums.map(a => String(a.id) === t.id ? {...a, artwork: result.image} : a);
    const album = state.details.get(t.id);
    if (album) { album.artwork = result.image; album.artwork_id = result.artwork_id; for (const track of album.tracks) track.artwork_id = result.artwork_id; }
    const original = editing?.originals.find(a => String(a.id) === t.id);
    if (original) { original.artwork = result.image; for (const track of original.tracks) track.artwork_id = result.artwork_id; }
    if (editing?.ids[0] === t.id) {
      const img = document.querySelector("#change-cover img");
      if (img) img.src = result.image; else document.querySelector("#change-cover .cover")?.insertAdjacentHTML("afterbegin", `<img src="${escapeHtml(result.image)}" alt="">`);
    }
  } else {
    const small = result.image.replace(/-300$/, "-150");
    state.albums = state.albums.map(a => String(a.artist_id) === t.id ? {...a, artist_image: small, artist_artwork_id: result.artwork_id} : a);
    for (const album of state.details.values()) if (String(album.artist_id) === t.id) { album.artist_image = small; album.artist_artwork_id = result.artwork_id; }
    if (editing && String(editing.originals[0].artist_id) === t.id) {
      editing.originals[0].artist_image = small; editing.originals[0].artist_artwork_id = result.artwork_id;
      const avatarEl = document.querySelector("#change-artist-image .artist-avatar");
      if (avatarEl) avatarEl.innerHTML = `<img src="${escapeHtml(small)}" alt="">`;
    }
  }
}

function artworkUndoNote(entry) {
  const a = entry.artwork;
  if (!a) return "";
  const previous = a.previous || {};
  if (a.target === "artist" && !(Number(previous.artwork_id) > 0)) return TagcastI18n.text("artwork.undo.noPreviousImage");
  if (a.target === "album" && !Object.values(previous.tracks || {}).some(id => Number(id) > 0)) return TagcastI18n.text("artwork.undo.noPreviousCover");
  return "";
}

async function undoArtwork(entry) {
  const a = entry.artwork;
  if (saving) return;
  if (artworkUndoNote(entry)) return;
  if (!confirm(TagcastI18n.text(a.target === "album" ? "artwork.undo.confirmCover" : "artwork.undo.confirmImage", {label: a.label}))) return;
  const before = a.target === "album" ? {tracks: Object.fromEntries(Object.keys(a.previous.tracks).map(id => [id, a.artwork_id]))} : {artwork_id: a.artwork_id};
  saving = true; updateHistoryControls();
  try {
    const result = await api("/api/artwork/undo", {target: a.target, id: a.id, label: a.label, before, previous: a.previous});
    entry.undone = true; rememberHistory();
    const undo = artworkEntry({target: a.target, id: a.id, label: `${a.label} (undo)`, artist: a.artist}, result, "before", a.after);
    undo.artwork = null;
    state.history.unshift(undo);
    pendingAlbums = null; // discard the earlier image save's deferred read-back
    showNewArt({target: a.target, id: a.id}, result);
    render(); showHistory();
    toast(result.note ? `${TagcastI18n.text("artwork.undo.coverBack")} ${result.note}` : TagcastI18n.text("artwork.undo.imageBack"));
    followJob(result.job, undo);
  } catch (error) {
    if (typeof historyView !== "undefined") historyView.status = "";
    $("#history-status").textContent = TagcastI18n.errorText(error); toast(TagcastI18n.errorText(error));
  }
  finally { saving = false; updateHistoryControls(); }
}

document.addEventListener("click", event => {
  if (event.target.closest("#change-cover")) { openArtwork(albumArtTarget()); return; }
  if (event.target.closest("#change-artist-image")) { openArtwork(artistArtTarget()); return; }
  const pageImage = event.target.closest("#change-artist-page-image");
  if (pageImage) { openArtwork(artistPageTarget(state.artist, pageImage.dataset.artistPageImageId || null)); return; }
  const option = event.target.closest("[data-art-choice]");
  if (option) { choose(Number(option.dataset.artChoice)); return; }
  if (event.target.closest("#art-save") && !event.target.closest("#art-save").onclick) { saveArtwork(); return; }
  const undo = event.target.closest("[data-undo]");
  if (undo) { const entry = state.history[Number(undo.dataset.undo)]; if (entry?.artwork) undoArtwork(entry); }
});
document.addEventListener("change", event => { if (event.target.id === "art-file") readFile(event.target.files[0]); });
document.addEventListener("submit", event => {
  if (event.target.id !== "art-url-form") return;
  event.preventDefault();
  const url = $("#art-url").value.trim();
  if (!/^https?:\/\//i.test(url)) { toast(TagcastI18n.text("artwork.url.invalid")); return; }
  choose(addOption({url, thumb: url, source: "Your address", sourceKey: "artwork.source.address", title: url}));
});
document.addEventListener("paste", event => {
  if (!$("#artwork").open) return;
  const file = [...(event.clipboardData?.files || [])].find(f => f.type.startsWith("image/"));
  if (file) { event.preventDefault(); readFile(file); }
});
for (const type of ["dragover", "drop"]) {
  document.addEventListener(type, event => {
    const drop = event.target.closest?.("#art-drop");
    if (!drop) return;
    event.preventDefault();
    drop.classList.toggle("over", type === "dragover");
    if (type === "drop") readFile(event.dataTransfer.files[0]);
  });
}
