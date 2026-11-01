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

test("theme files round-trip both variants without local IDs, active state or other settings",()=>{
  const b=browser({'tagcast-theme':'dark','private-setting':'do-not-export'}),t=theme();
  b.api.save(t,true);const before=JSON.stringify(b.api.snapshot()),raw=b.api.exportTheme(t),data=JSON.parse(raw);
  assert.deepEqual(Object.keys(data),['format','version','theme']);
  assert.deepEqual(Object.keys(data.theme),['name','base','light','dark']);
  assert.doesNotMatch(raw,/custom-|active|private-setting|do-not-export/);
  const imported=b.api.importTheme('\uFEFF'+raw,'custom-imported1');
  assert.equal(imported.id,'custom-imported1');assert.equal(imported.name,t.name);
  assert.equal(imported.light.paper,'#f0f1f2');assert.equal(imported.dark.paper,'#102030');
  assert.equal(JSON.stringify(b.api.snapshot()),before,'Parse/export never changes saved or active themes');
  b.api.save(imported,false);assert.equal(b.api.snapshot().themes.length,2);assert.equal(b.api.active().id,t.id);
});

test("theme import rejects malformed, oversized, unsupported or executable values",()=>{
  const api=browser().api,valid=JSON.parse(api.exportTheme(theme())),read=value=>api.importTheme(JSON.stringify(value),'custom-imported1');
  for(const raw of ['not JSON','x'.repeat(api.fileLimit+1)])assert.throws(()=>api.importTheme(raw,'custom-imported1'),/valid Tagcast theme/);
  for(const value of [null,[],{}, {...valid,format:'other'}, {...valid,version:2}, {...valid,active:'custom-12345678'},
    {...valid,theme:{...valid.theme,id:'custom-overwrite'}}, {...valid,theme:{...valid.theme,token:'secret'}}])assert.throws(()=>read(value),/not a supported Tagcast theme/);
  for(const value of [{...valid.theme,base:'external'}, {...valid.theme,light:{paper:'url(https://example.test)'}},
    {...valid.theme,dark:{ink:'#fff'}}, {...valid.theme,light:{'__proto__':'#ffffff',unknown:'#ffffff'}}, {...valid.theme,name:''}])assert.throws(()=>read({...valid,theme:value}),/name.*palette.*hex/);
  assert.throws(()=>api.exportTheme({...theme(),dark:{ink:'red'}}),/hex colours/);
});

test("optional sidebar icon colours restore per variant and clear on legacy or built-in themes",()=>{
  const b=browser({'tagcast-theme':'auto','tagcast-palette':'warm'}), legacy=theme(), t=theme('custom-iconstest','Coloured icons');
  t.light['nav-icon']='#C8102E';t.dark['nav-icon']='#FF6476';
  b.api.save(t,true);assert.equal(b.properties['--palette-nav-icon'],'#c8102e');
  assert.equal(b.storage['tagcast-theme'],'auto');assert.equal(b.storage['tagcast-palette'],'warm');
  const restarted=browser(b.storage,true);assert.equal(restarted.properties['--palette-nav-icon'],'#ff6476');
  const raw=restarted.api.exportTheme(restarted.api.active());
  assert.equal(restarted.api.importTheme(raw,'custom-importedicons').dark['nav-icon'],'#ff6476');
  restarted.api.save(legacy,true);assert.equal(restarted.properties['--palette-nav-icon'],undefined);
  assert.equal(Object.hasOwn(restarted.api.active().dark,'nav-icon'),false,'Legacy themes retain state-dependent inherited colours');
  restarted.api.activate(t.id);restarted.api.builtin('ocean');assert.equal(restarted.properties['--palette-nav-icon'],undefined);
  const withoutDark=restarted.api.cleanTheme({...t,dark:{}});restarted.api.save(withoutDark,true);
  assert.equal(restarted.properties['--palette-nav-icon'],undefined,'A missing variant never inherits the other variant icon colour');
  assert.equal(restarted.api.cleanTheme({...t,light:{'nav-icon':'currentColor'}}),null,'Inheritance is omission, not executable CSS');
  const {snapshot}=require('../electron/mini-contract.cjs');
  assert.deepEqual(snapshot({document:'d',entry:'e',segment:'s',sequence:1,colours:{'nav-icon':'#C8102E'}}).colours,{'nav-icon':'#c8102e'});
});

test("existing portable theme collection round-trips without adding icon overrides",()=>{
  const api=browser().api, directory=path.join(__dirname,'../docs/themes');
  for(const file of fs.readdirSync(directory).filter(file=>file.endsWith('.json'))){
    const raw=fs.readFileSync(path.join(directory,file),'utf8'), imported=api.importTheme(raw,'custom-legacyimport');
    for(const mode of ['light','dark']){
      assert.equal(Object.hasOwn(imported[mode],'nav-icon'),false,file);
      assert.deepEqual(JSON.parse(api.exportTheme(imported)).theme[mode],JSON.parse(raw).theme[mode],file);
    }
  }
});

test("Apple Music Classic restores before paint and custom themes can inherit its variants",()=>{
  const b=browser({'tagcast-palette':'apple','tagcast-theme':'auto'},true);
  assert.equal(b.document.documentElement.dataset.palette,'apple');assert.equal(b.api.active(),null);
  const t={id:'custom-applebase',name:'My Apple Music',base:'apple',light:{},dark:{}};
  assert.equal(b.api.colours(t,'light')['nav-icon'],'#c8102e');assert.equal(b.api.colours(t,'dark')['nav-icon'],'#ff6476');
  b.api.save(t,true);const restarted=browser(b.storage,true);
  assert.equal(restarted.api.active().base,'apple');assert.equal(restarted.storage['tagcast-theme'],'auto');
  restarted.api.builtin('apple');assert.equal(restarted.document.documentElement.dataset.palette,'apple');
  const {snapshot}=require('../electron/mini-contract.cjs');
  assert.equal(snapshot({document:'d',entry:'e',segment:'s',sequence:1,palette:'apple'}).palette,'apple');
});
