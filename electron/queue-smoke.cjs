"use strict";
const assert = require("node:assert/strict");

// Test the rendered queue, including pointer and keyboard states outside the track button.
async function checkQueueRows(window) {
  const owner = window.webContents, run = code => owner.executeJavaScript(code), samples = [];
  for (const index of [0, 1]) {
    await run(`document.querySelectorAll('#now-playing-list .queue-row')[${index}].scrollIntoView({block:'nearest'})`);
    const point = await run(`(() => {const r=document.querySelectorAll('#now-playing-list .queue-track')[${index}].getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    owner.sendInputEvent({type:"mouseMove", ...point});
    for (const interaction of ["hover", "focus"]) {
      if (interaction === "focus") {
        owner.sendInputEvent({type:"mouseMove",x:0,y:0});
        await run(`document.querySelectorAll('#now-playing-list .queue-row-more')[${index}].focus()`);
      }
      await run("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      const sample = await run(`(() => {
        const row=document.querySelectorAll('#now-playing-list .queue-row')[${index}],track=row.querySelector('.queue-track'),more=row.querySelector('.queue-row-more');
        return {hover:row.matches(':hover'),focus:row.matches(':focus-within'),
          indicator:getComputedStyle(row.querySelector('.queue-number')).visibility,
          rowBackground:getComputedStyle(row).backgroundColor,trackBackground:getComputedStyle(track).backgroundColor,
          fullWidth:row.getBoundingClientRect().right>=more.getBoundingClientRect().right};
      })()`);
      assert.equal(sample[interaction], true, `Queue row ${index}: real ${interaction}`);
      assert.equal(sample.indicator, "visible", "Number or playing indicator stays visible");
      assert.notEqual(sample.rowBackground, "rgba(0, 0, 0, 0)", "Highlight belongs to the entire row");
      assert.equal(sample.trackBackground, "rgba(0, 0, 0, 0)", "Track button adds no partial highlight");
      assert.equal(sample.fullWidth, true, "Highlight includes the action menu");
      samples.push({index, interaction, ...sample});
    }
    await run("document.activeElement.blur()");
  }
  owner.sendInputEvent({type:"mouseMove",x:0,y:0});
  return samples;
}

module.exports = {checkQueueRows};
