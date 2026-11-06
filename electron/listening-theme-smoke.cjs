"use strict";
const assert = require("node:assert/strict");

// Exercise computed colours in the packaged production UI, including the cover tint.
async function checkListeningThemes(window) {
  const run = code => window.webContents.executeJavaScript(code);
  const samples = [];
  await run(`(() => {
    globalThis.listeningThemeCheck = {queue:player.queue,index:player.index,album:player.album,
      screen:state.screen,mode:state.mode,audio,source:audio.src,time:audio.currentTime,paused:audio.paused,palette:localStorage.getItem('tagcast-palette')||'forest',
      appearance:document.documentElement.dataset.theme,custom:TagcastThemes.active()?.id};
    const album={...state.details.values().next().value,artwork:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="teal"/></svg>')};
    player.queue=[{...album.tracks[0],album}];player.index=0;player.album=album;state.mode='live';
    showScreen('now-playing');
  })()`);
  try {
    for (const palette of ["forest", "ocean", "warm", "ibroadcast", "apple", "amber"]) {
      const modes = [];
      for (const appearance of ["light", "dark", "auto"]) {
        await run(`setThemeMenu(true);document.querySelector('#palette-${palette}').click();document.querySelector('#appearance-${appearance}').click();setThemeMenu(false);`);
        for (let n = 0; n < 40; n++) {
          if (await run(`document.querySelector('main').classList.contains('listening-atmosphere')`)) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        const sample = await run(`(() => {
          renderLyricsCoverBackground();
          const root=getComputedStyle(document.documentElement),main=document.querySelector('main'),style=getComputedStyle(main);
          return {appearance:'${appearance}',saved:localStorage.getItem('tagcast-theme'),root:root.backgroundColor,
            background:style.backgroundColor,ink:style.color,rootInk:root.color,
            tinted:main.classList.contains('listening-atmosphere'),menu:getComputedStyle(document.querySelector('#theme-menu')).backgroundColor};
        })()`);
        assert.equal(sample.saved, appearance, `${palette}: choice persisted`);
        assert.equal(sample.tinted, true, `${palette}/${appearance}: loaded artwork tint remains`);
        assert.equal(sample.background, sample.root, `${palette}/${appearance}: page follows appearance`);
        assert.equal(sample.ink, sample.rootInk, `${palette}/${appearance}: readable page foreground`);
        await run("openVisualPlayer()");
        for (let n = 0; n < 40; n++) {
          if (await run("document.querySelector('#visual-player').classList.contains('cover-atmosphere')")) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        const expanded = await run(`(() => {const e=document.querySelector('#visual-player'),s=getComputedStyle(e);return {background:s.backgroundColor,ink:s.color,tinted:e.classList.contains('cover-atmosphere')};})()`);
        assert.equal(expanded.tinted, true, `${palette}/${appearance}: expanded artwork tint remains`);
        assert.equal(expanded.background, sample.root, `${palette}/${appearance}: expanded appearance`);
        assert.equal(expanded.ink, sample.rootInk);
        await run("closeVisualPlayer()");
        modes.push(sample);
      }
      assert.notEqual(modes[0].background, modes[1].background, palette);
      assert.notEqual(modes[0].menu, modes[1].menu, `${palette}: menu also changes`);
      samples.push({palette, modes});
    }
    assert.equal(await run("audio===listeningThemeCheck.audio && audio.src===listeningThemeCheck.source && (!listeningThemeCheck.paused || audio.currentTime===listeningThemeCheck.time)"), true, "Appearance never replaces the audio source or seeks a paused player");
    return samples;
  } finally {
    await run(`(() => {
      closeVisualPlayer();const before=listeningThemeCheck;
      player.queue=before.queue;player.index=before.index;player.album=before.album;state.mode=before.mode;
      if(before.appearance)document.documentElement.dataset.theme=before.appearance;else delete document.documentElement.dataset.theme;
      localStorage.setItem('tagcast-theme',before.appearance||'auto');
      if(before.custom)TagcastThemes.activate(before.custom);else setColourPalette(before.palette);
      showTheme();showScreen(before.screen);delete globalThis.listeningThemeCheck;
    })()`);
  }
}
module.exports = {checkListeningThemes};
