"use strict";
const path=require("node:path");
// A local shell status view only: no API, remote content, Node access or generic IPC.
const markup=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'"><style>
body{font:16px system-ui;margin:28px;background:var(--paper);color:var(--ink)}h1{font-size:22px}p{line-height:1.5}#status{font-weight:600}#elapsed{font-size:14px;color:var(--muted)}button{font:inherit;padding:9px 16px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:inherit;cursor:pointer}button:hover{background:var(--tint)}button:focus-visible{outline:3px solid var(--focus);outline-offset:3px}button:disabled{opacity:.6} @media(forced-colors:active){body,button{background:Canvas;color:CanvasText}#elapsed{color:CanvasText}button{border-color:ButtonText}button:focus-visible{outline-color:Highlight}}
</style></head><body><h1 id="title">Tagcast</h1><p id="message"></p><p id="status" role="status" aria-live="polite"></p><p id="elapsed"></p><p id="detail"></p><button id="reopen" disabled></button></body></html>`;
const colourRoles=["paper","ink","muted","surface","line","focus","tint"];
const fallback={theme:"light",colours:{paper:"#f4f4f4",ink:"#202020",muted:"#606060",surface:"#ffffff",line:"#cccccc",focus:"#606060",tint:"#eeeeee"}};
function appearance(value){
  if(!["light","dark"].includes(value?.theme))return null;
  const colours={};
  for(const role of colourRoles){
    const colour=value.colours?.[role];
    if(typeof colour!=="string"||!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(colour))return null;
    colours[role]=(colour.length===4?"#"+[...colour.slice(1)].map(c=>c+c).join(""):colour).toLowerCase();
  }
  return {theme:value.theme,colours};
}
function pageUrl(value){
  const style="color-scheme:"+value.theme+";"+colourRoles.map(role=>"--"+role+":"+value.colours[role]).join(";");
  return "data:text/html;charset=utf-8,"+encodeURIComponent(markup.replace("<html>",`<html style="${style}">`));
}
function installShutdownWindow(text,reopen,deps=require("electron")){
  const {BrowserWindow,ipcMain}=deps;
  let view=null,latest={phase:"reads",elapsed:0},canResume=false,colours=fallback,url=null;
  const from=event=>view&&!view.isDestroyed()&&event.sender===view.webContents&&event.senderFrame===view.webContents.mainFrame&&view.webContents.getURL()===url;
  const publish=()=>{if(view&&!view.isDestroyed())view.webContents.send("shutdown:state",{
    title:text("shutdown.title"),message:text("shutdown.message"),status:text("shutdown.phase."+latest.phase),
    elapsed:text("shutdown.elapsed")+" "+latest.elapsed,detail:text("shutdown.detail"),reopen:text("shutdown.reopen"),canResume,appearance:colours});};
  ipcMain.on("shutdown:ready",event=>{if(from(event))publish();});
  ipcMain.on("shutdown:resume",event=>{if(from(event)&&canResume)reopen();});
  return {
    setAppearance(value){
      const next=appearance(value);if(!next)return;
      colours=next;
      if(view&&!view.isDestroyed())view.setBackgroundColor(next.colours.paper);
      publish();
    },
    show(status=latest,resumable=canResume){
      latest=status;canResume=resumable;
      if(!view||view.isDestroyed()){
        url=pageUrl(colours);
        view=new BrowserWindow({width:580,height:460,minWidth:420,minHeight:420,show:true,title:text("shutdown.title"),backgroundColor:colours.colours.paper,
          webPreferences:{preload:path.join(__dirname,"shutdown-preload.cjs"),partition:"tagcast-shutdown",sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:false,devTools:false}});
        const current=view,contents=view.webContents;
        contents.setWindowOpenHandler(()=>({action:"deny"}));
        contents.on("will-navigate",event=>event.preventDefault());
        contents.on("will-attach-webview",event=>event.preventDefault());
        contents.session.setPermissionCheckHandler(()=>false);
        contents.session.setPermissionRequestHandler((_c,_p,done)=>done(false));
        contents.session.setDevicePermissionHandler(()=>false);
        view.on("close",event=>{event.preventDefault();if(canResume)reopen();});
        view.on("closed",()=>{if(view===current)view=null;});
        view.loadURL(url).catch(()=>{});
      }
      if(view.isMinimized())view.restore();view.show();view.focus();publish();
    },
    update(status,resumable){latest=status;canResume=resumable;publish();},
    destroy(){const current=view;view=null;current?.destroy();},
    get window(){return view;}
  };
}
module.exports={installShutdownWindow};
