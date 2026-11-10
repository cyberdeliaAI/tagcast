"use strict";

// Read-only windows over compact summaries. Group overviews may explicitly supply a bounded loader.
const continuousBrowsers = new Map();
// Sixty cards form complete rows at every existing grid breakpoint (2, 3, 4 or 5 columns).
class ContinuousBrowse {
  constructor(name, screen) {
    continuousBrowsers.set(name, this);
    this.name = name; this.screen = screen; this.batch = 60; this.count = 60;
    this.items = []; this.key = null; this.scope = null; this.heights = new Map();
    this.mounted = new Set(); this.pendingCount = null; this.scheduled = false;
    try { this.enabled = localStorage.getItem(`tagcast-${name}-continuous`) === "true"; }
    catch { this.enabled = false; }
    window.addEventListener("scroll", () => this.schedule(), {passive: true});
    window.addEventListener("resize", () => this.resize(), {passive: true});
  }
  setEnabled(enabled) {
    this.enabled = enabled; this.clear();
    try { localStorage.setItem(`tagcast-${this.name}-continuous`, String(enabled)); } catch { /* Memory-only fallback. */ }
  }
  clear() {
    this.key = null; this.contextKey = null; this.scope = null; this.pendingCount = null; this.count = this.batch;
    this.items = []; this.heights.clear(); this.mounted.clear(); this.estimate = 0;
  }
  discardStale(scope) { if (this.scope && this.scope !== scope) this.clear(); }
  restore(count) {
    this.pendingCount = Number.isSafeInteger(count) && count > 0 ? Math.min(count, 100000) : this.batch;
  }
  selection(items) { return items.slice(0, this.count); }
  active() { return state.screen === this.screen && (!this.isActive || this.isActive()); }
  update({items, key, scope, host, footer, layout, render, empty, changed, total = items.length, loadMore = null, auto = true, message = ""}) {
    const identity = `${key}\n${items.map(item => String(this.name === "artists" ? item[0] : item.id ?? item.key)).join("\n")}`;
    const id = item => String(this.name === "artists" ? item[0] : item.id ?? item.key);
    const grows = this.items.length > 0 && this.contextKey === key && this.scope === scope && items.length > this.items.length
      && this.items.every((item, index) => id(item) === id(items[index]));
    const reset = this.scope !== scope || this.key !== identity && !grows;
    const previousCount = this.renderedCount || 0;
    const previousChunks = Math.ceil(previousCount / this.batch);
    // A partial last row must be repainted when its server prefix grows.
    const append = previousCount % this.batch === 0 && (this.revealing || grows) && !reset && this.host === host && this.layout === layout && host.insertAdjacentHTML;
    if (reset) {
      this.count = this.batch; this.heights.clear(); this.estimate = 0;
      this.key = identity; this.scope = scope;
    }
    this.contextKey = key; this.key = identity;
    if (this.pendingCount !== null) { this.count = this.pendingCount; this.pendingCount = null; }
    this.count = Math.min(items.length, Math.max(this.batch, this.count));
    this.renderedCount = this.count;
    Object.assign(this, {items, host, footer, layout, render, changed, total, loadMore, auto, message});
    host.className = "continuous-browse";
    this.width = host.getBoundingClientRect().width;
    const chunks = Math.ceil(this.count / this.batch);
    const start = append ? previousChunks : 0;
    const placeholders = chunks ? Array.from({length: chunks - start}, (_, offset) => {
      const index = start + offset;
      const height = this.heights.get(index) || this.estimate || 1;
      return `<div data-continuous-chunk="${index}" aria-hidden="true" style="height:${height}px"></div>`;
    }).join("") : empty;
    if (append) host.insertAdjacentHTML("beforeend", placeholders);
    else { this.mounted.clear(); host.innerHTML = placeholders; }
    // Paint the first chunk before measuring placeholders; history may restore a distant chunk next.
    if (chunks && !append) this.mount(0);
    this.renderFooter(); this.refresh();
  }
  node(index) { return this.host?.querySelector(`[data-continuous-chunk="${index}"]`); }
  mount(index) {
    const node = this.node(index);
    if (!node || this.mounted.has(index)) return;
    node.className = `${this.layout} continuous-browse-chunk`;
    node.style.height = ""; node.removeAttribute("aria-hidden");
    node.innerHTML = this.render(this.items.slice(index * this.batch, Math.min(this.count, (index + 1) * this.batch)));
    this.mounted.add(index);
    const height = node.getBoundingClientRect().height;
    if (height > 0) { this.heights.set(index, height); if (!index) this.estimate = height; }
  }
  renderFooter() {
    this.footer.innerHTML = `<span role="status">${TagcastI18n.html("continuous.progress", {shown: this.count, total: this.total})}</span>`
      + (this.count < this.total ? `<button type="button" class="button small" data-continuous-more="${this.name}">${TagcastI18n.html("continuous.more")}</button>` : "") + this.message;
  }
  more() {
    if (!this.enabled || !this.active() || this.count >= this.total) return;
    if (this.count >= this.items.length && this.loadMore) {
      const focused = document.activeElement?.dataset?.continuousMore === this.name;
      return this.loadMore().then(() => {
        if (focused && this.active()) {
          const target = this.footer.querySelector("[data-continuous-more]") || this.footer;
          if (target === this.footer) target.setAttribute("tabindex", "-1");
          target.focus({preventScroll: true});
        }
      });
    }
    const focused = document.activeElement?.dataset?.continuousMore === this.name;
    // Reuse the ordinary render so selection labels/history reflect the exact revealed scope.
    this.count = Math.min(this.items.length, this.count + this.batch);
    this.revealing = true;
    try { this.changed(); } finally { this.revealing = false; }
    if (focused) {
      const target = this.footer.querySelector("[data-continuous-more]") || this.footer;
      if (target === this.footer) target.setAttribute("tabindex", "-1");
      target.focus({preventScroll: true});
    }
  }
  resize() {
    if (!this.enabled || !this.active() || !this.host) return;
    // Placeholder heights depend on the column count and wrapped titles. Re-measure
    // after a width change, retaining the visible chunk's relative scroll position.
    const width = this.host.getBoundingClientRect().width;
    if (width === this.width) { this.schedule(); return; }
    let anchor;
    for (const index of this.mounted) {
      const rect = this.node(index).getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < window.innerHeight) {
        anchor = {index, fraction: Math.max(0, -rect.top / rect.height), offset: Math.max(0, rect.top)}; break;
      }
    }
    this.heights.clear(); this.estimate = 0; this.width = width;
    this.changed();
    if (anchor) {
      const rect = this.node(anchor.index)?.getBoundingClientRect();
      if (rect) window.scrollTo({top: Math.max(0, window.scrollY + rect.top + rect.height * anchor.fraction - anchor.offset)});
    }
    this.schedule();
  }
  schedule() {
    if (this.scheduled || !this.enabled || !this.active()) return;
    this.scheduled = true;
    // A frame-sized timeout also works in browser/desktop environments without an observer.
    setTimeout(() => { this.scheduled = false; this.refresh(); }, 16);
  }
  refresh() {
    if (!this.enabled || !this.active() || !this.host || !this.items.length) return;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const chunks = Math.ceil(this.count / this.batch), wanted = new Set();
    for (let index = 0; index < chunks; index++) {
      const node = this.node(index);
      if (!node) continue;
      if (!this.mounted.has(index)) node.style.height = `${this.heights.get(index) || this.estimate || 1}px`;
      const rect = node.getBoundingClientRect();
      if (rect.bottom >= -600 && rect.top <= height + 600) wanted.add(index);
      // Never remove the user's focused card, checkbox or open action control.
      if (node.contains(document.activeElement)) wanted.add(index);
    }
    for (const index of [...this.mounted]) {
      if (wanted.has(index)) continue;
      const node = this.node(index);
      this.heights.set(index, node.getBoundingClientRect().height);
      node.innerHTML = ""; node.className = ""; node.setAttribute("aria-hidden", "true");
      node.style.height = `${this.heights.get(index)}px`; this.mounted.delete(index);
    }
    for (const index of wanted) this.mount(index);
    // Read fresh geometry after mounting; initially-short placeholders must not load everything.
    if (this.footer.getBoundingClientRect().top < height + 500 && this.footer.getBoundingClientRect().bottom > 0) this.scheduleMore();
  }
  scheduleMore() {
    if (this.moreScheduled || !this.auto || this.count >= this.total) return;
    this.moreScheduled = true;
    const key = this.key, scope = this.scope;
    setTimeout(() => {
      this.moreScheduled = false;
      if (this.key === key && this.scope === scope && this.enabled && this.auto && this.active() && this.footer.getBoundingClientRect().top < (window.innerHeight || document.documentElement.clientHeight) + 500) this.more();
    }, 80);
  }
}
const albumContinuous = new ContinuousBrowse("albums", "albums");
const artistContinuous = new ContinuousBrowse("artists", "artists");
document.addEventListener("click", event => {
  const button = event.target.closest("[data-continuous-more]");
  if (button) continuousBrowsers.get(button.dataset.continuousMore)?.more();
});
