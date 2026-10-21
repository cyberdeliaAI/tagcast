"use strict";

// Drafts permute original positions, never track IDs: repeated copies stay separate.
const playlistOrder = {draft: null, generation: 0, focus: null, drag: null};

function resetPlaylistOrder(restoreFocus = false) {
  const focus = playlistOrder.focus;
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
    request: 0, loading: false, busy: false, sent: false, error: "", message: "", move: null};
  playlistOrder.draft = draft;
  $("#playlist-order-title").textContent = data.name;
  $("#playlist-order").showModal(); loadPlaylistOrderPage();
}

function renderPlaylistOrder() {
  const d = playlistOrder.draft;
  if (!playlistOrderCurrent(d)) return;
  const disabled = d.loading || d.busy || d.sent;
  const positions = d.order.slice(d.offset, d.offset + 100);
  const changes = d.order.filter((source, i) => source !== i).length;
  const moving = d.move === null ? null : d.rows.get(d.move);
  const moveForm = moving ? `<form id="playlist-order-move" class="playlist-order-move"><label class="field"><span>Move ${escapeHtml(moving.title)} to position</span><input name="position" type="number" min="1" max="${d.order.length}" step="1" required value="${d.order.indexOf(d.move) + 1}" aria-label="New playlist position"></label><button class="button small primary" ${disabled ? "disabled" : ""}>Move</button><button type="button" class="button small" data-order-move-cancel>Cancel move</button></form>` : "";
  $("#playlist-order-content").innerHTML = `<p>${d.order.length} saved positions · ${changes ? `${changes} positions changed` : "Original order"}</p>${moveForm}${d.loading ? '<p class="operation-status muted" data-working="true">Loading playlist positions…</p>' : d.error && !d.sent ? '<button type="button" class="button small" data-order-retry>Retry reading positions</button>' : `<div class="playlist-order-table"><table class="album-tracks"><thead><tr><th aria-label="Move track"></th><th>#</th><th>Title / Artist</th><th>Actions</th></tr></thead><tbody>${positions.map((source, i) => {
    const track = d.rows.get(source);
    if (!track) return "";
    const position = d.offset + i;
    return `<tr data-order-row="${source}"><td><button type="button" class="playlist-order-handle" draggable="${!disabled}" data-order-handle="${source}" aria-label="Move ${escapeHtml(track.title)}, position ${position + 1} of ${d.order.length}" aria-describedby="playlist-order-hint" title="Drag to move; use ↑ / ↓ with the keyboard" ${disabled ? "disabled" : ""}>⠿</button></td><td>${position + 1}</td><td><strong>${escapeHtml(track.title)}</strong><small>${track.available ? escapeHtml(track.artist) : `Track ID ${escapeHtml(track.id)} · Retained in playlist`}${source !== position ? ` · Was #${source + 1}` : ""}</small></td><td><button type="button" class="text-action" data-order-move="${source}" ${disabled ? "disabled" : ""}>Move to position…</button></td></tr>`;
  }).join("")}</tbody></table></div>`}<div class="pagination"><button type="button" class="button small" data-order-page="-100" ${disabled || !d.offset ? "disabled" : ""}>← Previous</button><span>${Math.floor(d.offset / 100) + 1} / ${Math.ceil(d.order.length / 100)}</span><button type="button" class="button small" data-order-page="100" ${disabled || d.offset + 100 >= d.order.length ? "disabled" : ""}>Next →</button></div>`;
  const status = $("#playlist-order-status");
  status.textContent = d.error || d.message;
  status.classList.toggle("error-text", Boolean(d.error));
  status.classList.toggle("operation-status", d.busy); status.dataset.working = String(d.busy);
  $("#playlist-order-save").disabled = disabled || Boolean(d.error) || !playlistOrderChanged(d);
  for (const button of $("#playlist-order").querySelectorAll("[data-order-close]")) button.disabled = d.busy;
  $("#playlist-order-cancel").textContent = d.sent ? "Close" : "Cancel";
  if (!d.loading && d.focusSource !== undefined) {
    const handle = $("#playlist-order-content").querySelector(`[data-order-handle="${d.focusSource}"]`);
    handle?.focus({preventScroll: true}); handle?.scrollIntoView?.({block: "nearest", inline: "nearest"});
    delete d.focusSource;
  }
}

async function loadPlaylistOrderPage() {
  const d = playlistOrder.draft;
  if (!playlistOrderCurrent(d) || d.busy || d.sent) return;
  const positions = d.order.slice(d.offset, d.offset + 100);
  if (positions.every(p => d.rows.has(p))) { renderPlaylistOrder(); return; }
  const request = ++d.request;
  d.loading = true; d.error = ""; renderPlaylistOrder();
  try {
    const response = await api(`/api/playlist/order?${new URLSearchParams({playlist: d.id,
      before_token: d.before_token, before_name: d.name, session: d.session, positions: positions.join(",")})}`);
    if (!playlistOrderCurrent(d) || request !== d.request) return;
    if (!Array.isArray(response.rows) || response.rows.length !== positions.length
        || response.rows.some((t, i) => t.source_position !== positions[i]
          || String(t.id) !== String(d.before[positions[i]]))) throw Error("Playlist positions changed. Close and reopen the order editor.");
    d.rows = new Map(response.rows.map(t => [t.source_position, t]));
  } catch (error) {
    if (playlistOrderCurrent(d) && request === d.request) { d.error = error.message; d.rows.clear(); }
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
  const title = d.rows.get(source)?.title || "Track";
  d.order.splice(from, 1); d.order.splice(destination, 0, source);
  d.offset = Math.floor(destination / 100) * 100; d.move = null; d.focusSource = source;
  d.message = `Moved ${title} to position ${destination + 1}. Changes are not saved yet.`;
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
  d.message = "Saving playlist order…"; renderPlaylistOrder();
  try {
    const response = await api("/api/playlist", {action: "reorder", playlist: d.id, before_token: d.before_token,
      before_name: d.name, session: d.session, positions: d.order.slice(), approved: true});
    if (!playlistOrderCurrent(d)) return;
    d.message = "Checking playlist order in iBroadcast…"; renderPlaylistOrder();
    const job = await collectionJob(response, () => playlistOrderCurrent(d));
    if (job.results?.length !== 1 || String(job.results[0].id) !== String(d.id)
        || job.results[0].status !== "saved") throw Error("Read-back did not confirm the new order.");
    resetPlaylistOrder(true); toast("Playlist order saved and confirmed in iBroadcast.");
    await refreshAfterPlaylistOrder(d);
  } catch (error) {
    if (playlistOrderCurrent(d)) {
      d.error = `${error.message} Check the playlist before trying again. This request will not be sent again.`;
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

document.addEventListener("click", event => {
  const target = event.target;
  if (target.closest("[data-playlist-reorder]")) return openPlaylistOrder();
  if (target.closest("[data-order-close]")) return closePlaylistOrder();
  if (target.closest("#playlist-order-save")) return savePlaylistOrder();
  const d = playlistOrder.draft;
  if (!playlistOrderCurrent(d) || d.loading || d.busy || d.sent) return;
  const page = target.closest("[data-order-page]"), move = target.closest("[data-order-move]");
  if (page) { d.offset = Math.max(0, Math.min(Math.floor((d.order.length - 1) / 100) * 100, d.offset + Number(page.dataset.orderPage))); d.move = null; loadPlaylistOrderPage(); }
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
    d.message = `Choose a position from 1 to ${d.order.length}.`; renderPlaylistOrder(); return;
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
