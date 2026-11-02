"use strict";
// Read-only inventory of user-visible English strings in Tagcast JavaScript/HTML.
// Usage: node inventory-js.cjs <repo-root> <out.json>
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const walk = require("acorn-walk");
const parse5 = require("parse5");

const root = process.argv[2];
const out = process.argv[3];

const TRANSLATABLE_ATTRS = new Set(["title", "aria-label", "placeholder", "alt", "aria-description",
  "aria-roledescription", "aria-valuetext", "label", "data-tooltip"]);
const KEY_NAMES = new Set(["Escape", "Enter", "Tab", "Home", "End", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "PageUp", "PageDown", "Backspace", "Delete", "Space", "Spacebar", "Esc", "Shift", "Control", "Meta", "Alt"]);
const TECH_WORDS = new Set(["GET", "POST", "HEAD", "PUT", "DELETE", "FLAC", "MP3", "Content-Type", "X-Tagcast", "Error",
  "Date", "Object", "Array", "String", "Number", "Boolean", "Promise", "MediaSource", "AbortError", "NotAllowedError",
  "NotSupportedError", "TypeError", "SyntaxError", "UTF-8", "UTF-16", "UTF-16LE", "UTF-16BE", "BOM", "JSON", "CSV", "ZIP",
  "TSV", "LRC", "TXT", "URL", "HTTPS", "OK", "ID", "IDs", "AAC", "ALAC", "WAV", "OGG", "OPUS", "M4A", "AIFF", "WMA", "APE"]);
const TECH_CALLEES = new Set(["$", "querySelector", "querySelectorAll", "getElementById", "closest", "matches", "add", "remove",
  "toggle", "contains", "getAttribute", "removeAttribute", "hasAttribute", "toggleAttribute", "addEventListener",
  "removeEventListener", "dispatchEvent", "Event", "CustomEvent", "getItem", "setItem", "removeItem", "fetch", "api", "URL",
  "createElement", "createElementNS", "createTextNode", "getPropertyValue", "setProperty", "removeProperty", "matchMedia", "split",
  "join", "replace", "replaceAll", "startsWith", "endsWith", "includes", "indexOf", "padStart", "padEnd", "toLocaleString",
  "toLocaleTimeString", "localeCompare", "require", "postMessage", "send", "invoke", "on", "once", "observe", "has", "get",
  "delete", "Blob", "File", "AudioContext", "canPlayType", "isTypeSupported", "addSourceBuffer", "RegExp", "normalize",
  "encodeURIComponent", "decodeURIComponent", "TextDecoder", "TextEncoder", "insertAdjacentHTML", "scrollIntoView", "focus",
  "setTimeout", "setInterval", "log", "warn", "error", "info", "debug", "mark", "measure", "storedPageSize", "rememberPageSize",
  "readStorage", "writeStorage", "storage", "localStorageGet", "localStorageSet", "assign", "freeze", "defineProperty",
  "hasOwn", "keys", "entries", "values", "from", "of", "isArray", "parse", "stringify", "Symbol", "atob", "btoa"]);
const UI_CALLEES = new Set(["toast", "confirm", "alert", "prompt", "setActionStatus", "showErrorBox", "showMessageBox",
  "showMessageBoxSync", "Error", "statusLine", "announce"]);
const UI_PROPS = new Set(["textContent", "innerText", "title", "placeholder", "ariaLabel", "label", "innerHTML", "outerHTML",
  "returnValue", "ariaValueText", "ariaDescription", "alt", "message", "detail"]);
const UI_KEYS = new Set(["label", "title", "text", "description", "message", "noun", "singular", "plural", "subtitle", "hint",
  "help", "placeholder", "empty", "heading", "summary", "detail", "note", "name", "tooltip", "caption", "intro", "body",
  "explanation", "warning", "error", "status", "aria", "short", "long", "button", "action", "prompt", "question", "reason"]);

function letters(s) { return (s.match(/\p{L}/gu) || []).length; }
function words(s) { return (s.replace(/\{\}/g, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || []).length; }
function norm(s) { return s.replace(/\s+/g, " ").trim(); }
function decodeEntities(s) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&rarr;/g, "→").replace(/&larr;/g, "←").replace(/&hellip;/g, "…")
    .replace(/&middot;/g, "·").replace(/&times;/g, "×").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}

