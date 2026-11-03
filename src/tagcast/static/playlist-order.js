"use strict";

// Drafts permute original positions, never track IDs: repeated copies stay separate.
// The dialog is a draft, so a language change never re-renders it. Its status texts are kept
// as functions (d.error, d.message), so the next repaint after a user action uses the current
// language; static labels in index.html switch on their own.
const playlistOrder = {draft: null, generation: 0, focus: null, drag: null};

function resetPlaylistOrder(restoreFocus = false) {
  const focus = playlistOrder.focus;
  clearTimeout(playlistOrder.draft?.timer);
  playlistOrder.generation += 1; playlistOrder.draft = null; playlistOrder.drag = null;
  playlistOrder.focus = null;
  $("#playlist-order").close(); $("#playlist-order-content").innerHTML = "";
  if (restoreFocus && focus?.isConnected) focus.focus({preventScroll: true});
}

function playlistOrderCurrent(draft = playlistOrder.draft) {
  return draft && playlistOrder.draft === draft && draft.generation === playlistOrder.generation
    && draft.details === state.details && draft.session === state.connection.playback_session
    && live() && !state.loading && state.screen === "playlists"
    && collectionsView.playlist === draft.id && $("#playlist-order").open;
}

function playlistOrderChanged(draft) {
  return draft.order.some((source, i) => String(draft.before[source]) !== String(draft.before[i]));
}

function openPlaylistOrder() {
  const data = collectionsView.data;
  if (!live() || state.loading || collectionsView.loading || collectionsView.busy || !data
      || data.is_folder || data.large || !data.before_token || !Array.isArray(data.before)
      || data.before.length < 2 || data.before.length > 10000 || document.querySelector("dialog[open]")) return;
  playlistOrder.generation += 1; playlistOrder.focus = document.activeElement;
  const draft = {id: data.id, name: data.name, before_token: data.before_token,
    before: data.before.slice(), order: data.before.map((_, i) => i), rows: new Map(),
    details: state.details, session: state.connection.playback_session, generation: playlistOrder.generation,
    offset: Math.min(collectionsView.offset, Math.floor((data.before.length - 1) / 100) * 100),
    query: "", matches: null, request: 0, loading: false, busy: false, sent: false, error: "", message: "", move: null};
  playlistOrder.draft = draft;
  $("#playlist-order-search").value = ""; syncSearchClearButtons();
  $("#playlist-order-title").textContent = data.name;
  $("#playlist-order").showModal(); loadPlaylistOrderPage();
}

function playlistOrderSources(d) {
  return d.matches ? d.order.filter(source => d.matches.has(source)) : d.order;
}

