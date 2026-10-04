"use strict";

// Overview: your iBroadcast account, the collection in numbers, metadata health (each
// row opens the matching album filter) and what you play most.

const overview = {data: null, loading: false};
const fmt = n => Number(n || 0).toLocaleString("en");

function bytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0, v = Number(n || 0);
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function duration(seconds) {
  const days = seconds / 86400;
  return days >= 2 ? `${fmt(Math.round(days))} days` : `${fmt(Math.round(seconds / 3600))} hours`;
}

function showScreen(name) {
  state.screen = name;
  $("#overview-page").hidden = name !== "overview";
  $("#albums-page").hidden = name !== "albums";
  $("#show-overview").classList.toggle("active", name === "overview");
  $("#all-albums").classList.toggle("active", name === "albums" && !state.artist);
  $("#breadcrumb").textContent = name === "overview" ? "Overview" : state.artist || "Albums";
  if (name === "overview") loadOverview();
}

async function loadOverview() {
  const page = $("#overview-page");
  if (!live()) {
    page.innerHTML = `${intro("Connect your iBroadcast account to see your account, your collection in numbers and its metadata health.")}`;
    return;
  }
  if (overview.loading) return;
  overview.loading = true;
  page.classList.add("refreshing");
  if (!overview.data) page.innerHTML = `${intro('<span class="spinner"></span>Reading your account and library…')}`;
  try {
    overview.data = await api("/api/overview");
    renderOverview(overview.data);
  } catch (error) {
    if (error.status === 401) { state.connection.connected = false; updateChrome(); }
    page.innerHTML = intro(escapeHtml(`Could not load the overview: ${error.message}`));
  } finally { overview.loading = false; page.classList.remove("refreshing"); }
}

function intro(subtitle) {
  return `<section class="page-intro"><div><div class="eyebrow">YOUR iBROADCAST</div><h1>Overview<span>.</span></h1><p>${subtitle}</p></div></section>`;
}

function statTile(label, value, note = "") {
  return `<div class="stat-tile"><span>${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ""}</div>`;
}

function renderOverview({account: a, stats: s}) {
  const plan = a.premium ? `Premium${a.subscription?.frequency ? ` · ${a.subscription.frequency}` : ""}` : "Free account";
  $("#overview-page").innerHTML = intro(`${escapeHtml(a.username || "Your account")} <span aria-hidden="true">·</span> ${escapeHtml(plan)} <span aria-hidden="true">·</span> library changed ${escapeHtml(a.lastmodified || "—")} (UTC)`)
    + `<div class="kpi-row">${[
      statTile("Tracks", fmt(s.tracks)), statTile("Albums", fmt(s.albums)), statTile("Album artists", fmt(s.album_artists), `${fmt(s.track_artists)} track artists`),
      statTile("Playlists", s.playlists == null ? "—" : fmt(s.playlists), s.playlists == null ? "after the next download" : ""),
      statTile("Plays", fmt(a.plays), "counted by iBroadcast"), statTile("Collection size", bytes(s.size)), statTile("Playing time", duration(s.length)),
    ].join("")}</div>
    <div class="overview-grid">${healthCard(s)}${accountCard(a)}${formatsCard(s)}${uploadsCard(s)}${topCard(s)}</div>`;
}

// ---- metadata health: meters that open the matching filter ----------------------

function healthCard(s) {
  const rows = [
    ["genre", "Tracks with a genre", ["track", "tracks"], "without a genre", "genre"],
    ["combined", "Genres stored as separate labels", ["track", "tracks"], "with several genres in one text, like “Pop;Rock”", "combined"],
    ["year", "Albums with a year", ["album", "albums"], "without a year", "year"],
    ["artist_image", "Album artists with an image", ["album artist", "album artists"], "without an image", "artist_image"],
    ["cover", "Tracks with a cover", ["track", "tracks"], "without a cover", "cover"],
  ];
  return `<section class="card"><h2>Metadata health</h2><p class="muted">What's still missing. Open a row to work through it album by album.</p>${rows.map(([key, label, noun, missing, filter]) => {
    const h = s.health[key] || {missing: 0, total: 0}, done = h.total ? (h.total - h.missing) / h.total : 1, pct = (done * 100).toFixed(done < 1 && done > 0.995 ? 2 : 1);
    return `<div class="health-row"><div class="health-head"><span>${label}</span><strong>${pct}%</strong></div>
      <div class="meter" role="meter" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${done * 100}%"></span></div>
      <div class="health-foot"><span class="muted">${h.missing ? `${fmt(h.missing)} ${noun[h.missing === 1 ? 0 : 1]} ${missing}` : "Nothing missing"}</span>${h.missing ? `<button class="text-action" data-health="${filter}">Show albums →</button>` : ""}</div></div>`;
  }).join("")}</section>`;
}

