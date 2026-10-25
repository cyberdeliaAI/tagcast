"use strict";

// Public health is independent of the signed-in account and library snapshot.
const serviceStatus = {data: null, pending: null, attemptedAt: 0, timer: null, error: "", announced: ""};
const SERVICE_STATUS_LABELS = {operational: "Operational", degraded: "Degraded performance", outage: "Service disruption", unknown: "Unknown / unavailable"};
const SERVICE_STATUS_NAMES = [["streaming", "Streaming"], ["api", "API Server"], ["queue", "Play Queue"], ["artwork", "Artwork"], ["library", "Library Generation"]];

function serviceStatusPanel() {
  return '<section class="card service-status-card" aria-labelledby="service-status-title"><div class="service-status-heading"><div><h2 id="service-status-title">iBroadcast Service Status</h2><p class="muted">Public service health · separate from your account connection.</p></div><button type="button" class="button small" data-service-refresh>Refresh</button></div><div id="service-status-content"><p class="muted">Checking the public status feed…</p></div><p id="service-status-live" class="service-status-live" role="status" aria-live="polite"></p></section>';
}

function serviceStatusTimestamp(value) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return "Not available";
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(new Date(time).toLocaleString("en-GB", {dateStyle: "medium", timeStyle: "short"}))}</time>`;
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
  const summary = {operational: "All five services operational", outage: "Service disruption reported", degraded: "Degraded performance reported", unknown: "Current service status unavailable"}[overall];
  const previous = box.querySelector?.("details"), expanded = overall !== "operational" && previous?.dataset?.state !== overall ? Boolean(data) : previous ? previous.open : false;
  const focusId = document.activeElement?.id;
  const focused = document.activeElement?.closest?.("[data-service-refresh]");
  const note = serviceStatus.error || data?.error || (data?.stale || expired && data ? "Status information is stale or has no reliable timestamp. Refreshing the feed does not make an old report current." : "");
  box.innerHTML = `<p class="service-status-summary"><span class="service-state-dot state-${overall}" aria-hidden="true"></span><strong>${summary}</strong>${serviceStatus.pending ? '<span class="muted">Checking…</span>' : ""}</p>
    ${note ? `<p class="muted service-status-note">${escapeHtml(note)}</p>` : ""}
    ${data?.message && overall !== "operational" && !unknown ? `<p class="muted">${escapeHtml(data.message)}</p>` : ""}
    <details class="service-status-details" data-state="${overall}" ${expanded ? "open" : ""}><summary id="service-status-expand">View five services</summary><ul>${rows.map(row => `<li><div><strong>${row.name}</strong><span class="service-state state-${row.status}"><span class="service-state-dot" aria-hidden="true"></span>${SERVICE_STATUS_LABELS[row.status]}</span></div>${row.details ? `<p>${escapeHtml(row.details)}</p>` : ""}</li>`).join("")}</ul></details>
    <div class="service-status-foot"><p>Last successful retrieval: ${serviceStatusTimestamp(data?.fetched_at)}<br>iBroadcast report: ${serviceStatusTimestamp(data?.reported_at)}<br>Last feed attempt: ${serviceStatusTimestamp(data?.checked_at)}</p><a id="service-status-official" href="https://status.ibroadcast.com/" target="_blank" rel="noopener noreferrer">Official status page ↗</a></div><p class="muted service-status-cadence">Checks about every five minutes while Overview is visible. Reports older than 15 minutes are treated as unknown. Times are shown in your local time zone. Missing status does not mean iBroadcast is down.</p>`;
  const button = document.querySelector("[data-service-refresh]");
  if (button) { button.setAttribute("aria-disabled", String(Boolean(serviceStatus.pending))); button.textContent = serviceStatus.pending ? "Checking…" : "Refresh"; }
  if (["service-status-expand", "service-status-official"].includes(focusId)) document.querySelector(`#${focusId}`)?.focus({preventScroll: true});
  if (focused && button && !button.disabled) button.focus({preventScroll: true});
  const key = `${overall}/${note}`;
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
      serviceStatus.data = data; serviceStatus.error = "";
    } catch {
      serviceStatus.error = "The public status feed could not be checked. This does not mean iBroadcast is down.";
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
