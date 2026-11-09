"use strict";

// Exercise the production windowing controller with deterministic document geometry.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {readFileSync} = require("node:fs");
const path = require("node:path");

function fixture(total = 1200, storage = {}) {
  const timers = [], handlers = {}, nodes = new Map();
  const document = {activeElement: null, documentElement: {clientHeight: 500}, addEventListener() {}};
  const window = {innerHeight: 500, scrollY: 0, addEventListener(name, fn) { (handlers[name] ||= []).push(fn); },
    scrollTo({top}) { this.scrollY = top; }};
  let width = 1000, columns = 4, footerHTML = "", button;
  const makeNode = index => ({index, style: {}, className: "", innerHTML: "", hidden: true,
    setAttribute() { this.hidden = true; }, removeAttribute() { this.hidden = false; },
    contains(value) { return value?.owner === this; },
    getBoundingClientRect() {
      const height = node => node.style.height ? Number.parseFloat(node.style.height)
        : Math.ceil((node.innerHTML.match(/card:/g) || []).length / columns) * 100;
      const top = 300 + [...nodes.values()].filter(node => node.index < index).reduce((n, node) => n + height(node) + 27, 0) - window.scrollY;
      return {top, bottom: top + height(this), height: height(this), width};
    }});
  const host = {className: "", getBoundingClientRect: () => ({width}),
    querySelector(selector) { return nodes.get(Number(selector.match(/"(\d+)"/)[1])); },
    set innerHTML(value) { nodes.clear(); this.insertAdjacentHTML("beforeend", value); },
    insertAdjacentHTML(_, value) {
      for (const match of value.matchAll(/data-continuous-chunk="(\d+)"[^>]*height:([\d.]+)px/g)) {
        const node = makeNode(Number(match[1])); node.style.height = `${match[2]}px`; nodes.set(node.index, node);
      }
    }};
  const footer = {set innerHTML(value) {
    footerHTML = value; button = value.includes("data-continuous-more") ? {dataset: {continuousMore: "albums"}, focus() { document.activeElement = this; }} : null;
  }, querySelector: () => button, setAttribute() {}, focus() { document.activeElement = this; },
  getBoundingClientRect() {
    const last = [...nodes.values()].at(-1)?.getBoundingClientRect(); const top = last ? last.bottom + 27 : 300;
    return {top, bottom: top + 40};
  }};
  const context = vm.createContext({window, document, state: {screen: "albums"},
    localStorage: {getItem: key => storage[key], setItem: (key, value) => { storage[key] = value; }},
    TagcastI18n: {html: (key, args) => `${key}:${JSON.stringify(args || {})}`},
    setTimeout(fn, delay) { timers.push({fn, delay}); }});
  vm.runInContext(readFileSync(path.join(__dirname, "../src/tagcast/static/continuous-browse.js"), "utf8"), context);
  const controller = vm.runInContext("albumContinuous", context);
  let key = "query", scope = {};
  let items = Array.from({length: total}, (_, id) => ({id}));
  const render = rows => rows.map(row => `card:${row.id};`).join("");
  const update = () => controller.update({items, key, scope, host, footer, layout: "album-grid", render, empty: "empty", changed: update});
  controller.setEnabled(true); update();
  return {controller, context, nodes, window, document, footer, storage, update,
    append(size) { items = Array.from({length: size}, (_, id) => ({id})); controller.restore(size); update(); },
    get footerHTML() { return footerHTML; }, get button() { return button; },
    cards: () => [...nodes.values()].map(node => node.innerHTML).join("").match(/card:\d+/g) || [],
    query(value) { key = value; update(); }, replace() { scope = {}; update(); },
    flush(delay) { for (const timer of timers.splice(0)) { if (timer.delay === delay) timer.fn(); else timers.push(timer); } },
    resize(value, cols) { width = value; columns = cols; for (const handler of handlers.resize) handler(); }};
}

test("continuous browsing paints a bounded window and restores earlier cards without losing scroll height", () => {
  const f = fixture(18739);
  for (let i = 0; i < 9; i++) f.controller.more();
  assert.equal(f.controller.count, 600);
  assert.equal(f.cards().length, 60, "Offscreen summaries do not become card elements");
  const before = f.footer.getBoundingClientRect().top;
  f.window.scrollY = 12000; f.controller.refresh();
  assert.ok(f.cards().length <= 120);
  assert.ok(!f.cards().includes("card:0"));
  assert.equal(f.footer.getBoundingClientRect().top + f.window.scrollY, before);
  f.window.scrollY = 0; f.controller.refresh();
  assert.equal(f.cards()[0], "card:0");
  assert.equal(new Set(f.cards()).size, f.cards().length);
  assert.equal(f.footer.getBoundingClientRect().top, before);
});

