"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {once} = require("node:events");
async function checkThemes({window, miniPlayer}) {
 const owner=window.webContents, initialBounds=window.getBounds(), shots=process.env.TAGCAST_THEME_SCREENSHOTS;
 const run=code=>owner.executeJavaScript(code);
 const frame=()=>run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 const capture=async name=>{if(shots){await frame();fs.writeFileSync(path.join(shots,name+'.png'),(await owner.capturePage()).toPNG());}};
 const before=await run(`(()=>{globalThis.themeCheckAudio=audio;globalThis.themeCheckQueue=player.queue;return {storage:localStorage.getItem(TagcastThemes.key),appearance:localStorage.getItem('tagcast-theme'),palette:localStorage.getItem('tagcast-palette')};})()`);
 try {
  await run(`openSettings('interface');window.scrollTo(0,0)`);await capture('before-settings-interface');
  await run(`showSettings('appearance');window.scrollTo(0,0);`);
  assert.equal(await run('document.querySelector("#theme-name").value.length>0'),true);
  assert.equal(await run('document.querySelector("#settings-form").contains(document.querySelector("#theme-editor-form"))'),false);
  await capture('editor-default');
  await run(`document.querySelector('[data-theme-mode="dark"]').click();globalThis.themeCheckRoot=getComputedStyle(document.documentElement).getPropertyValue('--palette-paper');document.querySelector('#theme-name').value='Midnight test';document.querySelector('#theme-name').dispatchEvent(new Event('input',{bubbles:true}));themeEditorColour('paper','#172037',false);`);
  assert.equal(await run("getComputedStyle(document.documentElement).getPropertyValue('--palette-paper')===themeCheckRoot"),true,'Preview must not change the app');
  assert.equal(await run('document.querySelector("#theme-preview").style.getPropertyValue("--palette-paper")'),"#172037");
  await run('document.querySelector(".theme-sample-search input").focus()');
  owner.sendInputEvent({type:'keyDown',keyCode:'Return'});owner.sendInputEvent({type:'keyUp',keyCode:'Return'});await frame();
  assert.equal(await run('TagcastThemes.active()'),null,'Preview search cannot submit Save & use');
  await run(`themeEditorColour('ink','invalid',false);document.querySelector('[data-theme-mode="light"]').click();`);
  assert.equal(await run('Object.hasOwn(themeEditorView.invalid,"ink")'),true,'Invalid input remains visible');
  assert.equal(await run('document.querySelector("#theme-save-use").disabled'),true);
  await run(`themeEditorColour('ink','#e3ebfa',false);document.querySelector('#theme-save-use').click();`);
  assert.equal(await run('Boolean(TagcastThemes.active())'),true);
  assert.equal(await run('themeEditorDirty()'),false);
  await run(`globalThis.themeCheckId=TagcastThemes.active().id;document.querySelector('[data-theme-mode="light"]').click();themeEditorColour('paper','#edf1f9',false);themeEditorColour('ink','#263851',false);document.querySelector('#theme-save').click();`);
  for(const appearance of ['light','dark']) {
   await run(`(()=>{const input=document.querySelector('[data-appearance-choice][value="${appearance}"]');input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   const expected=appearance==='light'?'#edf1f9':'#172037';assert.equal(await run('document.documentElement.style.getPropertyValue("--palette-paper")'),expected);
  }
  await capture('editor-custom-dark');
  await run(`document.querySelector('#theme-name').value='Unsaved renamed draft';document.querySelector('#theme-name').dispatchEvent(new Event('input',{bubbles:true}));showSettings('playback');showSettings('appearance');`);
  assert.equal(await run('document.querySelector("#theme-name").value'),"Unsaved renamed draft");
  await run('document.querySelector("#theme-discard").click();');assert.equal(await run('document.querySelector("#theme-name").value'),"Midnight test");
  await run(`themeEditorColour('ink','#172037',false);`);assert.equal(await run('document.querySelector("#theme-contrast").textContent.includes("Low contrast")'),true);await run('document.querySelector("#theme-discard").click();');
  // Exercise a real Chromium download, then import the same portable file as a new draft.
  const exportPath=path.join(path.dirname(process.env.TAGCAST_ELECTRON_SMOKE_REPORT),'shared-theme.json');
  const downloaded=new Promise((resolve,reject)=>owner.session.once('will-download',(_event,item)=>{
   item.setSavePath(exportPath);item.once('done',(_event,state)=>state==='completed'?resolve():reject(Error('Theme download '+state)));
  }));
  await run("document.querySelector('#theme-export').click()");await downloaded;
  const shared=fs.readFileSync(exportPath,'utf8');assert.equal(JSON.parse(shared).format,'tagcast-theme');
  assert.deepEqual(Object.keys(JSON.parse(shared).theme),['name','base','light','dark']);
  await run(`importCustomTheme(new File([${JSON.stringify(shared)}],'shared-theme.json',{type:'application/json'}))`);
  assert.equal(await run('themeEditorDirty()'),true);
  assert.equal(await run('themeEditorView.draft.id!==themeCheckId&&TagcastThemes.active().id===themeCheckId'),true);
  assert.equal(await run('TagcastThemes.snapshot().themes.length'),1);
  await capture('theme-import-preview');
  await run('document.querySelector("#theme-save").click()');assert.equal(await run('TagcastThemes.snapshot().themes.length'),2);
  await run('themeEditorLoad(TagcastThemes.snapshot().themes.find(t=>t.id===themeCheckId));renderThemeEditor();');
  // Palette changes must preserve the authoritative audio element and queue object.
  for(const palette of ['forest','ocean','warm','ibroadcast'])for(const appearance of ['light','dark']) {
   await run(`setColourPalette('${palette}');document.documentElement.dataset.theme='${appearance}';showTheme();showSettings('appearance');themeEditorView.mode='${appearance}';renderThemeEditor();document.querySelector('#theme-editor-form').scrollIntoView({block:'start'});window.scrollBy(0,-20);`);
   assert.equal(await run('themeCheckAudio===audio&&themeCheckQueue===player.queue'),true);
   assert.equal(await run('document.documentElement.scrollWidth>innerWidth'),false);
   await capture(`editor-${palette}-${appearance}`);
  }
  await run(`TagcastThemes.activate(themeCheckId);showTheme();showSettings('appearance');`);
  const layouts=[];
  for(const width of [420,760,761,768,1280,1420]) {
   window.setSize(width,800);await frame();await run("document.querySelector('#theme-editor-form').scrollIntoView({block:'start'});window.scrollBy(0,-20)");
   const metrics=await run(`(()=>{const r=document.querySelector('#theme-editor').getBoundingClientRect(),p=document.querySelector('#theme-preview').getBoundingClientRect();return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,editor:r.width,preview:p.width};})()`);
   assert.equal(metrics.overflow,false,JSON.stringify(metrics));assert.ok(metrics.preview>200);
   assert.equal(await run(`Array.from(document.querySelectorAll('.theme-hex')).filter(n=>n.getClientRects().length).every(n=>n.clientWidth>=80)`),true,'Readable hex fields at '+width);
   assert.equal(await run(`document.querySelector('.theme-sample-card>div:last-child').getBoundingClientRect().width>=90`),true,'Readable preview card at '+width);
   layouts.push(metrics);await capture(`editor-${width}`);if(width<=768){await run("document.querySelector('#theme-preview').scrollIntoView({block:'start'});window.scrollBy(0,-20)");await capture(`preview-${width}`);}
  }
  window.setSize(1280,800);owner.setZoomFactor(2);await frame();await run("document.querySelector('#theme-editor-form').scrollIntoView({block:'start'})");assert.equal(await run('document.documentElement.scrollWidth>innerWidth'),false);await capture('editor-200-percent');owner.setZoomFactor(1);
  await run(`document.querySelector('#theme-name').focus();document.querySelector('#theme-name').setSelectionRange(0,1);`);
  owner.sendInputEvent({type:'keyDown',keyCode:'Tab'});owner.sendInputEvent({type:'keyUp',keyCode:'Tab'});await frame();
  assert.equal(await run('document.activeElement.dataset.themeMode'),"light",'Keyboard reaches variant control');
  await run(`document.querySelector('#theme-hex-paper').focus();`);
  assert.equal(await run('getComputedStyle(document.activeElement).outlineStyle!=="none"'),true,'Visible keyboard focus');
  await run(`setColourPalette('forest');showTheme();window.scrollTo(0,0);setThemeMenu(true);document.querySelector('[data-custom-theme-choice]').focus();document.querySelector('[data-custom-theme-choice]').click();`);
  assert.equal(await run('document.activeElement.value===themeCheckId'),true,'Quick theme selection preserves keyboard focus');
  assert.equal(await run('TagcastThemes.active().id===themeCheckId'),true);
  await capture('theme-menu');
  await run('setThemeMenu(false,true);publishMiniPlayer();');
  assert.equal(await run('document.activeElement.id'),'theme-button');
  miniPlayer.open();const mini=miniPlayer.window;await once(mini.webContents,'did-finish-load');
  for(let n=0;n<40;n++){if(await mini.webContents.executeJavaScript('document.documentElement.style.getPropertyValue("--palette-paper")==="#172037"'))break;await new Promise(resolve=>setTimeout(resolve,40));}
  assert.equal(await mini.webContents.executeJavaScript('document.documentElement.style.getPropertyValue("--palette-paper")'),"#172037");
  assert.equal(await mini.webContents.executeJavaScript('document.querySelectorAll("audio,video").length'),0);
  if(shots)fs.writeFileSync(path.join(shots,'mini-custom.png'),(await mini.webContents.capturePage()).toPNG());
  miniPlayer.showMain();
  assert.equal(await run('themeCheckAudio===audio&&themeCheckQueue===player.queue'),true);
  await run(`localStorage.setItem('tagcast-theme','auto');delete document.documentElement.dataset.theme;showTheme();`);
  const saved=await run('TagcastThemes.active().id');
  await owner.reload();await once(owner,'did-finish-load');
  assert.equal(await run('TagcastThemes.active().id'),saved,'Saved theme survives a full reload');
  return {savedAndReloaded:true,exportedAndImported:true,previewIsolated:true,invalidInputRetained:true,variantsIndependent:true,draftRetained:true,keyboard:true,sameAudioAndQueue:true,miniColours:true,layouts};
 } finally {
  owner.setZoomFactor(1);window.setBounds(initialBounds);
  await run(`for(const [key,value]of Object.entries(${JSON.stringify({"tagcast-custom-themes":before.storage,"tagcast-theme":before.appearance,"tagcast-palette":before.palette})})){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}themeEditorView.draft=null;themeEditorView.baseline=null;`).catch(()=>{});
 }
}
module.exports={checkThemes};
