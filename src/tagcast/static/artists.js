"use strict";

// Album artists come from compact album summaries; opening this view loads no tracks.
const artistBrowse = {page: 0, pageSize: 24};
let artistBrowseTimer;

function filteredArtistGroups() {
  const query = $("#artists-search").value.toLocaleLowerCase().trim();
  const groups = artistGroups().filter(([name]) => name.toLocaleLowerCase().includes(query));
  return $("#artists-sort").value === "za" ? groups.reverse() : groups;
}

function renderArtistBrowse() {
  if (state.screen !== "artists") return;
  const groups = filteredArtistGroups(), size = artistBrowse.pageSize;
  const maxPage = Math.max(0, Math.ceil(groups.length / size) - 1);
  artistBrowse.page = Math.max(0, Math.min(artistBrowse.page, maxPage));
  $("#artists-results").textContent = `${groups.length.toLocaleString("en")} ${groups.length === 1 ? "album artist" : "album artists"}`;
  $("#artists-grid").innerHTML = groups.slice(artistBrowse.page * size, (artistBrowse.page + 1) * size).map(([name, group]) => {
    const image = group.image ? `<img src="${escapeHtml(group.image.replace(/-150$/, "-300"))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
    return `<button class="artist-card" data-browse-artist="${escapeHtml(name)}" aria-label="Open albums by ${escapeHtml(name)}">
      <span class="artist-card-photo">${image}<span>${escapeHtml(initials(name))}</span></span>
      <strong>${escapeHtml(name)}</strong><span class="artist-card-count">${group.count.toLocaleString("en")} ${group.count === 1 ? "album" : "albums"}</span></button>`;
  }).join("") || (state.loading ? '<div class="empty" role="status"><span class="spinner"></span>Loading album artists…</div>'
    : '<div class="empty">No album artists match your search.</div>');
  $("#artists-pagination").innerHTML = maxPage > 0 ? `<button class="button small" data-artist-page="-1" ${artistBrowse.page === 0 ? "disabled" : ""}>← Previous</button><span>Page ${artistBrowse.page + 1} of ${(maxPage + 1).toLocaleString("en")}</span><button class="button small" data-artist-page="1" ${artistBrowse.page === maxPage ? "disabled" : ""}>Next →</button>` : "";
}

function showArtistBrowse() {
  showScreen("artists");
  renderArtistBrowse();
  window.scrollTo?.({top: 0});
}

$("#show-artists").addEventListener("click", showArtistBrowse);
$("#artists-search").addEventListener("input", () => {
  clearTimeout(artistBrowseTimer);
  artistBrowseTimer = setTimeout(() => { artistBrowse.page = 0; renderArtistBrowse(); }, 150);
});
$("#artists-sort").addEventListener("change", () => { artistBrowse.page = 0; renderArtistBrowse(); });
document.addEventListener("click", event => {
  const artist = event.target.closest("[data-browse-artist]");
  if (artist) {
    $("#filter").value = "all";
    setArtist(artist.dataset.browseArtist);
    window.scrollTo?.({top: 0});
    return;
  }
  const page = event.target.closest("[data-artist-page]");
  if (page) {
    artistBrowse.page += Number(page.dataset.artistPage);
    renderArtistBrowse();
    window.scrollTo?.({top: 0});
  }
});
