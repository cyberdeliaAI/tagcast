"use strict";

// Public health is independent of the signed-in account and library snapshot.
// `error` is true when the public feed could not be read; its note is translated when shown.
const serviceStatus = {data: null, pending: null, attemptedAt: 0, timer: null, error: false, announced: ""};
// Values are interface text keys; the object keys are the states the feed reports.
const SERVICE_STATUS_LABELS = {operational: "serviceStatus.state.operational", degraded: "serviceStatus.state.degraded", outage: "serviceStatus.state.outage", unknown: "serviceStatus.state.unknown"};
const SERVICE_STATUS_NAMES = [["streaming", "serviceStatus.service.streaming"], ["api", "serviceStatus.service.api"], ["queue", "serviceStatus.service.queue"], ["artwork", "serviceStatus.service.artwork"], ["library", "serviceStatus.service.library"]];

function serviceStatusPanel() {
  return `<section class="card service-status-card" aria-labelledby="service-status-title"><div class="service-status-heading"><div><h2 id="service-status-title">${TagcastI18n.html("serviceStatus.panel.heading")}</h2><p class="muted">${TagcastI18n.html("serviceStatus.panel.intro")}</p></div><button type="button" class="button small" data-service-refresh>${TagcastI18n.html("serviceStatus.panel.refresh")}</button></div><div id="service-status-content"><p class="muted">${TagcastI18n.html("serviceStatus.panel.checkingFeed")}</p></div><p id="service-status-live" class="service-status-live" role="status" aria-live="polite"></p></section>`;
}

function serviceStatusTimestamp(value) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return TagcastI18n.html("serviceStatus.time.unavailable");
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(TagcastI18n.dateTime(time, {dateStyle: "medium", timeStyle: "short"}))}</time>`;
}

function renderServiceStatus() {
  const box = document.querySelector("#service-status-content");
  if (!box || state.screen !== "overview") return;
  const data = serviceStatus.data;
  const reported = Date.parse(data?.reported_at || ""), fetched = Date.parse(data?.fetched_at || "");
  const now = Date.now(), expired = !Number.isFinite(reported) || !Number.isFinite(fetched)
    || now - reported > 900000 || reported - now > 300000 || now - fetched > 900000;
  const unknown = Boolean(serviceStatus.error || data?.error || data?.stale || expired);
  const rows = SERVICE_STATUS_NAMES.map(([id, name]) => {
    const row = Array.isArray(data?.services) ? data.services.find(s => s.id === id) : null;
    const stamp = Date.parse(row?.reported_at || "");
    const current = !unknown && Number.isFinite(stamp) && now - stamp <= 900000 && stamp - now <= 300000;
    const status = current && Object.hasOwn(SERVICE_STATUS_LABELS, row?.state) ? row.state : "unknown";
    return {name, status, details: current && ["degraded", "outage"].includes(status) ? row?.details : ""};
  });
  const states = rows.map(r => r.status);
  let overall = unknown ? "unknown" : states.includes("outage") ? "outage" : states.includes("degraded") ? "degraded" : "unknown";
  if (!unknown && states.every(s => s === "operational") && data?.overall === "operational") overall = "operational";
  const summary = TagcastI18n.text({operational: "serviceStatus.summary.operational", outage: "serviceStatus.summary.outage", degraded: "serviceStatus.summary.degraded", unknown: "serviceStatus.summary.unknown"}[overall]);
  const previous = box.querySelector?.("details"), expanded = overall !== "operational" && previous?.dataset?.state !== overall ? Boolean(data) : previous ? previous.open : false;
  const focusId = document.activeElement?.id;
  const focused = document.activeElement?.closest?.("[data-service-refresh]");
  // Which note is shown, independent of the interface language (announcements follow changes only).
  const noteId = serviceStatus.error ? "feed" : data?.error ? `error:${data.error}` : data?.stale || expired && data ? "stale" : "";
  const note = serviceStatus.error ? TagcastI18n.text("serviceStatus.note.feedFailed") : data?.error
    || (noteId === "stale" ? TagcastI18n.text("serviceStatus.note.stale") : "");
  const stamp = value => TagcastI18n.trusted(serviceStatusTimestamp(value));
  box.innerHTML = `<p class="service-status-summary"><span class="service-state-dot state-${overall}" aria-hidden="true"></span><strong>${escapeHtml(summary)}</strong>${serviceStatus.pending ? `<span class="muted">${TagcastI18n.html("serviceStatus.checking")}</span>` : ""}</p>
    ${note ? `<p class="muted service-status-note">${escapeHtml(note)}</p>` : ""}
    ${data?.message && overall !== "operational" && !unknown ? `<p class="muted">${escapeHtml(data.message)}</p>` : ""}
    <details class="service-status-details" data-state="${overall}" ${expanded ? "open" : ""}><summary id="service-status-expand">${TagcastI18n.html("serviceStatus.details.expand")}</summary><ul>${rows.map(row => `<li><div><strong>${TagcastI18n.html(row.name)}</strong><span class="service-state state-${row.status}"><span class="service-state-dot" aria-hidden="true"></span>${TagcastI18n.html(SERVICE_STATUS_LABELS[row.status])}</span></div>${row.details ? `<p>${escapeHtml(row.details)}</p>` : ""}</li>`).join("")}</ul></details>
    <div class="service-status-foot"><p>${TagcastI18n.html("serviceStatus.time.fetched", {time: stamp(data?.fetched_at)})}<br>${TagcastI18n.html("serviceStatus.time.reported", {time: stamp(data?.reported_at)})}<br>${TagcastI18n.html("serviceStatus.time.checked", {time: stamp(data?.checked_at)})}</p><a id="service-status-official" href="https://status.ibroadcast.com/" target="_blank" rel="noopener noreferrer">${TagcastI18n.html("serviceStatus.details.official")}</a></div><p class="muted service-status-cadence">${TagcastI18n.html("serviceStatus.details.cadence")}</p>`;
  const button = document.querySelector("[data-service-refresh]");
  if (button) { button.setAttribute("aria-disabled", String(Boolean(serviceStatus.pending))); button.textContent = TagcastI18n.text(serviceStatus.pending ? "serviceStatus.checking" : "serviceStatus.panel.refresh"); }
  if (["service-status-expand", "service-status-official"].includes(focusId)) document.querySelector(`#${focusId}`)?.focus({preventScroll: true});
  if (focused && button && !button.disabled) button.focus({preventScroll: true});
  const key = `${overall}/${noteId}`;
  if (key !== serviceStatus.announced) {
    serviceStatus.announced = key;
    const liveStatus = document.querySelector("#service-status-live");
    if (liveStatus) liveStatus.textContent = summary;
  }
}

