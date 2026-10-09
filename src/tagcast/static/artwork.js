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

function artistPageTarget(name) {
  const album = state.albums.find(a => a.artist === name && a.artist_id);
  if (!album) return null;
  return {target: "artist", id: String(album.artist_id), label: name, current: (album.artist_image || "").replace(/-150$/, "-300"),
    artist: name, before: {artwork_id: album.artist_artwork_id || 0}};
}

function openArtwork(target, preselect) {
  if (!target) return;
  if (!live()) { toast("Connect your iBroadcast account to change images."); return; }
  art.target = target; art.options = []; art.choice = null; art.saved = []; art.artworkId = 0;
  const isAlbum = target.target === "album";
  $("#artwork-content").innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">${isAlbum ? "ALBUM COVER" : "ARTIST IMAGE"}</div><h2>${escapeHtml(target.label)}</h2></div><button class="close" data-close="artwork" aria-label="Close">×</button></div>
    <div class="art-compare"><figure><figcaption>Now</figcaption>${target.current ? `<img src="${escapeHtml(target.current)}" alt="Current image" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;art-empty&quot;>No image</div>'">` : '<div class="art-empty">No image</div>'}</figure><span class="art-arrow" aria-hidden="true">→</span><figure><figcaption>New</figcaption><div id="art-new"><div class="art-empty">Choose an image below</div></div><small id="art-size"></small></figure></div>
    <h3 class="art-heading">Suggestions</h3><div id="art-suggestions" class="art-grid"><p class="muted"><span class="spinner"></span>Searching…</p></div>
    <h3 class="art-heading">Already in iBroadcast</h3><div id="art-related" class="art-grid"><p class="muted"><span class="spinner"></span>Loading…</p></div>
    <h3 class="art-heading">Your own image</h3>
    <div class="art-own"><label class="art-drop" id="art-drop"><input type="file" id="art-file" accept="image/jpeg,image/png,image/webp,image/gif"> Drop an image here, paste it, or <u>choose a file</u></label>
    <form id="art-url-form" class="connect-row"><input id="art-url" type="url" placeholder="https://… address of an image" aria-label="Image address"><button class="button">Use</button></form></div>
    <div class="dialog-footer"><span class="muted" id="art-status">${!isAlbum ? "Replaces this artist's image everywhere in iBroadcast." : target.discs ? `Replaces the cover of all ${target.tracks} tracks, on all ${target.discs.length} discs.` : `Replaces the cover of all ${target.tracks} tracks of this album.`}</span><button class="button" data-close="artwork">Cancel</button><button class="button primary" id="art-save" disabled>Save to iBroadcast</button></div>`;
  $("#artwork").showModal();
  if (preselect) choose(addOption(preselect));
  loadSuggestions(target);
  loadRelated(target);
}

function addOption(option) {
  const existing = art.options.findIndex(o => (o.url && o.url === option.url) || (o.artwork_id && o.artwork_id === option.artwork_id));
  if (existing >= 0) return existing;
  art.options.push(option);
  return art.options.length - 1;
}

function tile(index) {
  const o = art.options[index];
  return `<button class="art-tile ${art.choice === index ? "chosen" : ""}" data-art-choice="${index}" title="${escapeHtml(o.title || o.source)}"><img src="${escapeHtml(o.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('.art-tile').remove()"><span>${escapeHtml(o.source)}</span></button>`;
}

function loadSuggestions(target) {
  const box = $("#art-suggestions");
  const indexes = [];
  const show = () => { box.innerHTML = indexes.length ? indexes.map(tile).join("") : '<p class="muted">No suggestions yet.</p>'; };
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
  if (!waiting) box.innerHTML = '<p class="muted">No online sources are available. Add keys in Sources &amp; keys.</p>';
}

async function loadRelated(target) {
  const box = $("#art-related");
  try {
    const data = await api(`/api/artwork/related?${new URLSearchParams(target.target === "album" ? {album_id: target.id} : {artist_id: target.id})}`);
    const indexes = data.artwork.map(a => addOption({artwork_id: a.artwork_id, url: a.image, thumb: a.thumb, source: "iBroadcast"}));
    box.innerHTML = indexes.length ? indexes.map(tile).join("") : '<p class="muted">iBroadcast has no other images for this yet.</p>';
  } catch (error) { box.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`; }
}