function renderPlaylistOrder() {
  const d = playlistOrder.draft;
  if (!playlistOrderCurrent(d)) return;
  const disabled = d.loading || d.busy || d.sent;
  const sources = playlistOrderSources(d), positions = sources.slice(d.offset, d.offset + 100);
  const changes = d.order.filter((source, i) => source !== i).length;
  const moving = d.move === null ? null : d.rows.get(d.move);
  const moveForm = moving ? `<form id="playlist-order-move" class="playlist-order-move"><label class="field"><span>${TagcastI18n.html("playlistOrder.move.label", {title: moving.title})}</span><input name="position" type="number" min="1" max="${d.order.length}" step="1" required value="${d.order.indexOf(d.move) + 1}" aria-label="${TagcastI18n.html("playlistOrder.move.input")}"></label><button class="button small primary" ${disabled ? "disabled" : ""}>${TagcastI18n.html("playlistOrder.move.submit")}</button><button type="button" class="button small" data-order-move-cancel>${TagcastI18n.html("playlistOrder.move.cancel")}</button></form>` : "";
  $("#playlist-order-content").innerHTML = `<p>${TagcastI18n.html("playlistOrder.summary.saved", {count: d.order.length})} · ${changes ? TagcastI18n.html("playlistOrder.summary.changed", {count: changes}) : TagcastI18n.html("playlistOrder.summary.original")}</p>${d.query.trim() && d.matches ? `<p role="status">${TagcastI18n.html("playlistOrder.search.matching", {count: sources.length})}</p>` : ""}${moveForm}${d.loading ? `<p class="operation-status muted" data-working="true">${TagcastI18n.html("playlistOrder.loading")}</p>` : d.error && !d.sent ? `<button type="button" class="button small" data-order-retry>${TagcastI18n.html("playlistOrder.retry")}</button>` : `<div class="playlist-order-table"><table class="album-tracks"><thead><tr><th aria-label="${TagcastI18n.html("playlistOrder.table.move")}"></th><th>#</th><th>${TagcastI18n.html("playlists.detail.titleArtist")}</th><th>${TagcastI18n.html("playlistOrder.table.actions")}</th></tr></thead><tbody>${positions.map(source => {
    const track = d.rows.get(source);
    if (!track) return "";
    const position = d.order.indexOf(source);
    return `<tr data-order-row="${source}"><td><button type="button" class="playlist-order-handle" draggable="${!disabled}" data-order-handle="${source}" aria-label="${TagcastI18n.html("playlistOrder.handle.label", {title: track.title, position: position + 1, total: d.order.length})}" aria-describedby="playlist-order-hint" title="${TagcastI18n.html("playlistOrder.handle.title")}" ${disabled ? "disabled" : ""}>⠿</button></td><td>${position + 1}</td><td><strong>${escapeHtml(track.title)}</strong><small>${track.available ? escapeHtml(track.artist) : TagcastI18n.html("playlistOrder.row.retained", {id: track.id})}${source !== position ? ` · ${TagcastI18n.html("playlistOrder.row.was", {position: source + 1})}` : ""}</small></td><td><button type="button" class="text-action" data-order-move="${source}" ${disabled ? "disabled" : ""}>${TagcastI18n.html("playlistOrder.row.move")}</button></td></tr>`;
  }).join("") || `<tr><td colspan="4" class="muted">${TagcastI18n.html("playlistOrder.empty")}</td></tr>`}</tbody></table></div>`}<div class="pagination"><button type="button" class="button small" data-order-page="-100" ${disabled || !d.offset ? "disabled" : ""}>${TagcastI18n.html("common.pagination.previous")}</button><span>${Math.floor(d.offset / 100) + 1} / ${Math.max(1, Math.ceil(sources.length / 100))}</span><button type="button" class="button small" data-order-page="100" ${disabled || d.offset + 100 >= sources.length ? "disabled" : ""}>${TagcastI18n.html("common.pagination.next")}</button></div>`;
  const status = $("#playlist-order-status");
  status.textContent = d.error ? d.error() : d.message ? d.message() : "";
  status.classList.toggle("error-text", Boolean(d.error));
  status.classList.toggle("operation-status", d.busy); status.dataset.working = String(d.busy);
  $("#playlist-order-search").disabled = d.busy || d.sent; syncSearchClearButtons();
  $("#playlist-order-save").disabled = disabled || Boolean(d.error) || !playlistOrderChanged(d);
  for (const button of $("#playlist-order").querySelectorAll("[data-order-close]")) button.disabled = d.busy;
  $("#playlist-order-cancel").textContent = TagcastI18n.text(d.sent ? "common.close" : "common.cancel");
  if (!d.loading && d.focusSource !== undefined) {
    const handle = $("#playlist-order-content").querySelector(`[data-order-handle="${d.focusSource}"]`);
    handle?.focus({preventScroll: true}); handle?.scrollIntoView?.({block: "nearest", inline: "nearest"});
    delete d.focusSource;
  }
}

async function searchPlaylistOrder() {
  const d = playlistOrder.draft;
  if (!playlistOrderCurrent(d) || d.busy || d.sent) return;
  const query = d.query, request = ++d.request;
  d.loading = true; d.error = ""; renderPlaylistOrder();
  try {
    const response = await api(`/api/playlist/order?${new URLSearchParams({playlist: d.id,
      before_token: d.before_token, before_name: d.name, session: d.session, q: query})}`);
    if (!playlistOrderCurrent(d) || request !== d.request || query !== d.query) return;
    if (!Array.isArray(response.positions) || response.positions.length > d.order.length
        || new Set(response.positions).size !== response.positions.length
        || response.positions.some(p => !Number.isInteger(p) || p < 0 || p >= d.order.length)) {
      throw playlistFailure("errors.playlists.order_search_changed");
    }
    d.matches = new Set(response.positions); d.loading = false;
    loadPlaylistOrderPage();
  } catch (error) {
    if (playlistOrderCurrent(d) && request === d.request) {
      d.loading = false; d.error = () => TagcastI18n.errorText(error); d.rows.clear(); renderPlaylistOrder();
    }
  }
}

