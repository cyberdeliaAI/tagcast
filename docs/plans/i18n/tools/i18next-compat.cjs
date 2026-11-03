// Do the Tagcast catalogs give identical output in TagcastI18n and in i18next (the exit path)?
// Usage: node i18next-compat.cjs <repo-root> <path/to/i18next/dist/umd/i18next.js>
const fs = require("fs"), path = require("path"), vm = require("vm");
const i18next = require(path.resolve(process.argv[3]));
const dir = process.argv[2];
const en = JSON.parse(fs.readFileSync(path.join(dir, "src/tagcast/static/i18n/en.json")));
const nl = JSON.parse(fs.readFileSync(path.join(dir, "src/tagcast/static/i18n/nl.json")));
const ctx = vm.createContext({document: {documentElement: {}, readyState: "complete", querySelectorAll: () => []}, localStorage: {getItem: () => null, setItem() {}},
  console, setTimeout, clearTimeout, fetch: async () => ({ok: true, json: async () => nl}), navigator: {}});
ctx.globalThis = ctx;
vm.runInContext(fs.readFileSync(path.join(dir, "src/tagcast/static/i18n-en.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(dir, "src/tagcast/static/i18n.js"), "utf8") + ";globalThis.T=TagcastI18n;", ctx);
(async () => {
  const instance = i18next.createInstance();
  await instance.init({lng: "en", fallbackLng: "en", keySeparator: false, nsSeparator: false, interpolation: {escapeValue: false},
    resources: {en: {translation: en}, nl: {translation: nl}}, initAsync: false});
  const params = {count: 0, title: "A <b>title</b>", position: 3, artist: "Artist", album: "Album", error: "Oops", output: "USB DAC", volume: "65%",
    percent: 65, number: 2, language: "Nederlands", elapsed: "1:00", duration: "2:00"};
  let compared = 0, diffs = [];
  for (const lang of ["en", "nl"]) {
    await instance.changeLanguage(lang); await ctx.T.use(lang);
    const keys = [...new Set(Object.keys(en).map(k => k.replace(/_(one|other)$/, "")))];
    for (const key of keys) for (const count of [0, 1, 2, 1234]) {
      const p = {...params, count};
      const ours = ctx.T.text(key, p), theirs = instance.t(key, p);
      compared++; if (ours !== theirs) diffs.push({lang, key, count, ours, theirs});
    }
  }
  console.log(JSON.stringify({compared, differences: diffs.length, sample: diffs.slice(0, 5)}, null, 1));
})();