function choose(index) {
  art.choice = index;
  const o = art.options[index];
  for (const el of document.querySelectorAll(".art-tile")) el.classList.toggle("chosen", Number(el.dataset.artChoice) === index);
  $("#art-new").innerHTML = `<img src="${escapeHtml(o.data || o.url)}" alt="New image" referrerpolicy="no-referrer">`;
  $("#art-size").textContent = "Loading…";
  const img = $("#art-new img");
  img.onload = () => {
    const w = img.naturalWidth, h = img.naturalHeight, notes = [];
    if (Math.min(w, h) < 500) notes.push("small, may look blurry");
    if (Math.abs(w - h) > Math.max(w, h) * 0.03) notes.push("not square, iBroadcast crops it");
    $("#art-size").textContent = `${o.source} · ${w} × ${h}${notes.length ? ` · ${notes.join(", ")}` : ""}`;
  };
  img.onerror = () => { $("#art-size").textContent = "This image could not be loaded. Choose another one."; $("#art-save").disabled = true; };
  $("#art-save").disabled = false;
}

function readFile(file) {
  if (!file) return;
  if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) { toast("Choose a JPEG, PNG, WebP or GIF image."); return; }
  if (file.size > MAX_IMAGE) { toast("Images can be at most 15 MB."); return; }
  const reader = new FileReader();
  reader.onload = () => choose(addOption({data: reader.result, name: file.name, thumb: reader.result, source: "Your file", title: file.name}));
  reader.readAsDataURL(file);
}

async function saveArtwork() {
  const t = art.target, o = art.options[art.choice];
  if (!t || !o) return;
  const save = $("#art-save"), discs = t.discs || [t];
  save.disabled = true; save.textContent = "Saving…";
  try {
    for (const d of discs.filter(d => !art.saved.includes(d.id))) {
      $("#art-status").innerHTML = `<span class="spinner"></span>${discs.length > 1 ? `Saving disc ${art.saved.length + 1} of ${discs.length}…` : "Checking iBroadcast and saving…"}`;
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
    toast(`${t.target === "album" ? "Cover" : "Artist image"} saved${discs.length > 1 ? ` on all ${discs.length} discs` : ""}. Checking the result with iBroadcast in the background…`);
  } catch (error) {
    if (art.saved.length) render();
    save.disabled = false; save.textContent = art.saved.length ? "Save the other discs" : "Try again";
    const part = art.saved.length ? `${art.saved.length} of ${discs.length} discs have the new cover. ` : "";
    $("#art-status").innerHTML = `<span class="error-text">${escapeHtml(part + error.message)}</span>`;
    if (error.status === 409) { save.textContent = "Reload library"; save.onclick = () => { $("#artwork").close(); $("#editor").close(); loadLive(); }; }
  }
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

async function undoArtwork(entry) {
  const a = entry.artwork;
  if (!confirm(`Put the previous ${a.target === "album" ? "cover" : "artist image"} of “${a.label}” back?`)) return;
  const before = a.target === "album" ? {tracks: Object.fromEntries(Object.keys(a.previous.tracks).map(id => [id, a.artwork_id]))} : {artwork_id: a.artwork_id};
  try {
    const result = await api("/api/artwork/undo", {target: a.target, id: a.id, label: a.label, before, previous: a.previous});
    entry.undone = true; rememberHistory();
    const undo = artworkEntry({target: a.target, id: a.id, label: `${a.label} (undo)`, artist: a.artist}, result, "before", a.after);
    undo.artwork = null;
    state.history.unshift(undo);
    showNewArt({target: a.target, id: a.id}, result);
    render(); showHistory();
    toast(result.note ? `The previous cover is back. ${result.note}` : "The previous image is back. Checking the result with iBroadcast…");
    followJob(result.job, undo);
  } catch (error) { toast(error.message); }
}

document.addEventListener("click", event => {
  if (event.target.closest("#change-cover")) { openArtwork(albumArtTarget()); return; }
  if (event.target.closest("#change-artist-image")) { openArtwork(artistArtTarget()); return; }
  if (event.target.closest("#change-artist-page-image")) { openArtwork(artistPageTarget(state.artist)); return; }
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
  if (!/^https?:\/\//i.test(url)) { toast("Enter an image address that starts with https://"); return; }
  choose(addOption({url, thumb: url, source: "Your address", title: url}));
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