function scheduleServiceStatus() {
  clearTimeout(serviceStatus.timer);
  if (state.screen !== "overview" || document.hidden) return;
  serviceStatus.timer = setTimeout(() => refreshServiceStatus(), Math.max(1000, 300000 - (Date.now() - serviceStatus.attemptedAt)));
}
async function refreshServiceStatus(manual = false) {
  if (serviceStatus.pending) return serviceStatus.pending;
  if (!manual && serviceStatus.attemptedAt && Date.now() - serviceStatus.attemptedAt < 300000) {
    renderServiceStatus(); scheduleServiceStatus(); return;
  }
  serviceStatus.attemptedAt = Date.now();
  serviceStatus.pending = (async () => {
    try {
      const data = await api(manual ? "/api/service-status?refresh=1" : "/api/service-status");
      if (!data || !Array.isArray(data.services)) throw Error("Invalid public status response.");
      serviceStatus.data = data; serviceStatus.error = false;
    } catch {
      serviceStatus.error = true;
    } finally { serviceStatus.pending = null; renderServiceStatus(); scheduleServiceStatus(); }
  })();
  renderServiceStatus();
  return serviceStatus.pending;
}
function syncServiceStatusPage() {
  clearTimeout(serviceStatus.timer);
  if (state.screen === "overview" && !document.hidden) refreshServiceStatus();
}
document.addEventListener("visibilitychange", syncServiceStatusPage);
document.addEventListener("click", event => {
  if (event.target.closest("[data-service-refresh]") && state.screen === "overview") refreshServiceStatus(true);
});
