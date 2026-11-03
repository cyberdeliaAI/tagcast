"use strict";

// Interface text catalogs and the TagcastI18n runtime, without a browser or network.
const assert = require("node:assert/strict");
const {readFileSync, readdirSync} = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const staticDir = path.join(root, "src/tagcast/static");
const i18nDir = path.join(staticDir, "i18n");
const read = file => readFileSync(file, "utf8");
const manifest = JSON.parse(read(path.join(i18nDir, "manifest.json")));
const english = JSON.parse(read(path.join(i18nDir, "en.json")));
const catalogs = Object.fromEntries(manifest.languages.map(l => [l.tag, JSON.parse(read(path.join(i18nDir, `${l.tag}.json`)))]));
const PLURAL = /_(zero|one|two|few|many|other)$/;
const KEY = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9_]*)+$/;
const placeholders = value => [...value.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:,\s*number\s*)?\}\}/g)].map(m => m[1]).sort();
const base = key => key.replace(PLURAL, "");
const families = messages => {
  const result = new Map();
  for (const key of Object.keys(messages)) {
    const name = base(key);
    if (!result.has(name)) result.set(name, []);
    result.get(name).push(key);
  }
  return result;
};

test("catalog files are listed in the manifest, valid and complete for English", () => {
  const files = readdirSync(i18nDir).filter(name => name.endsWith(".json") && name !== "manifest.json").sort();
  assert.deepEqual(files, manifest.languages.map(l => `${l.tag}.json`).sort());
  assert.equal(manifest.source, "en");
  assert.equal(manifest.languages.find(l => l.tag === "en").status, "complete");
  assert.equal(new Set(manifest.languages.map(l => l.tag)).size, manifest.languages.length);
  for (const language of manifest.languages) {
    assert.ok(["complete", "preview"].includes(language.status), language.tag);
    assert.ok(["ltr", "rtl"].includes(language.dir), language.tag);
    assert.doesNotThrow(() => new Intl.NumberFormat(language.format), language.tag);
    assert.ok(language.name && !/[<>]/.test(language.name));
  }
});

