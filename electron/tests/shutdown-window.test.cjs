"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {installShutdownWindow}=require("../shutdown-window.cjs");

function fixture(){
  const ipcMain=new EventEmitter(),windows=[];let reopened=0;
  class Window extends EventEmitter {
    constructor(options){
      super();this.options=options;this.visible=true;this.destroyed=false;
      this.webContents=new EventEmitter();this.webContents.mainFrame={};
      this.webContents.getURL=()=>this.url;
      this.webContents.send=(_channel,value)=>{this.state=value;};
      this.webContents.setWindowOpenHandler=handler=>{this.open=handler;};
      this.webContents.session={setPermissionCheckHandler:fn=>{this.permission=fn;},setPermissionRequestHandler(){},setDevicePermissionHandler(){}};
      windows.push(this);
    }
    loadURL(url){this.url=url;return Promise.resolve();}
    isDestroyed(){return this.destroyed;}
    isMinimized(){return this.minimized;}
    restore(){this.minimized=false;}
    show(){this.visible=true;}
    focus(){this.focused=true;}
    destroy(){this.destroyed=true;this.emit("closed");}
  }
  const controller=installShutdownWindow(key=>key,()=>{reopened++;},{BrowserWindow:Window,ipcMain});
  controller.show({phase:"checking",elapsed:5},true);
  const view=controller.window,event={sender:view.webContents,senderFrame:view.webContents.mainFrame};
  return {controller,view,windows,ipcMain,event,reopened:()=>reopened};
}

test("shutdown feedback is visible, sandboxed, account-free and has no navigation or generic IPC",()=>{
  const f=fixture(),prefs=f.view.options.webPreferences;
  assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
  assert.equal(prefs.devTools,false);assert.equal(f.view.permission(),false);assert.deepEqual(f.view.open(),{action:"deny"});
  assert.equal(f.view.state.status,"shutdown.phase.checking");assert.equal(f.view.state.elapsed,"shutdown.elapsed 5");
  assert.match(decodeURIComponent(f.view.url),/script-src 'none'/);
  let blocked=false;f.view.webContents.emit("will-navigate",{preventDefault(){blocked=true;}});assert.equal(blocked,true);
  assert.deepEqual(ipcNames(f.ipcMain),["shutdown:ready","shutdown:resume"]);
});
function ipcNames(ipc){return ipc.eventNames().sort();}

test("only the feedback window's exact main frame may resume; finishing cannot be cancelled",()=>{
  const f=fixture();
  for(const event of [{sender:{},senderFrame:f.event.senderFrame},{sender:f.event.sender,senderFrame:{}}])
    f.ipcMain.emit("shutdown:resume",event);
  assert.equal(f.reopened(),0);
  f.ipcMain.emit("shutdown:resume",f.event);assert.equal(f.reopened(),1);
  f.controller.update({phase:"ready",elapsed:6},false);
  f.ipcMain.emit("shutdown:resume",f.event);
  let prevented=false;f.view.emit("close",{preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(f.reopened(),1);
  f.controller.destroy();assert.equal(f.view.isDestroyed(),true);assert.equal(f.controller.window,null);
});

test("repeated close or second launch restores one status window without revealing the main view",()=>{
  const f=fixture();f.view.minimized=true;f.view.visible=false;
  f.controller.show();assert.equal(f.windows.length,1);assert.equal(f.view.minimized,false);assert.equal(f.view.visible,true);
  assert.equal(f.view.focused,true);
  f.view.emit("close",{preventDefault(){}});assert.equal(f.reopened(),1);
});
