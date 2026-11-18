"use strict";

// Exercise the actual updater's HTTP transfer/cache/hash path with disposable bytes.
// Only the injected provider URL is loopback; production always pins GitHub URLs.
const {test} = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const {createHash} = require("node:crypto"), {once} = require("node:events");
const {ElectronHttpExecutor} = require("electron-updater/out/electronHttpExecutor");
const {DesktopUpdates} = require("../updates.cjs");
const {createNativeUpdater,secureUpdateSession} = require("../native-updater.cjs");

for (const corrupt of [false,true]) test(`real updater ${corrupt ? "rejects a corrupted package" : "downloads verified bytes"} without installing`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"tagcast updater transfer "));
  const payload=Buffer.from("Non-executable, synthetic Tagcast update fixture.");
  const filename="tagcast-1.9.0-windows-x64-setup.exe";
  const digest=createHash("sha512").update(payload).digest("base64"), requests=[],headers=[];
  const server=http.createServer((request,response)=>{
    const route=new URL(request.url,"http://127.0.0.1").pathname;requests.push(route);headers.push(request.headers);
    if(route.endsWith(".yml"))response.end(JSON.stringify({version:"1.9.0",files:[{url:filename,sha512:digest,size:payload.length}]}));
    else if(route==="/"+filename){const bytes=corrupt?Buffer.from("Corrupted update bytes."):payload;response.setHeader("Content-Length",bytes.length);response.end(bytes);}
    else {response.statusCode=404;response.end();}
  });
  try {
    server.listen(0,"127.0.0.1");await once(server,"listening");
    const configuration=path.join(root,"app-update.yml");fs.writeFileSync(configuration,'{"updaterCacheDirName":"isolated-tagcast-test"}');
    let quit=0;
    const app={version:"1.8.0",name:"Tagcast",isPackaged:true,appUpdateConfigPath:configuration,userDataPath:root,baseCachePath:root,
      whenReady:()=>Promise.resolve(),onQuit:()=>{throw Error("automatic installation must stay disabled");},quit:()=>quit++,relaunch:()=>quit++};
    const native=createNativeUpdater("win32",app),errors=[];native.on("error",error=>errors.push(error.stack||String(error)));native.logger=null;
    native.httpExecutor=new ElectronHttpExecutor();native.httpExecutor.createRequest=(options,callback)=>http.request(options,callback);
    native.disableDifferentialDownload=true;native.disableWebInstaller=true;
    const setFeedURL=native.setFeedURL.bind(native);
    native.setFeedURL=options=>{assert.equal(options.url,"https://github.com/cyberdeliaAI/tagcast/releases/download/v1.9.0/");setFeedURL({...options,url:`http://127.0.0.1:${server.address().port}/`});};
    const updates=new DesktopUpdates({current:"1.8.0",platform:"win32",arch:"x64",supported:true,file:path.join(root,"preferences.json"),createUpdater:()=>native});
    updates.offer("1.9.0");await updates.download("1.9.0");
    assert.equal(updates.snapshot().state,corrupt?"error":"ready",errors.join("\n"));assert.equal(quit,0);
    assert.ok(requests.some(route=>route.endsWith(".yml")));assert.equal(requests.filter(route=>route==="/"+filename).length,1);
    assert.ok(headers.every(value=>!value["x-user-staging-id"]&&!value.authorization&&!value.cookie));
    assert.equal(fs.existsSync(path.join(root,".updaterId")),false);
    if(!corrupt)assert.deepEqual(fs.readFileSync(native.installerPath),payload);
  } finally {
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});
  }
});

test("the updater's separate network session rejects HTTP and removes credentials and tracking headers",()=>{
  let request,headers;
  secureUpdateSession({webRequest:{onBeforeRequest:fn=>request=fn,onBeforeSendHeaders:fn=>headers=fn}});
  for(const [url,cancel] of [["https://github.com/release",false],["http://github.com/release",true],["file:///tmp/package",true],["invalid",true]])
    request({url},result=>assert.equal(result.cancel,cancel));
  headers({requestHeaders:{Cookie:"not-sent",Authorization:"not-sent","Proxy-Authorization":"not-sent","x-user-staging-id":"not-sent",Accept:"kept"}},
    result=>assert.deepEqual(result.requestHeaders,{Accept:"kept"}));
});
