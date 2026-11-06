"use strict";
const assert = require("node:assert/strict");

// Inspect Chromium's hover styles even when a CI desktop cannot focus its hidden window.
async function checkQueueRows(window) {
  const owner = window.webContents, run = code => owner.executeJavaScript(code), samples = [];
  const attached = owner.debugger.isAttached(), forced = [];
  if (!attached) owner.debugger.attach("1.3");
  try {
    await owner.debugger.sendCommand("DOM.enable");
    await owner.debugger.sendCommand("CSS.enable");
    const {root} = await owner.debugger.sendCommand("DOM.getDocument");
    for (const index of [0, 1]) {
      await run(`document.querySelectorAll('#now-playing-list .queue-row')[${index}].scrollIntoView({block:'nearest'})`);
      const nodes = [];
      for (const suffix of ["", " > .queue-track"]) {
        const {nodeId} = await owner.debugger.sendCommand("DOM.querySelector", {nodeId:root.nodeId,selector:`#now-playing-list .queue-row:nth-child(${index+1})${suffix}`});
        assert.ok(nodeId, "Rendered queue element exists");
        nodes.push(nodeId);forced.push(nodeId);
        await owner.debugger.sendCommand("CSS.forcePseudoState", {nodeId,forcedPseudoClasses:["hover"]});
      }
      for (const interaction of ["hover", "focus"]) {
        if (interaction === "focus") {
          for (const nodeId of nodes) await owner.debugger.sendCommand("CSS.forcePseudoState", {nodeId,forcedPseudoClasses:[]});
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
        assert.equal(sample[interaction], true, `Queue row ${index}: Chromium ${interaction} state`);
        assert.equal(sample.indicator, "visible", "Number or playing indicator stays visible");
        assert.notEqual(sample.rowBackground, "rgba(0, 0, 0, 0)", "Highlight belongs to the entire row");
        assert.equal(sample.trackBackground, "rgba(0, 0, 0, 0)", "Track button adds no partial highlight");
        assert.equal(sample.fullWidth, true, "Highlight includes the action menu");
        samples.push({index, interaction, ...sample});
      }
      await run("document.activeElement.blur()");
    }
    return samples;
  } finally {
    for (const nodeId of forced) await owner.debugger.sendCommand("CSS.forcePseudoState", {nodeId,forcedPseudoClasses:[]}).catch(()=>{});
    if (!attached) owner.debugger.detach();
  }
}

module.exports = {checkQueueRows};
