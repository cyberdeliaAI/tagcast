"use strict";

// Fixed codes only: browsing preferences never contain library metadata or translated labels.
const browseSortChoices = {
  sort: [...Object.keys(SORTS), "random"],
  "artists-sort": ["az", "za", "rating_high", "rating_low", "random"],
  "favourite-artists-sort": ["az", "za", "rating_high", "rating_low"],
  "guide-sort": ["list", "year-asc", "year-desc"],
};
const browseSortMemory = readBrowseSortMemory();
function readBrowseSortMemory() {
  try {
    const raw = localStorage.getItem("tagcast-browse-sorts");
    const data = raw && raw.length < 4096 ? JSON.parse(raw) : {};
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}
function rememberedBrowseSort(key, choices, fallback) {
  return choices.includes(browseSortMemory[key]) ? browseSortMemory[key] : fallback;
}
function rememberBrowseSort(key, value) {
  browseSortMemory[key] = value;
  try { localStorage.setItem("tagcast-browse-sorts", JSON.stringify(browseSortMemory)); } catch { /* private/full storage */ }
}
function browseGroupSortKey(kind, detail) { return `group:${kind}:${detail ? "albums" : "groups"}`; }
for (const [id, choices] of Object.entries(browseSortChoices)) {
  const node = $(`#${id}`), value = rememberedBrowseSort(id, choices, node.value);
  if (value) node.value = value;
  node.addEventListener("change", () => { if (choices.includes(node.value)) rememberBrowseSort(id, node.value); });
}
albumGuide.sort = rememberedBrowseSort("guide-sort", browseSortChoices["guide-sort"], albumGuide.sort);
$("#browse-sort").addEventListener("change", event => {
  const choices = browseView.key === null ? ["az", "za", "count"] : Object.keys(SORTS);
  if (choices.includes(event.target.value)) rememberBrowseSort(browseGroupSortKey(browseView.kind, browseView.key !== null), event.target.value);
});
// Page changes begin at the controls, keeping the new first result visible. Back/Forward
// continues to use navigation.js's separately captured scroll position.
function scrollListingStart(selector) {
  const page = $(selector), controls = page.querySelector?.(".toolbar, .sticky-search");
  // A stuck toolbar's rectangle follows the viewport, not its original place in
  // the document. Measure its normal flow position synchronously before painting.
  let top = 0;
  if (controls) {
    const position = controls.style.position;
    try {
      controls.style.position = "static";
      top = controls.getBoundingClientRect().top + (window.scrollY || 0);
    } finally { controls.style.position = position; }
  }
  if (typeof nav !== "undefined") nav.scroll = null;
  window.scrollTo?.({top: Math.max(0, top), behavior: "instant"});
}
