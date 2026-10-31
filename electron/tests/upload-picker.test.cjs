"use strict";
const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const {test} = require("node:test");
const {installUploadPicker} = require("../upload-picker.cjs");
const origin = "http://127.0.0.1:8912";

function fixture(choose = async () => ({filePaths: ["/chosen/music.flac"]})) {
  const owner = new EventEmitter(), contents = new EventEmitter(), handlers = new Map(), calls = [];
  owner.webContents = contents;
  contents.mainFrame = {}; contents.isDestroyed = () => false; contents.getURL = () => origin + "/#/uploads";
  installUploadPicker(owner, origin, {ipcMain: {handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name)},
    dialog: {showOpenDialog: async (parent, options) => { assert.equal(parent, owner); calls.push(options); return choose(); }}});
  const event = {sender: contents, senderFrame: contents.mainFrame};
  return {owner, contents, handlers, calls, event, choose: (kind = "files", from = event) => handlers.get("uploads:choose")(from, kind)};
}

test("upload picker exposes only a user-chosen file/folder dialog", async () => {
  const f = fixture();
  assert.deepEqual(await f.choose(), {paths: ["/chosen/music.flac"]});
  assert.deepEqual(f.calls[0].properties, ["openFile", "multiSelections"]);
  await f.choose("folder"); assert.deepEqual(f.calls[1].properties, ["openDirectory"]);
  f.owner.emit("closed"); assert.equal(f.handlers.size, 0);
});

test("foreign frames, remote pages and arbitrary options cannot open the picker", async () => {
  const f = fixture();
  for (const event of [{sender: {}, senderFrame: f.contents.mainFrame}, {sender: f.contents, senderFrame: {}}]) assert.ok((await f.choose("files", event)).error);
  for (const kind of [null, {}, "https://example.com", "saveFile"]) assert.ok((await f.choose(kind)).error);
  f.contents.getURL = () => "https://example.com";
  assert.ok((await f.choose()).error); assert.equal(f.calls.length, 0);
});

test("cancellation and invalid paths return no selected files", async () => {
  for (const result of [{canceled: true}, {filePaths: ["/bad\npath"]}, {filePaths: ["x".repeat(4097)]}, {filePaths: Array(101).fill("/a")}]) {
    const f = fixture(async () => result), answer = await f.choose();
    assert.equal(answer.paths?.length || 0, 0);
  }
});

test("only one dialog opens and navigation discards a late file selection", async () => {
  let release; const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const first = f.choose(); assert.ok((await f.choose()).error);
  f.contents.emit("did-start-navigation", {}, origin, false, true);
  release({filePaths: ["/old/music.flac"]});
  assert.deepEqual(await first, {paths: []}); assert.equal(f.calls.length, 1);
});

test("native dialog errors are sanitized", async () => {
  const f = fixture(async () => { throw new Error("private/path/token"); });
  const result = await f.choose(); assert.match(result.error, /Enter complete paths/); assert.doesNotMatch(result.error, /private/);
});
