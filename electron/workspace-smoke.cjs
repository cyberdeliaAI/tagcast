"use strict";
const assert = require("node:assert/strict");

// Exercise real pointer and keyboard input in each packaged platform, not .click().
async function checkWorkspace(window) {
  const owner = window.webContents, bounds = window.getBounds();
  const run = code => owner.executeJavaScript(code);
  const frame = () => run("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const click = async selector => {
    const point = await run(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({block:'nearest',inline:'nearest'});const r=node.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    owner.sendInputEvent({type:"mouseMove", ...point}); await frame();
    const hit = await run(`(()=>{const node=document.querySelector(${JSON.stringify(selector)}),hit=document.elementFromPoint(${point.x},${point.y});
      return {ok:node.contains(hit),hit:hit?.className,pointer:getComputedStyle(node).pointerEvents,rect:node.getBoundingClientRect().toJSON()};})()`);
    assert.equal(hit.ok, true, selector + " receives pointer input " + JSON.stringify(hit));
    owner.sendInputEvent({type:"mouseDown", ...point, button:"left", clickCount:1});
    owner.sendInputEvent({type:"mouseUp", ...point, button:"left", clickCount:1}); await frame();
  };
  const before = await run(`(()=>{globalThis.workspaceSmokeAudio=audio;
    return {screen:state.screen,sort:$('#sort').value,filter:$('#filter').value,tab:workspacePanel.tab,
      collapsed:navigationCollapsed,appearance:document.documentElement.dataset.theme,
      navigation:localStorage.getItem('tagcast-navigation-collapsed'),sorts:localStorage.getItem('tagcast-browse-sorts'),queueSync:queueSync.enabled};})()`);
  const samples = [];
  try {
    assert.equal(await run('state.mode'), 'demo', 'Packaged interface checks use only synthetic demo metadata');
    assert.equal(await run("$('#workspace-panel-toggle') === $('.top-actions').lastElementChild"), true, 'Panel control follows Live');
    assert.equal(await run("$('#workspace-playlist').contains($('#devices-button'))"), true, 'Devices belongs to Playlist');
    for (const width of [420, 760, 768, 1280]) for (const appearance of ["light", "dark"]) {
      window.setContentSize(width, 800);
      await run(`setNowPlaying(false);document.documentElement.dataset.theme=${JSON.stringify(appearance)};
        navigationCollapsed=false;syncNavigationToggle();showScreen('albums');$('#sort').value='artist';$('#filter').value='all';render();window.scrollTo(0,0)`);
      await frame();
      if (width > 760) {
        await click("#navigation-toggle");
        assert.equal(await run("document.querySelector('#sidebar').hidden"), true);
        await click("#navigation-toggle");
      }
      await click('#albums-sort-buttons [data-sort-group="1"]');
      assert.equal(await run("$('#sort').value"), 'title');
      await click('#albums-sort-buttons [data-sort-group="1"]');
      assert.equal(await run("$('#sort').value"), 'title_za');
      const sortHeight = await run("$('#albums-sort-buttons button').getBoundingClientRect().height");
      await click('#albums-browse-options');
      assert.equal(await run("document.querySelectorAll('#browse-options-menu [data-browse-choice^=\"sort:\"]').length"), 0);
      assert.equal(await run("document.querySelectorAll('#browse-options-menu [data-browse-close]').length"), 0);
      assert.ok(await run("$('#browse-options-menu').getBoundingClientRect().width <= 340"), 'Filters fit one compact column');
      owner.sendInputEvent({type:"keyDown", keyCode:"Escape"}); owner.sendInputEvent({type:"keyUp", keyCode:"Escape"}); await frame();
      assert.equal(await run("document.activeElement === $('#albums-browse-options')"), true);
      await click('#albums-browse-options');
      await click('[data-browse-choice="filter:all"]');
      await run("openAlbum('1')"); await frame();
      assert.equal(await run("document.querySelector('[data-play-album]').textContent.trim()"), '▶ Play');
      assert.equal(await run("document.querySelector('[data-shuffle-album]').getAttribute('aria-label')"), 'Shuffle album');
      assert.equal(await run("document.querySelectorAll('[data-shuffle-album] svg[aria-hidden=true]').length"), 1);
      assert.equal(await run("document.querySelector('[data-shuffle-album]').textContent.trim()"), '');
      assert.equal(await run("document.querySelectorAll('.album-detail-actions [data-playlist-album]').length"), 0);

      const hover = await run(`(()=>{const node=document.querySelector('[data-workspace-track]');
        node.scrollIntoView({block:'center'});const r=node.closest('tr').getBoundingClientRect();return {x:r.x+15,y:r.y+r.height/2};})()`);
      owner.sendInputEvent({type:"mouseMove", ...hover}); await frame();
      await click('[data-workspace-track]');
      assert.equal(await run("$('#workspace-details').hidden"), false);
      assert.equal(await run("$('#workspace-playlist').hidden"), true);
      assert.equal(await run("document.querySelectorAll('#workspace-details input,#workspace-details textarea').length"), 0);
      const compact = await run(`({tab:$('#workspace-tab-details').getBoundingClientRect().height,
        coarse:matchMedia('(pointer:coarse)').matches})`);
      if (width > 760 && !compact.coarse) {
        assert.ok(sortHeight <= 32 && compact.tab <= 32, 'Desktop sorting and tabs stay compact');
      } else {
        assert.ok(sortHeight >= 44 && compact.tab >= 44, 'Touch controls retain large targets');
      }
      owner.sendInputEvent({type:"keyDown", keyCode:"Left"}); owner.sendInputEvent({type:"keyUp", keyCode:"Left"}); await frame();
      assert.equal(await run('workspacePanel.tab'), 'playlist');
      if (width > 760) assert.equal(await run("$('#sidebar').hidden"), false, 'Opening the panel keeps navigation open');
      await run('applyQueueSettings({queue_sync:true})');
      await click('#devices-button');
      assert.equal(await run("$('#devices-dialog').open"), true);
      await click('[data-close="devices-dialog"]');
      assert.equal(await run("document.activeElement === $('#devices-button')"), true);
      await run(`applyQueueSettings({queue_sync:${before.queueSync}})`);
      await click('#workspace-tab-playlist');
      owner.sendInputEvent({type:"keyDown", keyCode:"Right"}); owner.sendInputEvent({type:"keyUp", keyCode:"Right"}); await frame();
      assert.equal(await run('workspacePanel.tab'), 'details');
      owner.sendInputEvent({type:"keyDown", keyCode:"Escape"}); owner.sendInputEvent({type:"keyUp", keyCode:"Escape"}); await frame();
      assert.equal(await run("$('#now-playing-panel').hidden"), true);
      assert.equal(await run("document.activeElement.matches('[data-workspace-track]')"), true);
      assert.equal(await run('workspaceSmokeAudio===audio'), true);
      assert.ok(await run('document.documentElement.scrollWidth-innerWidth<=1'), `${width}/${appearance}: no horizontal overflow`);
      samples.push({width, appearance, pointer:true, keyboard:true, sameAudio:true});
    }
    const restored = await require("./restored-details-smoke.cjs").checkRestoredDetails({window,run,click,frame});
    return [...samples, {restored}];
  } finally {
    window.setBounds(bounds);
    await run(`setNowPlaying(false);workspacePanel.selection=null;workspacePanel.focus=null;
      workspacePanel.tab=${JSON.stringify(before.tab)};navigationCollapsed=${before.collapsed};syncNavigationToggle();applyQueueSettings({queue_sync:${before.queueSync}});
      ${before.appearance ? `document.documentElement.dataset.theme=${JSON.stringify(before.appearance)}` : "delete document.documentElement.dataset.theme"};
      for(const [key,value]of ${JSON.stringify([["tagcast-navigation-collapsed", before.navigation], ["tagcast-browse-sorts", before.sorts]])}){
        if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);
      }
      $('#sort').value=${JSON.stringify(before.sort)};$('#filter').value=${JSON.stringify(before.filter)};showScreen(${JSON.stringify(before.screen)});render();`);
  }
}
module.exports = {checkWorkspace};
