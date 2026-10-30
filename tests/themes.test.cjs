"use strict";
const {test} = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/tagcast/static/themes.js"), "utf8");
function browser(storage = {}, dark = false) {
  const properties = {}, events = [], listeners = {};
  const document = {documentElement:{dataset:{},style:{setProperty(k,v){properties[k]=v;},removeProperty(k){delete properties[k];}}},dispatchEvent(event){events.push(event.type);}};
  const media = {matches:dark,addEventListener(_,fn){listeners.media=fn;}};
  const context = vm.createContext({document, structuredClone, Event, localStorage:{getItem(k){return storage[k] ?? null;},setItem(k,v){storage[k]=v;}},matchMedia:()=>media,addEventListener(name,fn){listeners[name]=fn;}});
  vm.runInContext(source, context);
  return {api:context.TagcastThemes,document,properties,events,storage,context,media,listeners};
}
function theme(id="custom-12345678", name="My ocean") {return {id,name,base:"ocean",light:{paper:"#F0F1F2"},dark:{paper:"#102030",ink:"#EEEEEE"}};}
test("custom themes persist separately from appearance and restore before first paint",()=>{
  const b=browser({"tagcast-theme":"auto","tagcast-palette":"warm"},true), t=theme();
  b.api.save(t,true);assert.equal(b.document.documentElement.dataset.theme,undefined);assert.equal(b.properties["--palette-paper"],"#102030");
  assert.equal(b.storage["tagcast-palette"],"warm");assert.equal(b.storage["tagcast-theme"],"auto");
  const restarted=browser(b.storage,true);assert.equal(restarted.api.active().id,t.id);assert.equal(restarted.properties["--palette-ink"],"#eeeeee");
  restarted.media.matches=false;restarted.listeners.media();assert.equal(restarted.properties["--palette-paper"],"#f0f1f2");assert.equal(restarted.properties["--palette-ink"],undefined);
  assert.equal(restarted.document.documentElement.dataset.palette,"ocean");
  restarted.api.builtin("warm");assert.equal(restarted.api.active(),null);assert.equal(Object.keys(restarted.properties).length,0);assert.equal(restarted.document.documentElement.dataset.palette,"warm");
  assert.equal(restarted.api.snapshot().themes.length,1,"Built-in choices retain saved themes");
});
test("preview-only saves, activation, editing and deletion retain independent variants",()=>{
 const b=browser({"tagcast-palette":"ibroadcast"}),t=theme();b.api.save(t);assert.equal(b.api.active(),null);assert.equal(Object.keys(b.properties).length,0);
 b.api.activate(t.id);assert.equal(b.properties["--palette-paper"],"#f0f1f2");
 const changed=structuredClone(t);changed.dark.primary="#123456";b.api.save(changed);assert.equal(b.api.snapshot().themes.length,1);assert.equal(b.api.active().dark.primary,"#123456");
 const snapshot=b.api.snapshot();snapshot.themes[0].light.paper="#ffffff";assert.equal(b.api.active().light.paper,"#f0f1f2","Snapshots cannot alter saved themes");
 b.api.remove(t.id);assert.equal(b.api.active(),null);assert.equal(b.document.documentElement.dataset.palette,"ibroadcast");assert.deepEqual(b.properties,{});
});
test("unavailable storage never pretends to save and built-ins still work immediately",()=>{
 const b=browser();b.api.save(theme(),true);const before=JSON.stringify(b.api.snapshot());
 b.context.localStorage.setItem=()=>{throw Object.assign(Error("full"),{name:"QuotaExceededError"});};
 for(const action of [()=>b.api.save(theme("custom-abcdefgh"),true),()=>b.api.remove(theme().id)])assert.throws(action,/full/);
 assert.equal(JSON.stringify(b.api.snapshot()),before);assert.equal(b.api.active().id,theme().id);
 b.api.builtin("warm");b.api.apply();assert.equal(b.document.documentElement.dataset.palette,"warm");assert.equal(b.api.active(),null);assert.deepEqual(b.properties,{});
});
test("stored themes accept only bounded colour roles, safe IDs and hex values",()=>{
 const api=browser().api,t=theme();
 for(const bad of [null,{}, {...t,id:'bad" onclick=alert(1)'},{...t,name:" "},{...t,name:"x".repeat(61)},{...t,base:"url(fake)"},{...t,light:{ink:"url(https://example.test)"}},{...t,dark:{ink:"#fff"}},{...t,dark:{unknown:"#ffffff"}},{...t,light:[]}])assert.equal(api.cleanTheme(bad),null);
 for(const raw of ["not-json","x".repeat(65537),JSON.stringify({version:2,themes:[t]}),JSON.stringify({version:1,themes:[t,t]})])assert.equal(api.decode(raw).themes.length,0);
 assert.equal(api.cleanTheme({...t,name:'<b>Untrusted name</b>'}).name,'<b>Untrusted name</b>',"Names are plain text, escaped by the UI");
 for(let n=0;n<20;n++)api.save(theme(`custom-${String(n).padStart(8,"0")}`));
 assert.throws(()=>api.save(theme("custom-overlimit")),/at most 20/);api.save(theme("custom-00000000","Updated"));assert.equal(api.snapshot().themes.length,20);
});
test("theme base colours match existing palette tokens and Mini Player allows exactly the same roles",()=>{
 const api=browser().api, {themeRoles,snapshot}=require("../electron/mini-contract.cjs");
 assert.deepEqual([...api.roles],themeRoles);
 const css=fs.readFileSync(path.join(__dirname,"../src/tagcast/static/palettes.css"),"utf8");
 for(const base of ["ocean","warm","ibroadcast"])for(const mode of ["light","dark"]){
   const selector=mode==="light"?`:root[data-palette="${base}"]`:`:root[data-palette="${base}"][data-theme="dark"]`;
   const block=css.slice(css.indexOf(selector));const tokens=[...block.slice(block.indexOf("{"),block.indexOf("}")).matchAll(/--palette-([a-z-]+):\s*(#[0-9a-f]{6})/g)];
   assert.ok(tokens.length>=12);const colours=api.colours({base,light:{},dark:{}},mode);
   for(const [,role,value]of tokens)assert.equal(colours[role],value,`${base}/${mode}/${role}`);
 }
 const result=snapshot({document:"d",entry:"e",segment:"s",sequence:1,duration:5,colours:{ink:"#ABCDEF",paper:"url(secret)",token:"private",focus:"#123456"}});
 assert.deepEqual(result.colours,{ink:"#abcdef",focus:"#123456"});assert.equal(Object.keys(result.colours).length,2);
 assert.equal(api.contrast("#000000","#ffffff"),21);
});