// ---- account & settings ------------------------------------------------------------

function accountCard(a) {
  const yes = v => v == null ? "—" : v ? "On" : "Off";
  const bitrate = {orig: "Original", auto: "Automatic"}[a.preferences.bitrate] || (a.preferences.bitrate ? `${a.preferences.bitrate} kbps` : "—");
  const sub = a.subscription;
  const rows = [
    ["Account", escapeHtml(a.username || "—")],
    ["E-mail", escapeHtml(a.email || "—")],
    ["Verified", a.verified ? `Yes${a.verified_on ? `, ${escapeHtml(a.verified_on)}` : ""}` : "No"],
    ["Plan", a.premium ? `Premium${sub?.name && sub.name.toLowerCase() !== "premium" && sub.name.toLowerCase() !== sub.frequency?.toLowerCase() ? ` (${escapeHtml(sub.name)})` : ""}${sub?.frequency ? ` · ${escapeHtml(sub.frequency)}` : ""}${sub?.renews_on && !sub.canceled ? ` · renews ${escapeHtml(sub.renews_on)}` : ""}${sub?.canceled ? " · canceled" : ""}` : "Free"],
    ["Last.fm scrobbling", a.linked.lastfm ? `Linked as ${escapeHtml(a.linked.lastfm)}` : "Not linked"],
    ["Dropbox · Google Drive", `${a.linked.dropbox ? "Linked" : "Not linked"} · ${a.linked.googledrive ? "Linked" : "Not linked"}`],
    ["Achievements", fmt(a.achievements)],
  ];
  const settings = [
    ["Streaming quality", bitrate, ""],
    ["One queue", yes(a.preferences.one_queue), ""],
    ["Combine Multi-Disc Album Sets", yes(a.preferences.combine_sets), a.preferences.combine_sets ? "iBroadcast refuses album changes (title, album artist, year, disc) while this is on. Track changes still work." : ""],
    ["Artist images", yes(a.preferences.artist_images), a.preferences.artist_images === false ? "iBroadcast shows a collage of covers instead of the artist images you set." : ""],
    ["Replay gain", yes(a.preferences.replay_gain), ""],
  ];
  return `<section class="card"><h2>Account</h2><dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    <h3>iBroadcast settings</h3><dl class="facts">${settings.map(([k, v, note]) => `<dt>${k}</dt><dd>${v}${note ? `<small class="${k.startsWith("Combine") ? "warn" : ""}">${note}</small>` : ""}</dd>`).join("")}</dl>
    <p class="muted">Change these in iBroadcast: <a href="https://media.ibroadcast.com/" target="_blank" rel="noopener noreferrer">media.ibroadcast.com ↗</a></p></section>`;
}

// ---- formats: horizontal bars, value at the tip ---------------------------------

