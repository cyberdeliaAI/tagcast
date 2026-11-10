"use strict";
const assert = require("node:assert/strict");

// This dependency-free function also runs in the real renderer. Viewport visibility
// alone is insufficient: theme choices can be clipped by the menu's own scrollport.
function inspectMenuTargets(menuId) {
  const menu = document.getElementById(menuId), toolbar = document.querySelector("#browse-toolbar");
  let overlaps = 0, checked = 0;
  for (const control of menu.querySelectorAll("label,button")) {
    if (!control.getClientRects().length) continue;
    // Exercise every rendered choice, including those initially clipped inside
    // the scrollable menu. Do not skip an occluded point or retry a failed hit.
    control.scrollIntoView({block: "nearest", inline: "nearest"});
    const r = control.getBoundingClientRect(), t = toolbar.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    checked++;
    if (y >= t.top && y < t.bottom && x >= t.left && x < t.right) overlaps++;
    if (!control.contains(hit)) return {ok: false, checked, overlaps,
      blocked: control.id || control.querySelector("input")?.id || control.tagName,
      hit: hit ? {tag: hit.tagName, id: hit.id, className: hit.className} : null,
      point: {x, y}, rect: r.toJSON(), menuRect: menu.getBoundingClientRect().toJSON(),
      menuScroll: {top: menu.scrollTop, height: menu.clientHeight, total: menu.scrollHeight},
      viewport: {width: innerWidth, height: innerHeight, scrollY}};
  }
  return {ok: checked > 0, checked, overlaps};
}

// Real hit testing catches menus painted behind the sticky listing controls.
async function checkBrowseMenus(window) {
  const owner = window.webContents, bounds = window.getBounds();
  const run = code => owner.executeJavaScript(code);
  const before = await run("({screen:state.screen,appearance:document.documentElement.dataset.theme})");
  const samples = [];
  try {
    for (const width of [420, 761, 1280]) for (const appearance of ["light", "dark"]) {
      window.setContentSize(width, 800);
      await run(`document.documentElement.dataset.theme='${appearance}';showBrowse('years');window.scrollTo(0,0)`);
      for (const menu of ["theme", "language"]) {
        await run(menu === "theme" ? "setThemeMenu(true)" : "setHeaderLanguageMenu(true)");
        await run("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
        const result = await run(`(${inspectMenuTargets.toString()})('${menu}-menu')`);
        assert.equal(result.ok, true, `${width}/${appearance}/${menu}: menu choices receive pointer input ${JSON.stringify(result)}`);
        if (menu === "theme") assert.ok(result.overlaps > 0, "Exercise a choice over the listing toolbar");
        owner.sendInputEvent({type:"keyDown", keyCode:"Escape"});
        owner.sendInputEvent({type:"keyUp", keyCode:"Escape"});
        await run("new Promise(resolve=>requestAnimationFrame(resolve))");
        assert.equal(await run(`document.querySelector('#${menu}-menu').hidden`), true);
        assert.equal(await run("document.activeElement.id"), menu === "theme" ? "theme-button" : "language-button");
        samples.push({width, appearance, menu, ...result});
      }
    }
    return samples;
  } finally {
    window.setBounds(bounds);
    await run(`setThemeMenu(false);setHeaderLanguageMenu(false);showScreen(${JSON.stringify(before.screen)});
      ${before.appearance ? `document.documentElement.dataset.theme=${JSON.stringify(before.appearance)}` : "delete document.documentElement.dataset.theme"}`);
  }
}

module.exports = {checkBrowseMenus, inspectMenuTargets};
