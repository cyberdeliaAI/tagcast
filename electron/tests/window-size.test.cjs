"use strict";
const {test} = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {EventEmitter} = require("node:events");
const {windowSize, rememberWindowSize} = require("../window-size.cjs");
const defaults={width:1420,height:960,minWidth:420,minHeight:600}, area={width:1920,height:1080};

test("saved sizes restore within the current screen and corrupted preferences safely fall back",t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'tagcast-window-size-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const file=path.join(folder,'window.json');
  assert.equal(windowSize(file,defaults,area).width,1420);
  fs.writeFileSync(file,JSON.stringify({width:1100,height:720}));
  assert.deepEqual(windowSize(file,defaults,area),{width:1100,height:720,minWidth:420,minHeight:600});
  assert.deepEqual(windowSize(file,defaults,{width:800,height:700}),{width:800,height:700,minWidth:420,minHeight:600});
  fs.writeFileSync(file,JSON.stringify({width:100,height:100}));assert.equal(windowSize(file,defaults,area).width,420);
  for(const invalid of ['{','null','[]','{"width":"1200","height":800}','{"width":-1,"height":800}','x'.repeat(5000)]){
    fs.writeFileSync(file,invalid);assert.equal(windowSize(file,defaults,area).width,1420);
  }
});

test("main and sign-in sizes persist independently, using normal bounds, including programmatic close",t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'tagcast-window-size-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const main=path.join(folder,'main-window.json'),login=path.join(folder,'sign-in-window.json');
  const view=new EventEmitter();let bounds={width:1200,height:740};Object.assign(view,{isDestroyed:()=>false,getNormalBounds:()=>bounds});
  const save=rememberWindowSize(view,main);view.emit('resize');view.emit('close');view.emit('closed');
  assert.deepEqual(JSON.parse(fs.readFileSync(main,'utf8')),bounds);
  const auth=new EventEmitter();Object.assign(auth,{isDestroyed:()=>false,getNormalBounds:()=>({width:500,height:650})});
  const flush=rememberWindowSize(auth,login);flush();auth.emit('closed');
  assert.equal(JSON.parse(fs.readFileSync(main,'utf8')).width,1200);
  assert.equal(JSON.parse(fs.readFileSync(login,'utf8')).width,500);
  bounds={width:1000,height:700};save();assert.equal(windowSize(main,defaults,area).width,1000);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(main,'utf8'))).sort(),['height','width']);
});