function formatsCard(s) {
  const top = s.formats.slice(0, 6), rest = s.formats.slice(6);
  if (rest.length) top.push({name: "Other", tracks: rest.reduce((n, f) => n + f.tracks, 0), size: rest.reduce((n, f) => n + f.size, 0)});
  const max = Math.max(1, ...top.map(f => f.tracks));
  return `<section class="card"><h2>Formats</h2><p class="muted">Tracks per file format.</p><div class="hbars">${top.map(f => {
    const share = s.tracks ? (f.tracks / s.tracks * 100).toFixed(1) : "0";
    return `<div class="hbar" tabindex="0" data-tip="${escapeHtml(`${f.name}|${fmt(f.tracks)} tracks · ${bytes(f.size)} · ${share}%`)}"><span class="hbar-label">${escapeHtml(f.name)}</span><span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(0.5, f.tracks / max * 100)}%"></span></span><span class="hbar-value">${fmt(f.tracks)}</span></div>`;
  }).join("")}</div></section>`;
}

// ---- uploads per year: columns, the busiest year labelled -----------------------

function uploadsCard(s) {
  const years = s.uploads;
  if (!years.length) return `<section class="card"><h2>Uploads per year</h2><p class="muted">No upload dates in this library.</p></section>`;
  const max = Math.max(1, ...years.map(y => y.tracks)), peak = years.find(y => y.tracks === max);
  const ticks = [0, max / 2, max].map(v => Math.round(v));
  return `<section class="card"><h2>Uploads per year</h2><p class="muted">Tracks added to iBroadcast, by the year they were uploaded.</p>
    <div class="columns-chart"><div class="col-axis">${ticks.reverse().map(t => `<span>${fmt(t)}</span>`).join("")}</div><div class="cols">${years.map(y => `<div class="col" tabindex="0" data-tip="${escapeHtml(`${y.year}|${fmt(y.tracks)} tracks`)}"><span class="col-bar" style="height:${y.tracks ? Math.max(1, y.tracks / max * 100) : 0}%">${y === peak ? `<b>${fmt(y.tracks)}</b>` : ""}</span></div>`).join("")}</div><span></span><div class="col-years">${years.map(y => `<span>${y.year}</span>`).join("")}</div></div>
    <details class="table-view"><summary>Show as a table</summary><table><thead><tr><th>Year</th><th>Tracks</th></tr></thead><tbody>${years.map(y => `<tr><td>${y.year}</td><td>${fmt(y.tracks)}</td></tr>`).join("")}</tbody></table></details></section>`;
}

// ---- most played -----------------------------------------------------------------------

function topCard(s) {
  const list = (title, rows, cell) => `<div><h3>${title}</h3>${rows.length ? `<ol class="top-list">${rows.map(r => `<li>${cell(r)}<span class="plays">${fmt(r.plays)}</span></li>`).join("")}</ol>` : '<p class="muted">No plays yet.</p>'}</div>`;
  return `<section class="card wide"><h2>Most played</h2><p class="muted">From iBroadcast's play counts. Open an album or artist to edit it.</p><div class="top-grid">
    ${list("Tracks", s.top_tracks, r => `<span><strong>${escapeHtml(r.title)}</strong><small>${escapeHtml(r.artist)} · <button class="text-action" data-album="${escapeHtml(r.album_id)}">${escapeHtml(r.album)}</button></small></span>`)}
    ${list("Albums", s.top_albums, r => `<span><button class="text-action" data-album="${escapeHtml(r.album_id)}">${escapeHtml(r.album)}</button><small>${escapeHtml(r.artist)}</small></span>`)}
    ${list("Artists", s.top_artists, r => `<span><button class="text-action" data-overview-artist="${escapeHtml(r.artist)}">${escapeHtml(r.artist)}</button></span>`)}
  </div></section>`;
}

// ---- tooltip: one element, text only --------------------------------------------------

function showTip(target) {
  const tip = $("#chart-tip"), [title, value] = target.dataset.tip.split("|");
  tip.replaceChildren(Object.assign(document.createElement("strong"), {textContent: value}), Object.assign(document.createElement("span"), {textContent: title}));
  tip.hidden = false;
  const box = target.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, box.left + box.width / 2 - tip.offsetWidth / 2))}px`;
  tip.style.top = `${Math.max(8, box.top - tip.offsetHeight - 8)}px`;
}
const hideTip = () => { $("#chart-tip").hidden = true; };

for (const [type, handler] of [["pointerover", showTip], ["focusin", showTip]]) {
  document.addEventListener(type, event => { const t = event.target.closest?.("[data-tip]"); if (t) handler(t); });
}
for (const type of ["pointerout", "focusout"]) {
  document.addEventListener(type, event => { if (event.target.closest?.("[data-tip]")) hideTip(); });
}
window.addEventListener("scroll", hideTip, true);

document.addEventListener("click", event => {
  if (event.target.closest("#show-overview")) { showScreen("overview"); return; }
  if (event.target.closest("#all-albums") || event.target.closest("#home")) { if (state.screen === "overview") showScreen("albums"); return; }
  const health = event.target.closest("[data-health]");
  if (health) {
    $("#filter").value = health.dataset.health; $("#search").value = ""; state.artist = null; state.page = 0;
    showScreen("albums"); render(); return;
  }
  const artist = event.target.closest("[data-overview-artist]");
  if (artist) {
    const name = artist.dataset.overviewArtist;
    if (!state.albums.some(a => a.artist === name)) { toast(`${name} appears only as a track artist; the album list is ordered by album artist.`); return; }
    setArtist(name);
  }
});
