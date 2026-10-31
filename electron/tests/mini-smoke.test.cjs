"use strict";
const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const test = require("node:test");
const {closeFromRenderer, waitForNativeState} = require("../mini-smoke.cjs");

test("return to main completes when closing destroys the renderer's pending evaluation", async () => {
  const view = new EventEmitter();
  let destroyed = false;
  view.isDestroyed = () => destroyed;
  await closeFromRenderer(view, () => {
    destroyed = true;
    view.emit("closed");
    return new Promise(() => {});
  });
  assert.equal(destroyed, true);
});

test("return to main still requires a native close after renderer acknowledgement", async () => {
  const view = new EventEmitter();
  view.isDestroyed = () => false;
  let completed = false;
  const returning = closeFromRenderer(view, () => undefined).then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  view.emit("closed"); await returning;
  assert.equal(completed, true);
});

test("a failed renderer command in a live window is not hidden", async () => {
  const view = new EventEmitter();
  view.isDestroyed = () => false;
  await assert.rejects(closeFromRenderer(view, () => { throw Error("command failed"); }), /command failed/);
  assert.equal(view.listenerCount("closed"), 0);
});

test("late native focus settles before another window command", async () => {
  let focused = false, completed = false;
  const waiting = waitForNativeState(() => focused, "focus").then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  focused = true; await waiting;
  assert.equal(completed, true);
});

test("an unavailable native state fails with a bounded, specific error", async () => {
  await assert.rejects(waitForNativeState(() => false, "main-window focus", 0), /main-window focus/);
});
