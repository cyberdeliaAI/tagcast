"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),{readFileSync}=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {EventEmitter}=require("node:events");
const {applicationUrl}=require("../security.cjs");
const source=name=>readFileSync(path.join(__dirname,"..",name),"utf8");

test("the isolated owner preload reports only resolved colours, including Auto and custom overrides, without Mini Player",()=>{
  const windowEvents={},documentEvents={},mediaEvents={},exposed={},sent=[];
  const root={dataset:{}},system={matches:true,addEventListener:(name,fn)=>{mediaEvents[name]=fn;}};
  let values={"--paper":"#123456","--ink":"#fedcba","--muted":"#aaaaaa","--white":"#fff","--line":"#456789","--green":"#abcdef"},observe;
  const ipcRenderer={send:(channel,value)=>sent.push({channel,value})};
  vm.runInNewContext(source("player-preload.cjs"),{
    require:()=>({contextBridge:{exposeInMainWorld:(name,value)=>{exposed[name]=value;}},ipcRenderer}),
    window:{addEventListener:(name,fn)=>{windowEvents[name]=fn;}},
    document:{documentElement:root,addEventListener:(name,fn)=>{documentEvents[name]=fn;}},
    getComputedStyle:()=>({getPropertyValue:name=>values[name]||""}),matchMedia:()=>system,
    MutationObserver:class{constructor(callback){observe=callback;}observe(){}}
  });
  assert.equal(sent.length,0);
  windowEvents.DOMContentLoaded();
  assert.equal(sent.at(-1).channel,"desktop:appearance");
  assert.equal(sent.at(-1).value.theme,"dark","Auto follows the operating system");
  assert.equal(sent.at(-1).value.colours.surface,"#fff");
  assert.deepEqual(Object.keys(exposed.tagcastDesktop),["setInterface"],"no additional page-callable bridge");
  const count=sent.length;observe();documentEvents["tagcast-theme-change"]();assert.equal(sent.length,count);
  system.matches=false;mediaEvents.change();assert.equal(sent.at(-1).value.theme,"light");
  root.dataset.theme="dark";values={...values,"--paper":"#0b0b0c","--palette-focus":"#c7a76c","--palette-tint":"#282828"};observe();
  assert.equal(sent.at(-1).value.colours.paper,"#0b0b0c");
  assert.equal(sent.at(-1).value.colours.focus,"#c7a76c");
  assert.equal(sent.at(-1).value.colours.tint,"#282828");
  assert.deepEqual(Object.keys(sent.at(-1).value).sort(),["colours","theme"]);
});

test("appearance IPC accepts only the current application main frame",()=>{
  const ipcMain=new EventEmitter(),accepted=[],origin="http://127.0.0.1:8912",contents={mainFrame:{},isDestroyed:()=>false,getURL:()=>origin+"/#/albums"};
  const main=source("main.cjs"),start=main.indexOf('ipcMain.on("desktop:appearance"'),end=main.indexOf('\napp.on("before-quit"',start);
  const context={ipcMain,window:{webContents:contents},origin,applicationUrl,shutdownView:{setAppearance:value=>accepted.push(value)}};
  vm.runInNewContext(main.slice(start,end),context);
  const value={colours:{paper:"#123456"}},event={sender:contents,senderFrame:contents.mainFrame};
  ipcMain.emit("desktop:appearance",{...event,sender:{}},value);
  ipcMain.emit("desktop:appearance",{...event,senderFrame:{}},value);
  contents.getURL=()=>origin+"/api/status";ipcMain.emit("desktop:appearance",event,value);
  contents.getURL=()=>"https://example.com";ipcMain.emit("desktop:appearance",event,value);
  assert.equal(accepted.length,0);
  contents.getURL=()=>origin+"/";ipcMain.emit("desktop:appearance",event,value);assert.equal(accepted.length,1);
  context.window=null;ipcMain.emit("desktop:appearance",event,value);assert.equal(accepted.length,1);
});
