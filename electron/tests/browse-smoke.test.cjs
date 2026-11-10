"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const {inspectMenuTargets} = require("../browse-smoke.cjs");

function renderer({covered = false, width = 420, height = 550} = {}) {
  const rect = (top, h) => ({x: 116, y: top, width: 200, height: h,
    top, bottom: top + h, left: 116, right: 316, toJSON() {return {top, height: h};}});
  const menu = {scrollTop: 0, clientHeight: 200, scrollHeight: 360,
    getBoundingClientRect: () => rect(80, 200)};
  const controls = [0, 120, 240].map((offset, index) => ({
    id: "choice-" + index, tagName: "LABEL",
    getClientRects: () => [1],
    getBoundingClientRect: () => rect(90 + offset - menu.scrollTop, 36),
    contains(hit) {return hit === this;},
    scrollIntoView() {
      const r = this.getBoundingClientRect();
      if (r.bottom > 280) menu.scrollTop += r.bottom - 280;
      if (r.top < 80) menu.scrollTop -= 80 - r.top;
    },
  }));
  menu.querySelectorAll = () => controls;
  const toolbar = {getBoundingClientRect: () => rect(100, 140)};
  const overlay = {tagName: "DIV", id: "toolbar-overlay", className: ""};
  const document = {
    getElementById: () => menu,
    querySelector: () => toolbar,
    elementFromPoint(x, y) {
      if (covered || y < 80 || y >= 280) return overlay;
      return controls.find(c => {const r = c.getBoundingClientRect();return y >= r.top && y < r.bottom;}) || overlay;
    },
  };
  const run = () => vm.runInNewContext(`(${inspectMenuTargets.toString()})('theme-menu')`, {
    document, innerWidth: width, innerHeight: height, scrollY: 96,
  });
  return {run, document, controls, menu};
}

test("clipped menu choices inside the viewport are exposed and all hit-tested", async () => {
  for (const width of [420, 761, 1280]) {
    const p = renderer({width});
    const last = p.controls.at(-1), r = last.getBoundingClientRect();
    assert.ok(r.top + r.height / 2 < 550, "The old viewport-only check includes this clipped choice");
    assert.equal(last.contains(p.document.elementFromPoint(r.x + r.width / 2, r.top + r.height / 2)), false);
    const result = await p.run();
    assert.equal(result.ok, true);
    assert.equal(result.checked, 3, "Clipped choices must be checked, never skipped");
    assert.ok(result.overlaps > 0, "Keep the sticky-toolbar overlap coverage");
    assert.ok(p.menu.scrollTop > 0);
  }
});

test("an actually overlaid menu choice fails immediately with the blocking element", async () => {
  const p = renderer({covered: true});
  const result = await p.run();
  assert.equal(result.ok, false);
  assert.equal(result.checked, 1, "Do not retry a failed hit or skip to another choice");
  assert.equal(result.blocked, "choice-0");
  assert.equal(result.hit.id, "toolbar-overlay");
  assert.equal(result.viewport.width, 420);
  assert.equal(result.menuScroll.total, 360);
});

test("an empty menu cannot pass without a hit-tested choice", async () => {
  const p = renderer();p.menu.querySelectorAll = () => [];
  assert.equal((await p.run()).ok, false);
});
