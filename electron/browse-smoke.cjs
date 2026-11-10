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

// Keep the notification painted over the bottom menu control. Test the actual
// pointer target rather than waiting for a toast to expire or hiding it.
function inspectToastTarget() {
  const control = document.querySelector('[data-open-theme-editor]');
  control.scrollIntoView({block: "nearest", inline: "nearest"});
  const rect = control.getBoundingClientRect(), toast = document.getElementById("toast");
  const point = {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)};
  const notification = toast.getBoundingClientRect(), hit = document.elementFromPoint(point.x, point.y);
  return {point, hit: hit?.id || hit?.tagName, receivesPointer: control.contains(hit),
    visible: !toast.hidden && getComputedStyle(toast).display !== "none" && notification.height > 0,
    role: toast.getAttribute("role"), text: toast.textContent, children: toast.children.length,
    overlap: point.x >= notification.left && point.x < notification.right && point.y >= notification.top && point.y < notification.bottom};
}

async function checkToastPointerInput(window) {
  const owner = window.webContents, samples = [];
  const run = code => owner.executeJavaScript(code);
  for (const width of [420, 760, 768, 1280]) for (const height of [656, 800]) for (const appearance of ["light", "dark"]) {
    window.setContentSize(width, height);
    await run(`document.documentElement.dataset.theme='${appearance}';showBrowse('years');window.scrollTo(0,0);
      setThemeMenu(true);toast('Synthetic notification: upstream service unavailable')`);
    await run("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const before = await run(`(${inspectToastTarget.toString()})()`);
    assert.equal(before.visible, true, "Notification remains visible during pointer testing");
    assert.equal(before.role, "status");
    assert.equal(before.children, 0, "The click-through notification contains no interactive controls");
    assert.equal(before.receivesPointer, true, `${width}x${height}/${appearance}: visible toast cannot block Edit themes ${JSON.stringify(before)}`);
    owner.sendInputEvent({type:"mouseDown", ...before.point, button:"left", clickCount:1});
    owner.sendInputEvent({type:"mouseUp", ...before.point, button:"left", clickCount:1});
    await run("new Promise(resolve=>requestAnimationFrame(resolve))");
    assert.equal(await run("state.screen === 'settings' && settingsView.category === 'appearance' && !document.querySelector('#settings').hidden && !!document.querySelector('#theme-editor')"), true, "Real pointer input opens the theme editor");
    assert.equal(await run("document.querySelector('#toast').hidden"), false, "Clicking does not dismiss the notification");
    await run("closeSettings()");
    samples.push({width, height, appearance, ...before});
  }
  assert.ok(samples.some(sample => sample.width === 420 && sample.overlap), "Exercise the reported physical toast/control overlap");
  return samples;
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
    samples[0].toastPointer = await checkToastPointerInput(window);
    return samples;
  } finally {
    window.setBounds(bounds);
    await run(`setThemeMenu(false);setHeaderLanguageMenu(false);showScreen(${JSON.stringify(before.screen)});
      ${before.appearance ? `document.documentElement.dataset.theme=${JSON.stringify(before.appearance)}` : "delete document.documentElement.dataset.theme"}`);
  }
}

module.exports = {checkBrowseMenus, inspectMenuTargets, inspectToastTarget};
