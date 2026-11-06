"use strict";
const assert = require("node:assert/strict");

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
        const result = await run(`(() => {
          const menu=document.querySelector('#${menu}-menu'),toolbar=document.querySelector('#browse-toolbar');
          const t=toolbar.getBoundingClientRect();let overlaps=0,checked=0;
          for(const control of menu.querySelectorAll('label,button')) {
            const r=control.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
            if(!r.width||!r.height||y<0||y>=innerHeight||x<0||x>=innerWidth)continue;
            checked++;
            if(y>=t.top&&y<t.bottom&&x>=t.left&&x<t.right)overlaps++;
            if(!control.contains(document.elementFromPoint(x,y)))return {ok:false,checked,overlaps};
          }
          return {ok:checked>0,checked,overlaps};
        })()`);
        assert.equal(result.ok, true, `${width}/${appearance}/${menu}: menu choices receive pointer input`);
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

module.exports = {checkBrowseMenus};