test("focus pins a card's chunk, and keyboard Show more retains focus through completion", () => {
  const f = fixture(185); f.controller.more();
  f.document.activeElement = {owner: f.nodes.get(0)};
  f.window.scrollY = 2000; f.controller.refresh();
  assert.ok(f.cards().includes("card:0"));
  const pinned=f.nodes.get(0); f.controller.more();
  assert.equal(f.nodes.get(0),pinned,"Auto-reveal retains the existing card elements and their focus");
  f.button?.focus(); f.controller.more();
  assert.equal(f.controller.count, 185);
  assert.equal(f.document.activeElement, f.footer);
  assert.doesNotMatch(f.footerHTML, /data-continuous-more/);
  const g = fixture(); g.button.focus(); g.controller.more();
  assert.equal(g.document.activeElement, g.button);
});

test("automatic reveal is bounded, and stale scheduled work cannot affect another query, library or screen", () => {
  const f = fixture();
  f.window.scrollY = 1400; f.controller.refresh(); f.flush(80);
  assert.equal(f.controller.count, 120);
  f.controller.scheduleMore(); f.query("new search"); f.flush(80);
  assert.equal(f.controller.count, 60);
  f.controller.scheduleMore(); f.replace(); f.flush(80);
  assert.equal(f.controller.count, 60);
  f.controller.scheduleMore(); vm.runInContext('state.screen="album"', f.context); f.flush(80);
  assert.equal(f.controller.count, 60);
});

test("history restores revealed scope and resizing re-measures placeholder heights", () => {
  const f = fixture();
  f.controller.restore(300); f.update();
  assert.equal(f.controller.count, 300);
  assert.equal(f.nodes.size, 5);
  const before = f.footer.getBoundingClientRect().top;
  f.resize(500, 2);
  assert.equal(f.controller.count, 300);
  assert.ok(f.footer.getBoundingClientRect().top > before * 1.8);
  f.query("filtered"); assert.equal(f.controller.count, 60);
  f.controller.restore(1000000); f.update();
  assert.equal(f.controller.count, 1200, "Restored scope is bounded by the actual results");
});

test("empty and small lists terminate; preferences remain optional and storage failure is harmless", () => {
  const f = fixture(0);
  assert.equal(f.nodes.size, 0); assert.equal(f.controller.count, 0);
  assert.doesNotMatch(f.footerHTML, /data-continuous-more/);
  const small = fixture(5); small.controller.more();
  assert.equal(small.controller.count, 5); assert.equal(small.cards().length, 5);
  const broken = new Proxy({}, {get() { throw Error("Storage blocked"); }, set() { throw Error("Storage blocked"); }});
  const safe = fixture(5, broken); assert.equal(safe.controller.enabled, true);
  safe.controller.setEnabled(false); assert.equal(safe.controller.enabled, false);
  assert.equal(safe.controller.items.length, 0);
  assert.equal(safe.controller.scope, null);
  small.controller.discardStale({});
  assert.equal(small.controller.items.length, 0, "An inactive page releases the previous library");
  assert.equal(small.controller.scope, null);
});


test("growing server prefixes preserve mounted cards and keep the DOM bounded", () => {
  const f = fixture(60), first = f.nodes.get(0);
  for (let count = 120; count <= 600; count += 60) f.append(count);
  assert.equal(f.controller.count, 600);
  assert.equal(f.nodes.get(0), first);
  assert.equal(f.cards().length, 60);
  f.window.scrollY = 12000; f.controller.refresh();
  assert.ok(f.cards().length <= 120);
  assert.equal(new Set(f.cards()).size, f.cards().length);
  f.window.scrollY = 0; f.controller.refresh();
  assert.equal(f.cards()[0], "card:0");
});

test("a previously scheduled reveal stops when its loader disables automatic recovery", () => {
  const f = fixture(180);
  f.window.scrollY = 1400; f.controller.refresh();
  f.controller.auto = false;
  f.flush(80);
  assert.equal(f.controller.count, 60);
  f.controller.more();
  assert.equal(f.controller.count, 120, "Manual recovery remains available");
});