async function loadPlaylistOrderPage() {
  const d = playlistOrder.draft;
  if (!playlistOrderCurrent(d) || d.busy || d.sent) return;
  if (d.query.trim() && !d.matches) return searchPlaylistOrder();
  const sources = playlistOrderSources(d);
  d.offset = Math.min(d.offset, Math.max(0, Math.ceil(sources.length / 100) - 1) * 100);
  const positions = sources.slice(d.offset, d.offset + 100);
  if (positions.every(p => d.rows.has(p))) {
    d.loading = false; d.error = "";
    d.rows = new Map(positions.map(p => [p, d.rows.get(p)])); renderPlaylistOrder(); return;
  }
  const request = ++d.request;
  d.loading = true; d.error = ""; renderPlaylistOrder();
  try {
    const response = await api(`/api/playlist/order?${new URLSearchParams({playlist: d.id,
      before_token: d.before_token, before_name: d.name, session: d.session, positions: positions.join(",")})}`);
    if (!playlistOrderCurrent(d) || request !== d.request) return;
    if (!Array.isArray(response.rows) || response.rows.length !== positions.length
        || response.rows.some((t, i) => t.source_position !== positions[i]
          || String(t.id) !== String(d.before[positions[i]]))) throw playlistFailure("errors.playlists.order_positions_changed");
    d.rows = new Map(response.rows.map(t => [t.source_position, t]));
  } catch (error) {
    if (playlistOrderCurrent(d) && request === d.request) { d.error = () => TagcastI18n.errorText(error); d.rows.clear(); }
  } finally {
    if (playlistOrderCurrent(d) && request === d.request) { d.loading = false; renderPlaylistOrder(); }
  }
}

function movePlaylistOrder(source, destination) {
  const d = playlistOrder.draft;
  if (!playlistOrderCurrent(d) || d.loading || d.busy || d.sent || !Number.isInteger(destination)
      || destination < 0 || destination >= d.order.length) return;
  const from = d.order.indexOf(source);
  if (from < 0 || from === destination) return;
  const title = d.rows.get(source)?.title || TagcastI18n.text("playlistOrder.move.trackFallback");
  d.order.splice(from, 1); d.order.splice(destination, 0, source);
  d.offset = Math.floor(playlistOrderSources(d).indexOf(source) / 100) * 100; d.move = null; d.focusSource = source;
  d.message = () => TagcastI18n.text("playlistOrder.move.done", {title, position: destination + 1});
  playlistOrder.drag = null; loadPlaylistOrderPage();
}

function closePlaylistOrder() {
  const d = playlistOrder.draft;
  if (d?.busy) return;
  resetPlaylistOrder(true);
  if (d?.sent && state.screen === "playlists") return refreshAfterPlaylistOrder(d);
}

async function refreshAfterPlaylistOrder(draft) {
  const generation = playlistOrder.generation;
  await renderCollections();
  if (generation === playlistOrder.generation && draft.details === state.details
      && draft.session === state.connection.playback_session && state.screen === "playlists"
      && collectionsView.playlist === draft.id && !document.querySelector("dialog[open]")) {
    $("#collections-page").querySelector("[data-playlist-reorder]")?.focus({preventScroll: true});
  }
}

async function savePlaylistOrder() {
  const d = playlistOrder.draft;
  if (!playlistOrderCurrent(d) || d.loading || d.busy || d.sent || d.error || !playlistOrderChanged(d)) return;
  d.busy = true; d.sent = true; d.move = null; collectionsView.busy = true;
  d.message = () => TagcastI18n.text("playlistOrder.save.saving"); renderPlaylistOrder();
  try {
    const response = await api("/api/playlist", {action: "reorder", playlist: d.id, before_token: d.before_token,
      before_name: d.name, session: d.session, positions: d.order.slice(), approved: true});
    if (!playlistOrderCurrent(d)) return;
    d.message = () => TagcastI18n.text("playlistOrder.save.checking"); renderPlaylistOrder();
    const job = await collectionJob(response, () => playlistOrderCurrent(d));
    if (job.results?.length !== 1 || String(job.results[0].id) !== String(d.id)
        || job.results[0].status !== "saved") throw playlistFailure("errors.playlists.order_readback");
    resetPlaylistOrder(true); toast(TagcastI18n.text("playlistOrder.save.done"));
    await refreshAfterPlaylistOrder(d);
  } catch (error) {
    if (playlistOrderCurrent(d)) {
      d.error = () => TagcastI18n.text("playlistOrder.save.failed", {error: TagcastI18n.errorText(error)});
    }
  } finally {
    d.busy = false; collectionsView.busy = false;
    if (playlistOrderCurrent(d)) renderPlaylistOrder();
  }
}

function clearPlaylistOrderDrop() {
  for (const row of $("#playlist-order-content").querySelectorAll(".order-drop-before, .order-drop-after")) {
    row.classList.remove("order-drop-before", "order-drop-after");
  }
}

