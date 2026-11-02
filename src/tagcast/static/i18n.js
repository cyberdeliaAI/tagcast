"use strict";

// Interface language for Tagcast's own text. Catalogs in i18n/ are data: they never contain
// markup and never replace metadata, settings keys, stored history, reports or file names.
// English (i18n-en.js) is always loaded and is the fallback for every missing key.
// Format: a strict subset of i18next JSON v4 (flat keys, {{name}} and {{name, number}}
// placeholders, _one/_other plural suffixes), so standard translation tools can edit it.
const TagcastI18n = (() => {
  const english = globalThis.TagcastI18nEnglish || {manifest: {source: "en", languages: [
    {tag: "en", name: "English", dir: "ltr", format: "en-GB", status: "complete"}]}, messages: {}};
  const manifest = english.manifest;
  const offered = new Map(manifest.languages.map(language => [language.tag, language]));
  const STORAGE_KEY = "tagcast-language";
  const CODE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
  const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:,\s*(number)\s*)?\}\}/g;
  const ATTRIBUTES = new Set(["aria-label", "title", "placeholder", "alt", "aria-description", "aria-valuetext"]);
  const catalogs = new Map([["en", english.messages]]);
  const listeners = new Set(), reported = new Set(), trusted = new WeakSet();
  const plurals = new Map(), numbers = new Map();
  let active = "en", choice = stored(), request = 0;

  function stored() {
    try { return localStorage.getItem(STORAGE_KEY) || ""; } catch { return ""; }
  }
  function store(value) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* private window: this page only */ }
  }
  function language(tag) { return offered.get(tag) || offered.get("en"); }
  function warn(message) {
    if (reported.has(message)) return;
    reported.add(message);
    globalThis.console?.warn?.(`Tagcast interface text: ${message}`);
  }

  // A manual choice wins. Automatic and empty choices use the first browser or system
  // language with a complete translation; anything else falls back to English.
  function resolve(value, preferred = globalThis.navigator?.languages) {
    if (value && value !== "auto") return offered.has(value) ? value : "en";
    for (const wanted of Array.isArray(preferred) ? preferred : []) {
      const exact = String(wanted).toLowerCase(), base = exact.split("-")[0];
      const match = manifest.languages.find(item => item.tag.toLowerCase() === exact)
        || manifest.languages.find(item => item.tag.toLowerCase().split("-")[0] === base);
      if (match?.status === "complete") return match.tag;
    }
    return "en";
  }

  function pluralRules(tag) {
    if (!plurals.has(tag)) plurals.set(tag, new Intl.PluralRules(tag));
    return plurals.get(tag);
  }
  function numberFormat(tag) {
    if (!numbers.has(tag)) numbers.set(tag, new Intl.NumberFormat(language(tag).format || tag));
    return numbers.get(tag);
  }
  function find(tag, key, count) {
    const messages = catalogs.get(tag);
    if (!messages) return undefined;
    if (count !== undefined) {
      const form = messages[`${key}_${pluralRules(tag).select(count)}`] ?? messages[`${key}_other`];
      if (typeof form === "string") return form;
    }
    return typeof messages[key] === "string" ? messages[key] : undefined;
  }
  function lookup(key, params, englishOnly) {
    const count = typeof params?.count === "number" && Number.isFinite(params.count) ? params.count : undefined;
    for (const tag of englishOnly || active === "en" ? ["en"] : [active, "en"]) {
      const value = find(tag, key, count);
      if (value !== undefined) return {value, tag};
    }
    warn(`missing key ${key}`);
    return {value: key, tag: "en"};
  }

  // Message text and every value are encoded separately: placeholders can never inject markup.
  function fill(key, params, encode, englishOnly = false) {
    const {value, tag} = lookup(key, params, englishOnly);
    let out = "", last = 0;
    for (const match of value.matchAll(PLACEHOLDER)) {
      out += encode(value.slice(last, match.index), true);
      const given = params?.[match[1]];
      if (!params || !Object.hasOwn(params, match[1])) warn(`missing value ${match[1]} for ${key}`);
      else if (given === undefined || given === null) out += "";
      else if (match[2] === "number" && typeof given === "number") out += encode(numberFormat(tag).format(given), true);
      else out += encode(given, false);
      last = match.index + match[0].length;
    }
    return out + encode(value.slice(last), true);
  }
  function escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  }
  const text = (key, params) => fill(key, params, value => String(value));
  const html = (key, params) => fill(key, params, (value, literal) => !literal && trusted.has(value) ? value.html : escape(value));
  const englishText = (key, params) => fill(key, params, value => String(value), true);

  function hasKey(key) {
    return [active, "en"].some(tag => {
      const messages = catalogs.get(tag) || {};
      return typeof messages[key] === "string" || typeof messages[`${key}_other`] === "string";
    });
  }

  // Only the element's own first text node and allow-listed attributes change, so static
  // markup, icons, inputs and event listeners stay as they are.
  function translate(root = globalThis.document) {
    for (const node of root?.querySelectorAll?.("[data-i18n], [data-i18n-attr]") || []) {
      const key = node.getAttribute("data-i18n");
      if (key) {
        const value = text(key), own = [...(node.childNodes || [])].find(child => child.nodeType === 3 && child.nodeValue.trim());
        if (own) {
          const [, lead, , trail] = own.nodeValue.match(/^(\s*)([\s\S]*?)(\s*)$/);
          own.nodeValue = lead + value + trail;
        } else if (!node.children?.length) node.textContent = value;
      }
      for (const pair of (node.getAttribute("data-i18n-attr") || "").split(";")) {
        const [attribute, attributeKey] = pair.split("=").map(part => part.trim());
        if (ATTRIBUTES.has(attribute) && attributeKey) node.setAttribute(attribute, text(attributeKey));
      }
    }
  }

  function apply(tag) {
    const changed = tag !== active;
    active = tag;
    const root = globalThis.document?.documentElement;
    if (root) { root.lang = tag; if (changed || tag !== "en") root.dir = language(tag).dir === "rtl" ? "rtl" : "ltr"; }
    if (!changed) return;
    afterParsing(() => translate());
    for (const listener of [...listeners]) {
      try { listener(tag); } catch (error) { globalThis.console?.error?.(error); }
    }
  }
  function afterParsing(callback) {
    if (globalThis.document?.readyState === "loading") globalThis.document.addEventListener("DOMContentLoaded", callback, {once: true});
    else callback();
  }

  // Keep only plain-text messages for keys English knows (plural forms by their base key).
  function known(key) {
    return Object.hasOwn(english.messages, key)
      || Object.hasOwn(english.messages, `${key.replace(/_(zero|one|two|few|many|other)$/, "")}_other`);
  }
  function validCatalog(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return Object.freeze(Object.fromEntries(Object.entries(data)
      .filter(([key, value]) => typeof value === "string" && !/[<>]/.test(value) && known(key))));
  }

  // Load and activate a choice. The newest call wins; failures keep English without
  // touching playback, drafts or other settings. `remember` writes this profile's cache.
  async function use(value, {remember = true} = {}) {
    const wanted = value === "auto" || offered.has(value) ? value : "en";
    choice = wanted;
    if (remember) store(wanted);
    const tag = resolve(wanted), ticket = ++request;
    if (!catalogs.has(tag)) {
      try {
        const response = await fetch(`/i18n/${encodeURIComponent(tag)}.json`, {cache: "no-store"});
        const catalog = response.ok ? validCatalog(await response.json()) : null;
        if (!catalog) throw Error(`The ${tag} interface text is unavailable.`);
        catalogs.set(tag, catalog);
      } catch (error) {
        warn(error.message);
        if (ticket === request) apply("en");
        return "en";
      }
    }
    if (ticket === request) apply(tag);
    return active;
  }

  const api = Object.freeze({
    get language() { return active; },
    get direction() { return language(active).dir === "rtl" ? "rtl" : "ltr"; },
    get choice() { return choice; },
    languages: () => manifest.languages.map(item => ({...item})),
    resolve, text, html, englishText, hasKey, translate, use,
    trusted(fragment) { const value = Object.freeze({html: String(fragment)}); trusted.add(value); return value; },
    number: value => numberFormat(active).format(value),
    // Server and browser errors may carry a stable code. Translate a known code and
    // otherwise show the original English message unchanged.
    errorText(error) {
      const code = typeof error?.code === "string" && CODE.test(error.code) ? error.code : "";
      if (code && hasKey(`errors.${code}`)) return text(`errors.${code}`, error.params && typeof error.params === "object" ? error.params : {});
      return String(error?.message ?? error ?? "");
    },
    // A browser-side failure with a code. Its message stays English for logs and tests.
    failure(code, params = {}) {
      const error = Error(englishText(`errors.${code}`, params));
      error.code = code; error.params = params;
      return error;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  });

  // Restore a non-English choice before painting. English needs no request at all.
  const initial = resolve(choice);
  if (initial !== "en") {
    const root = globalThis.document?.documentElement;
    if (root) root.lang = initial;
    root?.style?.setProperty?.("visibility", "hidden");
    const reveal = () => afterParsing(() => root?.style?.removeProperty?.("visibility"));
    const timer = setTimeout(reveal, 1200);
    use(choice, {remember: false}).finally(() => { clearTimeout(timer); reveal(); });
  }
  return api;
})();