function technical(s) {
  const t = s.trim();
  if (!t) return true;
  if (letters(t.replace(/\{\}/g, "")) < 2) return true;
  if (/^(#|\.|\[|:|@|--|\/|\.\/|\.\.\/|https?:|data:|blob:|mailto:|var\()/.test(t)) return true;
  if (/^\w+\[/.test(t) || /\[data-/.test(t) || /^[a-z-]+\s*[>+~]\s*/.test(t)) return true;
  if (/^[a-z][a-z0-9]*([-_:.\/][a-z0-9{}]+)+$/i.test(t) && !/\s/.test(t) && !/^[A-Z][a-z]+-[a-z]+$/.test(t)) return true; // keys, paths, mime
  if (/^[a-z_$][\w$]*$/.test(t)) return true;                // lowercase identifiers
  if (/^[a-z]+[A-Z][\w]*$/.test(t)) return true;             // camelCase
  if (/^[A-Z0-9_]+$/.test(t) && t.length > 1) return true;  // CONSTANTS / acronyms
  if (KEY_NAMES.has(t) || TECH_WORDS.has(t)) return true;
  if (/^[MLHVCSQTAZmlhvcsqtaz0-9 .,\-]+$/.test(t) && /\d/.test(t)) return true; // svg path
  if (/^#[0-9a-f]{3,8}$/i.test(t)) return true;
  if (/^[\w-]+\s*:\s*[^ ]+;?$/.test(t) && /px|%|var\(|rgb|#/.test(t)) return true; // css decl
  if (/^(rgb|hsl)a?\(/.test(t)) return true;
  if (/^[\w-]+(\s+[\w-]+)*$/.test(t) && !/[A-Z]/.test(t) && /-/.test(t)) return true; // class lists
  if (/^\d/.test(t) && !/\s\p{L}{2,}/u.test(t)) return true;
  if (/^(sha256|sha-256|utf-8|en-GB|en|en-US)$/i.test(t)) return true;
  if (/^(application|audio|image|text|video)\//.test(t)) return true;
  return false;
}

function looksUi(s, sink) {
  const t = norm(s);
  if (technical(t)) return false;
  const hasSpace = /\s/.test(t.replace(/\{\}/g, "x"));
  if (sink) return true;
  if (hasSpace && /\p{L}{2,}/u.test(t)) {
    // multiword lower-case class lists already excluded; require at least one letter word >1
    if (/^[a-z0-9-]+( [a-z0-9-]+)+$/.test(t) && !/[.!?…:]/.test(t)) return /\b(the|a|an|of|to|in|and|or|for|with|by|from|on|is|are|your|this|no|not)\b/.test(t);
    return true;
  }
  if (/^[A-Z][\p{Ll}’']+[.!?…]?$/u.test(t)) return true;      // single capitalised word
  if (/…$/.test(t)) return true;
  return false;
}

function isFragment(t) {
  const n = t.replace(/\{\}/g, "").trim();
  return /^[\p{Ll}]/u.test(n) || /^[ ,·]/.test(t) || /[ ]$/.test(t) && !/[.!?…:]\s*$/.test(t);
}

function calleeName(node) {
  const c = node.callee;
  if (!c) return "";
  if (c.type === "Identifier") return c.name;
  if (c.type === "MemberExpression" && !c.computed) return c.property.name;
  return "";
}

function contextOf(node, ancestors) {
  // Walk up through template/conditional/logical/binary(+)/array wrappers.
  let child = node;
  for (let i = ancestors.length - 2; i >= 0; i--) {
    const p = ancestors[i];
    switch (p.type) {
      case "TemplateLiteral": case "ConditionalExpression": case "LogicalExpression": case "ArrayExpression":
      case "SequenceExpression": case "ParenthesizedExpression": case "TaggedTemplateExpression": case "SpreadElement":
        if (p.type === "ConditionalExpression" && p.test === child) return {kind: "logic"};
        child = p; continue;
      case "BinaryExpression":
        if (p.operator === "+") { child = p; continue; }
        return {kind: "logic"};
      case "SwitchCase": return p.test === child ? {kind: "logic"} : {kind: "other"};
      case "Property":
        if (p.key === child && !p.computed) return {kind: "key"};
        if (p.key === child) return {kind: "logic"};
        { const key = p.key.type === "Identifier" ? p.key.name : String(p.key.value);
          return {kind: UI_KEYS.has(key) ? "ui-key" : "prop", key}; }
      case "AssignmentExpression":
        if (p.left.type === "MemberExpression" && !p.left.computed && UI_PROPS.has(p.left.property.name)) return {kind: "ui-prop", key: p.left.property.name};
        if (p.left.type === "MemberExpression" && !p.left.computed && p.left.property.name === "returnValue") return {kind: "ui-prop", key: "returnValue"};
        return {kind: "assign"};
      case "CallExpression": case "NewExpression": {
        const name = calleeName(p), index = p.arguments.indexOf(child);
        if (index < 0) return {kind: "other"};
        if (name === "setAttribute") {
          const attr = p.arguments[0]?.type === "Literal" ? p.arguments[0].value : "";
          return index === 1 && TRANSLATABLE_ATTRS.has(attr) ? {kind: "ui-attr", key: attr} : {kind: "tech"};
        }
        if (UI_CALLEES.has(name) || /Status$|Notice$|Message$|Feedback$|Toast$|Announce$|Phase$/.test(name)) return {kind: "ui-call", key: name};
        if (TECH_CALLEES.has(name)) return {kind: "tech", key: name};
        return {kind: "arg", key: name};
      }
      case "VariableDeclarator": return {kind: "var", key: p.id.name};
      case "ReturnStatement": case "ArrowFunctionExpression": return {kind: "return"};
      case "ExpressionStatement": return p.directive ? {kind: "directive"} : {kind: "other"};
      case "ImportDeclaration": case "ExportNamedDeclaration": return {kind: "tech"};
      case "MemberExpression": return p.computed && p.property === child ? {kind: "tech"} : {kind: "other"};
      default: return {kind: "other"};
    }
  }
  return {kind: "other"};
}

function htmlPieces(src) {
  // src: template/static html with \u0001 placeholders. Returns {texts, attrs}.
  const texts = [], attrs = [];
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let m, inSkip = 0;
  while ((m = re.exec(src))) {
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      const tag = m[1].toLowerCase(), closing = m[0][1] === "/";
      if (["script", "style", "svg", "path", "code"].includes(tag)) {
        if (["svg", "script", "style"].includes(tag)) inSkip += closing ? -1 : (m[0].endsWith("/>") ? 0 : 1);
        inSkip = Math.max(0, inSkip);
        if (tag !== "svg") continue;
      }
      if (!closing) {
        const ar = /([:@\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g; let a;
        while ((a = ar.exec(m[2]))) {
          const name = a[1].toLowerCase(), value = a[3] ?? a[4];
          if (TRANSLATABLE_ATTRS.has(name)) attrs.push({attr: name, text: value});
        }
      }
      continue;
    }
    if (m[3] && !inSkip) texts.push(m[3]);
  }
  return {texts, attrs};
}

function analyzeJs(file, rel) {
  const code = fs.readFileSync(file, "utf8");
  const ast = acorn.parse(code, {ecmaVersion: "latest", sourceType: "script", locations: true, allowHashBang: true});
  const items = [];
  const metrics = {innerHTML: 0, toLocaleEn: 0, localeCompare: 0, pluralTernaries: 0, confirms: 0, templateHtml: 0, nativeDialogs: 0};
  const seenTemplates = new Set();
  const pluralNodes = new Set();
  function push(kind, text, line, ctx, extra = {}) {
    const t = norm(decodeEntities(text));
    if (!t) return;
    items.push({file: rel, line, kind, text: t, ctx: ctx.kind, key: ctx.key || "", words: words(t), fragment: isFragment(text), ...extra});
  }
  const isPlural = node => node.type === "ConditionalExpression" && node.test.type === "BinaryExpression" && ["===", "=="].includes(node.test.operator)
        && node.test.right.type === "Literal" && node.test.right.value === 1
        && (node.consequent.type === "Literal" || node.consequent.type === "TemplateLiteral")
        && (node.alternate.type === "Literal" || node.alternate.type === "TemplateLiteral");
  walk.full(ast, node => { if (isPlural(node)) { pluralNodes.add(node.consequent); pluralNodes.add(node.alternate); } });
  walk.fullAncestor(ast, (node, _state, ancestors) => {
    if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression" && node.left.property?.name === "innerHTML") metrics.innerHTML++;
    if (node.type === "CallExpression") {
      const n = calleeName(node);
      if (n === "toLocaleString" && node.arguments[0]?.type === "Literal" && /^en/.test(node.arguments[0].value)) metrics.toLocaleEn++;
      if (n === "toLocaleTimeString" && node.arguments[0]?.type === "Literal") metrics.toLocaleEn++;
      if (n === "localeCompare") metrics.localeCompare++;
      if (n === "confirm") metrics.confirms++;
      if (["showMessageBoxSync", "showMessageBox", "showErrorBox", "showOpenDialog"].includes(n)) metrics.nativeDialogs++;
    }
    if (node.type === "ConditionalExpression" && node.test.type === "BinaryExpression" && ["===", "=="].includes(node.test.operator)
        && node.test.right.type === "Literal" && node.test.right.value === 1
        && (node.consequent.type === "Literal" || node.consequent.type === "TemplateLiteral")
        && (node.alternate.type === "Literal" || node.alternate.type === "TemplateLiteral")) {
      metrics.pluralTernaries++;
      for (const branch of [node.consequent, node.alternate]) {
        const t = branch.type === "Literal" ? String(branch.value) : branch.quasis.map(q => q.value.cooked).join("{}");
        pluralNodes.add(branch);
        if (letters(t) >= 2) push("plural", t, branch.loc.start.line, {kind: "plural"});
      }
    }
    if (node.type === "Literal" && typeof node.value === "string") {
      if (pluralNodes.has(node)) return;
      const ctx = contextOf(node, ancestors);
      if (["key", "logic", "tech", "directive"].includes(ctx.kind)) return;
      const s = node.value;
      if (/<[a-zA-Z\/][^>]*>/.test(s)) {
        const {texts, attrs} = htmlPieces(s);
        for (const t of texts) if (looksUi(decodeEntities(t), true) ) push("html-text", t, node.loc.start.line, ctx);
        for (const a of attrs) if (!technical(a.text)) push("html-attr", a.text, node.loc.start.line, ctx, {attr: a.attr});
        return;
      }
      const sink = ["ui-prop", "ui-attr", "ui-call", "ui-key"].includes(ctx.kind);
      if (looksUi(s, sink && letters(s) >= 2 && !technical(s))) push("string", s, node.loc.start.line, ctx);
    }
    if (node.type === "TemplateLiteral") {
      if (pluralNodes.has(node)) return;
      const parent = ancestors[ancestors.length - 2];
      if (parent?.type === "TaggedTemplateExpression") return;
      const ctx = contextOf(node, ancestors);
      if (["key", "logic", "tech"].includes(ctx.kind)) return;
      const joined = node.quasis.map(q => q.value.cooked ?? q.value.raw).join("\u0001");
      if (/<[a-zA-Z\/][^>]*>/.test(joined)) {
        metrics.templateHtml++;
        const {texts, attrs} = htmlPieces(joined);
        for (const t of texts) {
          const shown = t.replace(/\u0001/g, "{}");
          if (looksUi(decodeEntities(shown), true)) push("html-text", shown, node.loc.start.line, ctx, {interpolated: shown.includes("{}")});
        }
        for (const a of attrs) {
          const shown = a.text.replace(/\u0001/g, "{}");
          if (!technical(shown) && letters(shown.replace(/\{\}/g, "")) >= 2) push("html-attr", shown, node.loc.start.line, ctx, {attr: a.attr, interpolated: shown.includes("{}")});
        }
        return;
      }
      const shown = joined.replace(/\u0001/g, "{}");
      const sink = ["ui-prop", "ui-attr", "ui-call", "ui-key"].includes(ctx.kind);
      if (looksUi(shown, sink && !technical(shown))) push("template", shown, node.loc.start.line, ctx, {interpolated: node.expressions.length > 0});
    }
  });
  return {items, metrics, bytes: Buffer.byteLength(code), lines: code.split("\n").length};
}

function analyzeHtml(file, rel) {
  const code = fs.readFileSync(file, "utf8");
  const doc = parse5.parse(code, {sourceCodeLocationInfo: true});
  const items = [];
  function regionOf(node) {
    for (let n = node; n; n = n.parentNode) {
      const id = (n.attrs || []).find(a => a.name === "id")?.value;
      if (id && (["dialog", "aside", "main", "section", "header", "footer", "nav", "form"].includes(n.tagName) || /-page$|-panel$/.test(id))) {
        if (n.tagName === "dialog" || /-page$/.test(id) || n.tagName === "aside") return `${n.tagName}#${id}`;
      }
    }
    return "document";
  }
  function visit(node, skip) {
    const tag = node.tagName;
    const skipHere = skip || ["script", "style", "svg"].includes(tag);
    if (node.attrs && !["script", "style"].includes(tag)) {
      for (const a of node.attrs) {
        if (TRANSLATABLE_ATTRS.has(a.name) && !technical(a.value) && letters(a.value) >= 2)
          items.push({file: rel, line: node.sourceCodeLocation?.startLine || 0, kind: "html-attr", attr: a.name, text: norm(a.value), ctx: "static-html", key: "", region: regionOf(node), words: words(a.value), fragment: isFragment(a.value)});
        if (a.name === "content" && node.tagName === "meta") { /* not visible */ }
        if (a.name === "value" && tag === "input" && ["button", "submit"].includes((node.attrs.find(x => x.name === "type") || {}).value))
          items.push({file: rel, line: node.sourceCodeLocation?.startLine || 0, kind: "html-attr", attr: "value", text: norm(a.value), ctx: "static-html", key: "", words: words(a.value), fragment: false});
      }
    }
    if (node.nodeName === "#text" && !skip) {
      const t = norm(node.value);
      if (letters(t) >= 2 || (t && /\p{L}/u.test(t) && node.parentNode?.tagName === "title"))
        items.push({file: rel, line: node.sourceCodeLocation?.startLine || 0, kind: "html-text", text: t, ctx: node.parentNode?.tagName === "title" ? "document-title" : "static-html", key: node.parentNode?.tagName || "", region: regionOf(node.parentNode), words: words(t), fragment: isFragment(node.value)});
    }
    const kids = node.tagName === "template" ? node.content.childNodes : node.childNodes || [];
    for (const k of kids) visit(k, skipHere && tag !== "title" ? true : skip);
  }
  visit(doc, false);
  return {items, metrics: {}, bytes: Buffer.byteLength(code), lines: code.split("\n").length};
}

const targets = [];
const staticDir = path.join(root, "src/tagcast/static");
for (const f of fs.readdirSync(staticDir)) if (f.endsWith(".js")) targets.push(path.join(staticDir, f));
targets.push(path.join(staticDir, "mini-player/view.js"));
for (const f of fs.readdirSync(path.join(root, "electron"))) if (f.endsWith(".cjs")) targets.push(path.join(root, "electron", f));
const htmlTargets = [path.join(staticDir, "index.html"), path.join(staticDir, "mini-player/index.html")];

const result = {files: {}};
for (const file of targets.filter(f => fs.existsSync(f))) {
  const rel = path.relative(root, file);
  try { result.files[rel] = analyzeJs(file, rel); }
  catch (error) { result.files[rel] = {error: String(error), items: [], metrics: {}}; }
}
for (const file of htmlTargets.filter(f => fs.existsSync(f))) {
  const rel = path.relative(root, file);
  result.files[rel] = analyzeHtml(file, rel);
}
fs.writeFileSync(out, JSON.stringify(result, null, 1));
let total = 0;
for (const [rel, r] of Object.entries(result.files)) { total += r.items.length; if (r.error) console.log("ERR", rel, r.error); }
console.log("items", total);