document.addEventListener("input", event => {
  if (event.target.id !== "playlist-order-search") return;
  const d = playlistOrder.draft;
  if (!playlistOrderCurrent(d) || d.busy || d.sent) return;
  clearTimeout(d.timer); d.request += 1; d.query = event.target.value;
  d.matches = null; d.offset = 0; d.move = null; d.error = ""; d.loading = true;
  delete d.focusSource; playlistOrder.drag = null; renderPlaylistOrder();
  d.timer = setTimeout(() => { if (playlistOrderCurrent(d)) loadPlaylistOrderPage(); }, 300);
});

document.addEventListener("click", event => {
  const target = event.target;
  if (target.closest("[data-playlist-reorder]")) return openPlaylistOrder();
  if (target.closest("[data-order-close]")) return closePlaylistOrder();
  if (target.closest("#playlist-order-save")) return savePlaylistOrder();
  const d = playlistOrder.draft;
  if (!playlistOrderCurrent(d) || d.loading || d.busy || d.sent) return;
  const page = target.closest("[data-order-page]"), move = target.closest("[data-order-move]");
  if (page) { d.offset = Math.max(0, Math.min(Math.max(0, Math.ceil(playlistOrderSources(d).length / 100) - 1) * 100, d.offset + Number(page.dataset.orderPage))); d.move = null; loadPlaylistOrderPage(); }
  if (move) {
    d.move = Number(move.dataset.orderMove); renderPlaylistOrder();
    $("#playlist-order-move input")?.focus({preventScroll: true}); $("#playlist-order-move input")?.select?.();
  }
  if (target.closest("[data-order-move-cancel]")) { d.move = null; renderPlaylistOrder(); }
  if (target.closest("[data-order-retry]")) loadPlaylistOrderPage();
});

document.addEventListener("submit", event => {
  if (event.target.id !== "playlist-order-move") return;
  event.preventDefault();
  const d = playlistOrder.draft, position = Number(event.target.elements.position.value);
  if (!playlistOrderCurrent(d)) return;
  if (!Number.isInteger(position) || position < 1 || position > d.order.length) {
    const last = d.order.length;
    d.message = () => TagcastI18n.text("playlistOrder.move.range", {last}); renderPlaylistOrder(); return;
  }
  movePlaylistOrder(d.move, position - 1);
});

document.addEventListener("keydown", event => {
  const handle = event.target.closest?.("[data-order-handle]"), d = playlistOrder.draft;
  if (!handle || !playlistOrderCurrent(d) || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const source = Number(handle.dataset.orderHandle);
  movePlaylistOrder(source, d.order.indexOf(source) + (event.key === "ArrowUp" ? -1 : 1));
});

document.addEventListener("dragstart", event => {
  const handle = event.target.closest?.("[data-order-handle]"), d = playlistOrder.draft;
  if (!handle || !playlistOrderCurrent(d) || d.loading || d.busy || d.sent) return;
  playlistOrder.drag = Number(handle.dataset.orderHandle);
  event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", "Playlist position");
});

document.addEventListener("dragover", event => {
  const row = event.target.closest?.("[data-order-row]"), d = playlistOrder.draft;
  if (!row || !playlistOrderCurrent(d) || d.loading || d.busy || d.sent || playlistOrder.drag === null) return;
  event.preventDefault(); event.dataTransfer.dropEffect = "move"; clearPlaylistOrderDrop();
  const rect = row.getBoundingClientRect();
  row.classList.add(event.clientY < rect.top + rect.height / 2 ? "order-drop-before" : "order-drop-after");
});

document.addEventListener("drop", event => {
  const row = event.target.closest?.("[data-order-row]"), d = playlistOrder.draft;
  if (!row || !playlistOrderCurrent(d) || playlistOrder.drag === null) return;
  event.preventDefault();
  const rect = row.getBoundingClientRect(), source = playlistOrder.drag, from = d.order.indexOf(source);
  let destination = d.order.indexOf(Number(row.dataset.orderRow)) + (event.clientY >= rect.top + rect.height / 2 ? 1 : 0);
  if (from < destination) destination -= 1;
  clearPlaylistOrderDrop(); movePlaylistOrder(source, destination); playlistOrder.drag = null;
});
document.addEventListener("dragend", () => { playlistOrder.drag = null; clearPlaylistOrderDrop(); });
$("#playlist-order").addEventListener("cancel", event => { event.preventDefault(); closePlaylistOrder(); });
$("#playlist-order").addEventListener("close", () => { if (!$("#playlist-order").open && playlistOrder.draft) resetPlaylistOrder(); });