test("catalogs hold plain text only: no markup, nesting, unescaped values or malformed placeholders", () => {
  for (const [tag, messages] of Object.entries(catalogs)) {
    const keys = Object.keys(messages);
    assert.deepEqual(keys, [...keys].sort(), `${tag}.json keys are sorted for stable diffs`);
    for (const [key, value] of Object.entries(messages)) {
      assert.match(base(key), KEY, `${tag}: ${key}`);
      assert.equal(typeof value, "string", `${tag}: ${key}`);
      assert.ok(value.trim(), `${tag}: ${key} is empty`);
      assert.doesNotMatch(value, /[<>]/, `${tag}: ${key} contains markup`);
      assert.doesNotMatch(value, /\{\{-|\$t\(|\{\{\s*\}\}/, `${tag}: ${key} uses an unsupported i18next feature`);
      assert.equal((value.match(/\{\{/g) || []).length, (value.match(/\}\}/g) || []).length, `${tag}: ${key} braces`);
      assert.equal(value.replace(/\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*(?:,\s*number\s*)?\}\}/g, "").includes("{{"), false, `${tag}: ${key}`);
      assert.doesNotMatch(value, /[\u0000-\u0008\u000b-\u001f\u007f]/, `${tag}: ${key} control characters`);
    }
  }
});

test("translations use only English keys, the same placeholders and every plural form their language needs", () => {
  const englishFamilies = families(english);
  for (const [tag, messages] of Object.entries(catalogs)) {
    if (tag === "en") continue;
    for (const [name, keys] of families(messages)) {
      assert.ok(englishFamilies.has(name), `${tag}: unknown key ${name}`);
      const expected = [...new Set(englishFamilies.get(name).flatMap(key => placeholders(english[key])))].sort();
      for (const key of keys) {
        for (const placeholder of placeholders(messages[key])) assert.ok(expected.includes(placeholder), `${tag}: ${key} adds {{${placeholder}}}`);
        if (!englishFamilies.get(name).some(k => PLURAL.test(k))) assert.deepEqual(placeholders(messages[key]), placeholders(english[key]), `${tag}: ${key}`);
      }
      if (englishFamilies.get(name).some(k => PLURAL.test(k))) {
        const needed = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
        for (const category of needed) assert.ok(keys.includes(`${name}_${category}`), `${tag}: ${name}_${category} is missing`);
        for (const key of keys) assert.ok(PLURAL.test(key), `${tag}: ${key} must use a plural suffix like English`);
      }
    }
  }
});

// Keys are always literal strings in code. A key is "referenced" when it is passed directly to
// TagcastI18n or written in data-i18n; it is "used" when it appears as a literal anywhere, or
// when a template like `mini.${name}` builds it from a literal suffix in the same file.
const scriptFiles = () => [...readdirSync(staticDir).filter(f => f.endsWith(".js") && f !== "i18n-en.js").map(f => path.join(staticDir, f)),
  path.join(staticDir, "mini-player/view.js")];
const KEY_LITERAL = /["'`]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)["'`]/g;
function keyReferences() {
  const referenced = new Map(), literals = new Set(), dynamic = [];
  const refer = (key, where) => { if (!referenced.has(key)) referenced.set(key, where); };
  for (const file of scriptFiles()) {
    const source = read(file), name = path.basename(file);
    for (const m of source.matchAll(/TagcastI18n\.(?:text|html|englishText|hasKey)\(\s*"([^"]+)"/g)) refer(m[1], name);
    for (const m of source.matchAll(/TagcastI18n\.(?:text|html|englishText)\(\s*[^"(),]+\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)) { refer(m[1], name); refer(m[2], name); }
    for (const m of source.matchAll(/TagcastI18n\.failure\(\s*"([^"]+)"/g)) { refer(`errors.${m[1]}`, name); literals.add(`errors.${m[1]}`); }
    // Codes passed to failure() are not keys themselves (their text is errors.<code>).
    for (const m of source.replace(/TagcastI18n\.failure\(\s*"[^"]+"/g, "").matchAll(KEY_LITERAL)) literals.add(m[1]);
    for (const m of source.matchAll(/`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)*\.)\$\{/g)) dynamic.push({prefix: m[1], source});
  }
  const html = read(path.join(staticDir, "index.html"));
  for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) { refer(m[1], "index.html"); literals.add(m[1]); }
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const pair of m[1].split(";")) { refer(pair.split("=")[1], "index.html"); literals.add(pair.split("=")[1]); }
  // Tagcast Desktop: desktop.<name> texts are sent as a set (language.js) and read by name in
  // electron/desktop-text.cjs; error codes returned to the page are translated with errorText().
  for (const name of Object.keys(require(path.join(root, "electron/desktop-text.cjs")).ENGLISH)) literals.add(`desktop.${name}`);
  for (const file of readdirSync(path.join(root, "electron")).filter(f => f.endsWith(".cjs"))) {
    for (const m of read(path.join(root, "electron", file)).matchAll(/code: "([a-z0-9_.]+)"/g)) { refer(`errors.${m[1]}`, file); literals.add(`errors.${m[1]}`); }
  }
  for (const file of readdirSync(path.join(root, "src/tagcast")).filter(f => f.endsWith(".py"))) {
    for (const m of read(path.join(root, "src/tagcast", file)).matchAll(/code="([a-z0-9_.]+)"/g)) { refer(`errors.${m[1]}`, file); literals.add(`errors.${m[1]}`); }
  }
  const used = key => literals.has(key) || dynamic.some(({prefix, source}) => key.startsWith(prefix)
    && new RegExp(`["'\`]${key.slice(prefix.length).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`).test(source));
  // Any literal that looks like a key in a namespace English uses must be a real key, so a
  // typo in a key table (["show-tags", "nav.sidebar.tagz"]) fails here, not at runtime.
  const namespaces = new Set(Object.keys(english).map(key => key.split(".")[0]));
  const plausible = [...literals].filter(key => namespaces.has(key.split(".")[0])
    && !/\.(?:c?js|json|css|html|png|svg|py|md|csv|txt|m3u8?)$/.test(key));
  return {referenced, used, plausible};
}

test("every referenced key exists in English and every English key is used", () => {
  const {referenced, used, plausible} = keyReferences(), known = new Set(Object.keys(english).map(base));
  for (const [key, where] of referenced) assert.ok(known.has(key), `Missing English text for ${key} (${where})`);
  for (const key of plausible) assert.ok(known.has(key), `"${key}" looks like an interface text key but en.json has no such key`);
  for (const key of known) assert.ok(used(key), `Unused English key ${key}`);
});

test("desktop texts in en.json are exactly the built-in English texts of the desktop app", () => {
  const {ENGLISH} = require(path.join(root, "electron/desktop-text.cjs"));
  const fromCatalog = Object.fromEntries(Object.entries(english).filter(([key]) => key.startsWith("desktop.")).map(([key, value]) => [key.slice(8), value]));
  assert.deepEqual(fromCatalog, {...ENGLISH});
});

test("every complete language translates every English key", () => {
  for (const language of manifest.languages.filter(l => l.tag !== "en" && l.status === "complete")) {
    const translated = new Set(Object.keys(catalogs[language.tag]).map(base));
    const missing = [...new Set(Object.keys(english).map(base))].filter(key => !translated.has(key));
    assert.deepEqual(missing, [], `Missing ${language.name} translations`);
  }
  assert.ok(manifest.languages.some(l => l.tag === "nl" && l.status === "complete"));
});

test("translated text inside HTML templates is always escaped", () => {
  for (const file of scriptFiles()) {
    read(file).split("\n").forEach((line, index) => {
      if (/`[^`]*<[a-z]/i.test(line) && line.includes("${TagcastI18n.text(")) {
        assert.fail(`${path.basename(file)}:${index + 1} uses TagcastI18n.text() inside an HTML template; use TagcastI18n.html()`);
      }
    });
  }
});

test("static English markup matches en.json, so first paint and fallback are identical", () => {
  const html = read(path.join(staticDir, "index.html"));
  const decode = value => value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  let checked = 0;
  for (const tag of html.matchAll(/<([a-z0-9]+)\b([^>]*)>([^<]*)/g)) {
    const attributes = Object.fromEntries([...tag[2].matchAll(/([a-z0-9:-]+)="([^"]*)"/g)].map(m => [m[1], decode(m[2])]));
    if (attributes["data-i18n"]) { assert.equal(decode(tag[3]).trim(), english[attributes["data-i18n"]], attributes["data-i18n"]); checked++; }
    for (const pair of (attributes["data-i18n-attr"] || "").split(";").filter(Boolean)) {
      const [name, key] = pair.split("=");
      assert.equal(attributes[name], english[key], `${name}=${key}`); checked++;
    }
  }
  const annotations = (html.match(/data-i18n="/g) || []).length
    + [...html.matchAll(/data-i18n-attr="([^"]+)"/g)].reduce((n, m) => n + m[1].split(";").filter(Boolean).length, 0);
  assert.equal(checked, annotations, "every annotation was compared");
  assert.ok(checked > 0);
});

test("the generated English bundle is the same data as en.json and the manifest", () => {
  const context = vm.createContext({globalThis: {}});
  context.globalThis = context;
  vm.runInContext(read(path.join(staticDir, "i18n-en.js")), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.TagcastI18nEnglish.messages)), english);
  assert.deepEqual(JSON.parse(JSON.stringify(context.TagcastI18nEnglish.manifest)), manifest);
});

// A small browser stand-in: storage, a fetch for catalogs and a document root.
function runtime({stored = {}, languages = [], bundle, served = name => catalogs[name], fetcher, ready = "complete"} = {}) {
  const requests = [], warnings = [], dcl = [];
  const rootNode = {lang: "en", dir: "", style: {values: {}, setProperty(k, v) { this.values[k] = v; }, removeProperty(k) { delete this.values[k]; }}};
  const document = {documentElement: rootNode, readyState: ready, querySelectorAll: () => [],
    addEventListener(type, fn) { if (type === "DOMContentLoaded") dcl.push(fn); }};
  const timers = [];
  const context = vm.createContext({
    document, navigator: {languages}, console: {warn: message => warnings.push(message), error: message => warnings.push(String(message))},
    localStorage: {getItem: k => stored[k] ?? null, setItem: (k, v) => { stored[k] = String(v); }},
    setTimeout: (fn, delay) => { timers.push({fn, delay, cancelled: false}); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cancelled = true; }, AbortController,
    fetch: async (url, options) => {
      requests.push(url);
      if (fetcher) return fetcher(url, options);
      const tag = url.match(/^\/i18n\/([A-Za-z-]+)\.json$/)?.[1];
      const data = tag && served(tag);
      return data === undefined ? {ok: false, json: async () => ({})} : {ok: true, json: async () => structuredClone(data)};
    }, structuredClone});
  context.globalThis = context;
  if (bundle) context.TagcastI18nEnglish = bundle;
  else vm.runInContext(read(path.join(staticDir, "i18n-en.js")), context);
  vm.runInContext(read(path.join(staticDir, "i18n.js")) + "\nglobalThis.TagcastI18n = TagcastI18n;", context);
  return {i18n: context.TagcastI18n, requests, warnings, stored, root: rootNode, dcl, timers};
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("a stalled catalog times out, preserves the choice and retries without caching a late reply", async () => {
  let release, signal, calls = 0;
  const r = runtime({fetcher: (url, options) => {
    calls++;
    if (calls === 1) { signal = options.signal; return new Promise(resolve => { release = resolve; }); }
    return {ok: true, json: async () => catalogs.nl};
  }});
  const first = r.i18n.use("nl"); await settle();
  r.timers.find(t => t.delay === 10000 && !t.cancelled).fn();
  assert.equal(await first, "en"); assert.equal(signal.aborted, true);
  assert.equal(r.stored["tagcast-language"], "nl"); assert.equal(r.i18n.choice, "nl");
  assert.equal(await r.i18n.use("nl"), "nl");
  release({ok: true, json: async () => ({...catalogs.nl, "player.queue.heading": "STALE"})}); await settle();
  assert.equal(await r.i18n.use("nl"), "nl");
  assert.equal(r.i18n.text("player.queue.heading"), catalogs.nl["player.queue.heading"]);
  assert.equal(calls, 2); assert.ok(r.timers.every(t => t.cancelled));
});

test("the catalog deadline includes a stalled JSON body and settles startup fallback", async () => {
  let release, signal;
  const r = runtime({stored: {"tagcast-language": "nl"}, fetcher: (url, options) => {
    signal = options.signal; return {ok: true, json: () => new Promise(resolve => { release = resolve; })};
  }});
  await settle();
  r.timers.find(t => t.delay === 1200).fn();
  assert.equal(r.root.style.values.visibility, undefined, "the existing safety reveal still works");
  r.timers.find(t => t.delay === 10000).fn(); await settle();
  assert.equal(r.i18n.language, "en"); assert.equal(r.root.lang, "en");
  assert.equal(r.i18n.choice, "nl"); assert.equal(signal.aborted, true);
  release(catalogs.nl); await settle();
  assert.equal(r.i18n.language, "en", "late body completion cannot revive a timed-out request");
  assert.ok(r.timers.every(t => t.cancelled));
});

test("an obsolete catalog reply cannot activate or seed a later retry", async () => {
  let release, calls = 0;
  const r = runtime({fetcher: () => ++calls === 1 ? new Promise(resolve => { release = resolve; })
    : {ok: true, json: async () => catalogs.nl}});
  const old = r.i18n.use("nl"); await r.i18n.use("en");
  release({ok: true, json: async () => ({...catalogs.nl, "player.queue.heading": "STALE"})}); await old;
  assert.equal(r.i18n.language, "en");
  await r.i18n.use("nl"); assert.equal(calls, 2);
  assert.equal(r.i18n.text("player.queue.heading"), catalogs.nl["player.queue.heading"]);
});

test("unavailable and malformed catalogs clear their deadline and allow a successful retry", async () => {
  for (const failure of [() => ({ok: false}), () => { throw Error("offline"); },
    () => ({ok: true, json: async () => { throw SyntaxError("invalid JSON"); }}),
    () => ({ok: true, json: async () => []})]) {
    let fail = true;
    const r = runtime({fetcher: () => fail ? failure() : {ok: true, json: async () => catalogs.nl}});
    assert.equal(await r.i18n.use("nl"), "en"); assert.equal(r.i18n.choice, "nl");
    assert.ok(r.timers.every(t => t.cancelled));
    fail = false; assert.equal(await r.i18n.use("nl"), "nl");
    assert.ok(r.timers.every(t => t.cancelled));
  }
});

test("English renders the existing wording, chooses plural forms and never requests a catalog", () => {
  const {i18n, requests} = runtime();
  assert.equal(i18n.language, "en");
  assert.equal(i18n.text("player.queue.count", {count: 0}), "0 tracks");
  assert.equal(i18n.text("player.queue.count", {count: 1}), "1 track");
  assert.equal(i18n.text("player.queue.count", {count: 12}), "12 tracks");
  assert.equal(i18n.text("player.queue.added", {count: 1}), "Added 1 track to the queue.");
  assert.equal(i18n.text("player.queue.playingNext", {count: 3}), "Playing next: 3 tracks to the queue.");
  assert.equal(i18n.text("playback.output.buttonTitleValue", {volume: "65%", output: "System default"}), "Volume: 65% · Output: System default");
  assert.equal(i18n.text("player.queue.rowDetailsUpNext", {artist: "A", album: "B"}), "Up next · A · B");
  assert.equal(i18n.text("player.queue.heading", {count: 2}), "Play queue", "a count on an ordinary message is just a value");
  assert.equal(i18n.text("player.queue.count", {count: undefined}), "{{count}} tracks".replace("{{count}}", ""), "a missing count shows the general form, never the key");
  assert.equal(i18n.text("player.queue.count"), " tracks");
  assert.deepEqual(requests, []);
});

test("Dutch loads once, follows its own plural rules and falls back to English per key", async () => {
  const partial = {...catalogs.nl}; delete partial["player.queue.heading"]; delete partial["player.queue.count_one"];
  const {i18n, requests, stored, root} = runtime({served: tag => tag === "nl" ? partial : undefined});
  assert.equal(await i18n.use("nl"), "nl");
  assert.deepEqual(requests, ["/i18n/nl.json"]);
  assert.equal(stored["tagcast-language"], "nl");
  assert.equal(root.lang, "nl");
  assert.equal(i18n.text("player.queue.count", {count: 12}), "12 nummers");
  assert.equal(i18n.text("player.queue.count", {count: 1}), "1 nummers", "a missing _one form uses Dutch _other; CI requires every form");
  assert.equal(i18n.text("player.queue.heading"), "Play queue", "a missing key falls back to English");
  await i18n.use("nl");
  assert.equal(requests.length, 1, "a loaded catalog is reused");
  assert.equal(await i18n.use("en"), "en");
  assert.equal(i18n.text("player.queue.count", {count: 12}), "12 tracks");
});

test("values never become markup, while trusted fragments are explicit", () => {
  const {i18n} = runtime();
  const hostile = '<img src=x onerror="alert(1)">&\'';
  const html = i18n.html("player.queue.remove", {title: hostile, position: 1});
  assert.doesNotMatch(html, /<img/);
  assert.equal(html, "Remove &lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39; from play queue, position 1");
  assert.equal(i18n.text("player.queue.remove", {title: hostile, position: 1}), `Remove ${hostile} from play queue, position 1`, "plain text is for textContent and attributes");
  assert.equal(i18n.html("player.queue.removed", {title: i18n.trusted("<strong>A</strong>")}), "Removed “<strong>A</strong>” from the play queue.");
  assert.equal(i18n.html("player.queue.clear"), "Clear queue &amp; stop");
});

test("missing keys and values are reported once and never throw", () => {
  const {i18n, warnings} = runtime();
  assert.equal(i18n.text("player.unknownKey"), "player.unknownKey");
  assert.equal(i18n.text("player.unknownKey"), "player.unknownKey");
  assert.equal(i18n.text("player.queue.removed", {}), "Removed “” from the play queue.");
  assert.equal(i18n.text("player.queue.rowDetails", {artist: null, album: "B"}), " · B", "an empty metadata value is not an error");
  assert.equal(warnings.length, 2);
});

test("catalogs cannot add markup or unknown keys, and a failed load keeps English and the choice", async () => {
  const unsafe = {...catalogs.nl, "player.queue.heading": "<b>Wachtrij</b>", "player.newKey": "Nieuw"};
  const {i18n} = runtime({served: tag => tag === "nl" ? unsafe : undefined});
  await i18n.use("nl");
  assert.equal(i18n.text("player.queue.heading"), "Play queue");
  assert.equal(i18n.text("player.newKey"), "player.newKey");
  const broken = runtime({served: () => undefined});
  assert.equal(await broken.i18n.use("nl"), "en");
  assert.equal(broken.i18n.language, "en");
  assert.equal(broken.i18n.choice, "nl", "the choice is kept for the next start");
  assert.equal(broken.root.lang, "en");
});

test("the newest language choice wins when catalog requests overlap", async () => {
  const {i18n} = runtime();
  const first = i18n.use("nl"), second = i18n.use("en");
  await Promise.all([first, second]);
  assert.equal(i18n.language, "en");
  assert.equal(i18n.choice, "en");
});

test("automatic selection only picks complete translations and manual choices always win", () => {
  const preview = {manifest: {source: "en", languages: [{tag: "en", name: "English", dir: "ltr", format: "en-GB", status: "complete"},
    {tag: "nl", name: "Nederlands", dir: "ltr", format: "nl-NL", status: "preview"}]}, messages: english};
  const {i18n} = runtime({languages: ["nl-BE", "en-US"], bundle: preview});
  assert.equal(i18n.resolve("auto"), "en", "a preview language is never chosen automatically");
  assert.equal(i18n.resolve(""), "en");
  assert.equal(i18n.resolve("nl"), "nl");
  assert.equal(i18n.resolve("xx"), "en");
  const shipped = runtime({languages: ["nl-BE", "en-US"]});
  assert.equal(shipped.i18n.resolve("auto"), "nl", "the shipped Dutch translation is complete");
  assert.equal(shipped.i18n.resolve("en"), "en");
  assert.equal(runtime({languages: ["it-IT", "pt-BR"]}).i18n.resolve("auto"), "en");
});

test("the stored choice is restored before painting with one catalog request", async () => {
  const {i18n, requests, root, timers} = runtime({stored: {"tagcast-language": "nl"}});
  assert.equal(root.lang, "nl");
  assert.equal(root.style.values.visibility, "hidden");
  assert.ok(timers.some(t => t.delay === 1200), "a safety timer always reveals the page");
  await settle(); await settle();
  assert.equal(i18n.language, "nl");
  assert.equal(root.style.values.visibility, undefined);
  assert.deepEqual(requests, ["/i18n/nl.json"]);
});

test("plural rules and number placeholders follow each language, including French, Japanese and right-to-left", async () => {
  const messages = {...english, "player.queue.count_one": "{{count}} track", "player.queue.count_other": "{{count}} tracks",
    "playback.volume.value": "{{percent, number}}%"};
  const bundle = {manifest: {source: "en", languages: [{tag: "en", name: "English", dir: "ltr", format: "en-GB", status: "complete"},
    {tag: "fr", name: "Français", dir: "ltr", format: "fr-FR", status: "preview"}, {tag: "ja", name: "日本語", dir: "ltr", format: "ja-JP", status: "preview"},
    {tag: "ar", name: "العربية", dir: "rtl", format: "ar", status: "preview"}]}, messages};
  const served = {fr: {"player.queue.count_one": "{{count}} morceau", "player.queue.count_many": "{{count}} de morceaux", "player.queue.count_other": "{{count}} morceaux",
    "playback.volume.value": "{{percent, number}} %"},
  ja: {"player.queue.count_other": "{{count}}曲"}, ar: {"player.queue.heading": "قائمة التشغيل"}};
  const {i18n, root} = runtime({bundle, served: tag => served[tag]});
  await i18n.use("fr");
  assert.equal(i18n.text("player.queue.count", {count: 0}), "0 morceau", "French treats zero as singular");
  assert.equal(i18n.text("playback.volume.value", {percent: 1234.5}), "1 234,5 %");
  await i18n.use("ja");
  assert.equal(i18n.text("player.queue.count", {count: 1}), "1曲");
  assert.equal(i18n.text("player.queue.count", {count: 3}), "3曲");
  await i18n.use("ar");
  assert.equal(root.dir, "rtl"); assert.equal(i18n.direction, "rtl");
  assert.equal(i18n.text("player.queue.heading"), "قائمة التشغيل");
  await i18n.use("en");
  assert.equal(root.dir, "ltr");
  assert.equal(i18n.text("playback.volume.value", {percent: 1234.5}), "1,234.5%");
});

test("error codes translate known errors and otherwise keep the original English message", async () => {
  const {i18n} = runtime();
  const server = Object.assign(Error("Your iBroadcast session expired. Connect again."), {code: "session.expired", params: {}});
  assert.equal(i18n.errorText(server), "Your iBroadcast session expired. Connect again.");
  await i18n.use("nl");
  assert.equal(i18n.errorText(server), "Je iBroadcast-sessie is verlopen. Maak opnieuw verbinding.");
  assert.equal(i18n.errorText(Object.assign(Error("Original text"), {code: "unknown.code"})), "Original text");
  assert.equal(i18n.errorText(Object.assign(Error("Original text"), {code: "x<script>"})), "Original text");
  assert.equal(i18n.errorText(Error("No code")), "No code");
  const failure = i18n.failure("queue.track_missing");
  assert.equal(failure.message, "This track is no longer on that album. Reload the library.", "the error message stays English for logs and tests");
  assert.equal(i18n.errorText(failure), "Dit nummer staat niet meer op dat album. Laad de bibliotheek opnieuw.");
});

test("numbers, dates and pseudo-localization follow the active language", async () => {
  const {i18n} = runtime();
  const when = "2026-11-02T18:21:00Z", options = {dateStyle: "medium", timeStyle: "short", timeZone: "UTC"};
  assert.equal(i18n.number(1234567), (1234567).toLocaleString("en"), "English keeps today's fixed format");
  assert.equal(i18n.number(1234.56, {maximumFractionDigits: 1, useGrouping: false}), "1234.6");
  assert.equal(i18n.dateTime(when, options), "2 Nov 2026, 18:21");
  assert.equal(i18n.dateTime(when, {timeZone: "UTC"}), new Date(when).toLocaleString("en-GB", {timeZone: "UTC"}));
  await i18n.use("nl");
  assert.equal(i18n.number(1234567), "1.234.567");
  assert.equal(i18n.dateTime("2026-11-02T18:21:00Z", {dateStyle: "medium", timeZone: "UTC"}), "2 nov 2026");
  i18n.usePseudo();
  const marked = i18n.text("player.queue.remove", {title: "Song", position: 2});
  assert.match(marked, /^⟦.*Song.*2.*~+⟧$/);
  assert.equal(i18n.language, "en-XA");
  assert.equal(i18n.choice, "nl", "pseudo-localization is never stored");
});

test("Python error codes have English text identical to the server message", () => {
  for (const file of readdirSync(path.join(root, "src/tagcast")).filter(f => f.endsWith(".py"))) {
    for (const m of read(path.join(root, "src/tagcast", file)).matchAll(/\(\s*"([^"]+)",\s*code="([a-z0-9_.]+)"/g)) {
      assert.equal(english[`errors.${m[2]}`], m[1], `${file}: ${m[2]}`);
    }
  }
});

test("German, French, Spanish and Japanese are chosen for their own systems and use their own plural forms and numbers", async () => {
  const fill = (template, count) => template.replace(/\{\{\s*count(?:,\s*number)?\s*\}\}/g, count);
  assert.equal(runtime({languages: ["de-AT", "en-US"]}).i18n.resolve("auto"), "de", "a regional system language chooses its language");
  for (const [tag, system, grouped] of [["de", "de-DE", "1.234.567"], ["fr", "fr-CA", null], ["es", "es-MX", null], ["ja", "ja-JP", "1,234,567"]]) {
    assert.equal(manifest.languages.find(language => language.tag === tag)?.status, "complete", `${tag} ships as complete`);
    assert.equal(runtime({languages: [system, "en-US"]}).i18n.resolve("auto"), tag, `${system} chooses ${tag}`);
    const {i18n} = runtime({languages: [system]});
    assert.equal(await i18n.use(tag), tag);
    const messages = catalogs[tag], one = messages["common.count.tracks_one"] ?? messages["common.count.tracks_other"];
    assert.equal(i18n.text("common.count.tracks", {count: 1}), fill(one, 1));
    assert.equal(i18n.text("common.count.tracks", {count: 7}), fill(messages["common.count.tracks_other"], 7));
    if (messages["common.count.tracks_many"]) assert.equal(i18n.text("common.count.tracks", {count: 1000000}), fill(messages["common.count.tracks_many"], 1000000));
    const number = i18n.number(1234567);
    if (grouped) assert.equal(number, grouped);
    assert.notEqual(number, "1234567", `${tag} groups digits`);
    assert.equal(i18n.text("missing.key.for.test"), "missing.key.for.test", "an unknown key never throws");
  }
});
