"use strict";
const {test} = require("node:test"), assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const http = require("node:http");
const {installSignIn, signInUrl, signInResource, signInRequestId, signInApi, SIGN_IN_PARTITION} = require("../sign-in.cjs");
const origin = "http://127.0.0.1:8912", id = "a".repeat(24), nextId = "b".repeat(24);
const device = request_id => ({state: "pending", request_id, user_code: "TEST-CODE", expires_at: Date.now()/1000+600,
  verification_uri: "https://oauth.ibroadcast.com/device", verification_uri_complete: "https://oauth.ibroadcast.com/device?user_code=TEST-CODE"});
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(requestHandler) {
  class Contents extends EventEmitter {
    constructor(url) { super(); this.url=url; this.mainFrame={url}; this.sent=[]; }
    getURL() { return this.url; } isDestroyed() { return false; }
    send(...message) { this.sent.push(message); }
    setWindowOpenHandler(callback) { this.windowOpen=callback; }
  }
  class Window extends EventEmitter {
    constructor(options) { super(); this.options=options; this.webContents=new Contents(""); this.destroyed=false; this.shown=0; this.focused=0; views.push(this); }
    isDestroyed() { return this.destroyed; } isMinimized() { return false; }
    show() { this.shown++; } focus() { this.focused++; } restore() {} setMenu() {}
    loadURL(url) { this.webContents.url=url; return Promise.resolve(); }
    destroy() { this.destroyed=true; this.emit("closed"); }
  }
  const views=[], handlers=new Map(), requests=[];
  const owner=new EventEmitter();
  Object.assign(owner,{webContents:new Contents(origin),isDestroyed:()=>false,isMinimized:()=>false,
    getBounds:()=>({x:0,y:0,width:1280,height:800}),show(){},focus(){this.focused=true;}});
  const ipcMain=new EventEmitter(); ipcMain.handle=(name,fn)=>handlers.set(name,fn); ipcMain.removeHandler=name=>handlers.delete(name);
  const ses=new EventEmitter();
  Object.assign(ses,{setPermissionCheckHandler(fn){this.permissionCheck=fn;},setPermissionRequestHandler(fn){this.permissionRequest=fn;},
    setDevicePermissionHandler(fn){this.devicePermission=fn;},webRequest:{onBeforeRequest(fn){ses.beforeRequest=fn;}}});
  const deps={BrowserWindow:Window,ipcMain,session:{fromPartition(value){assert.equal(value,SIGN_IN_PARTITION);return ses;}},
    screen:{getDisplayMatching:()=>({workArea:{width:1280,height:800}})}};
  const request=async (base,path,body)=>{assert.equal(base,origin);requests.push({path,body});
    return requestHandler ? requestHandler(path,body) : path==='/api/status'?{device:device(id)}:{ok:true};};
  const controller=installSignIn(owner,origin,deps,request);
  const event={sender:owner.webContents,senderFrame:owner.webContents.mainFrame};
  return {controller,owner,views,handlers,ipcMain,ses,event,requests,
    open:(value=id,from=event)=>handlers.get('signin:open')(from,value)};
}

test("sign-in accepts only official credential-free HTTPS URLs and bounded opaque IDs",()=>{
  assert.equal(signInUrl('https://oauth.ibroadcast.com/device?user_code=TEST-CODE'),'https://oauth.ibroadcast.com/device?user_code=TEST-CODE');
  for(const value of ['http://oauth.ibroadcast.com/device','https://oauth.ibroadcast.com.evil.test/device','https://user:pass@oauth.ibroadcast.com/device',
    'https://oauth.ibroadcast.com:444/device','file:///x','javascript:alert(1)',origin,'x'.repeat(8193),null,{}]) assert.equal(signInUrl(value),null,String(value));
  assert.equal(signInRequestId(id),true);
  for(const value of [null,12,{},'https://oauth.ibroadcast.com/device','short','x'.repeat(97)])assert.equal(signInRequestId(value),false);
  assert.equal(signInResource('https://oauth.ibroadcast.com/image.png'),true);
  for(const value of [origin,'http://example.com','file:///x','https://127.0.0.1/','https://localhost/','https://localhost./','https://192.168.1.1/','https://[::1]/','https://user:pass@example.com/']) assert.equal(signInResource(value),false,value);
});

test("only the main app frame can request sign-in; no renderer-provided URL is used",async()=>{
  const f=fixture();
  for(const from of [{sender:{},senderFrame:f.owner.webContents.mainFrame},{...f.event,senderFrame:{}},{}])assert.equal(await f.open(id,from),false);
  f.owner.webContents.url='https://oauth.ibroadcast.com/device';assert.equal(await f.open(),false);
  f.owner.webContents.url=origin;
  assert.equal(await f.open('https://oauth.ibroadcast.com/device'),false);
  assert.equal(f.requests.length,0);assert.equal(f.views.length,0);
});

test("official page has a separate sandboxed session, no preload or permissions, and one reusable window",async()=>{
  const f=fixture();assert.equal(await f.open(),true);
  const v=f.views[0], prefs=v.options.webPreferences;
  assert.equal(v.webContents.getURL(),device(id).verification_uri_complete);
  assert.equal(prefs.partition,SIGN_IN_PARTITION);assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);
  assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.webSecurity,true);assert.equal(prefs.webviewTag,false);
  assert.equal(prefs.preload,undefined);assert.equal(prefs.devTools,false);assert.equal(prefs.allowRunningInsecureContent,false);
  assert.equal(f.ses.permissionCheck(),false);assert.equal(f.ses.devicePermission(),false);
  f.ses.permissionRequest(null,'camera',allowed=>assert.equal(allowed,false));
  f.ses.beforeRequest({url:origin+'/api/status'},result=>assert.equal(result.cancel,true));
  f.ses.beforeRequest({url:'https://oauth.ibroadcast.com/logo.png'},result=>assert.equal(result.cancel,false));
  assert.equal(await f.open(),true);assert.equal(f.views.length,1);assert.equal(f.requests.length,1);
  let stopped=false;f.ses.emit('will-download',{preventDefault:()=>stopped=true});assert.equal(stopped,true);
});

test("off-provider navigation and popup requests offer browser fallback without opening an untrusted page",async()=>{
  for(const event of ['will-navigate','will-redirect','popup']) {
    const f=fixture();await f.open();const web=f.views[0].webContents;let denied=false;
    if(event==='popup')assert.deepEqual(web.windowOpen({url:'https://example.com'}),{action:'deny'});
    else web.emit(event,{preventDefault:()=>denied=true},origin);
    if(event!=='popup')assert.equal(denied,true);
    assert.equal(f.controller.window,null);assert.equal(f.requests.length,1);
    assert.deepEqual(f.owner.webContents.sent,[['signin:closed',{requestId:id,reason:'browser-needed'}]]);
  }
});

test("an explicitly pending reauthorization can open while the existing account remains connected",async()=>{
  const f=fixture(()=>({connected:true,device:device(id)}));
  assert.equal(await f.open(),true);assert.equal(f.views.length,1);
});

test("connected, stale, expired, invalid and unavailable device responses never open a remote page",async()=>{
  for(const status of [{connected:true,device:null},{device:{...device(id),state:'done'}},{device:device(nextId)},
    {device:{...device(id),expires_at:1}},{device:{...device(id),expires_at:'later'}},
    {device:{...device(id),verification_uri:'https://evil.test',verification_uri_complete:'https://evil.test'}},{}]) {
    const f=fixture(()=>status);assert.equal(await f.open(),false);assert.equal(f.views.length,0);
  }
  const f=fixture(()=>{throw Error('private URL must not escape');});assert.equal(await f.open(),false);
});

test("native Close cancels only its own attempt and returns focus without a polling timer",async()=>{
  const f=fixture();await f.open();f.views[0].destroy();await tick();
  assert.equal(f.controller.window,null);
  assert.deepEqual(f.requests[1],{path:'/api/auth/cancel',body:{request_id:id}});
  assert.deepEqual(f.owner.webContents.sent,[['signin:closed',{requestId:id,reason:'closed'}]]);
  assert.equal(f.owner.focused,true);
});

test("completion closes the window without cancelling an approved login; stale close messages cannot close a new window",async()=>{
  let status={device:device(id)};const f=fixture(path=>path==='/api/status'?status:{ok:true});
  await f.open();f.ipcMain.emit('signin:close',{...f.event,senderFrame:{}},id);assert.ok(f.controller.window);
  f.ipcMain.emit('signin:close',f.event,id);assert.equal(f.controller.window,null);assert.equal(f.requests.length,1);
  status={device:device(nextId)};await f.open(nextId);
  f.ipcMain.emit('signin:close',f.event,id);assert.equal(f.controller.window,f.views[1]);
  assert.equal(f.requests.filter(r=>r.path==='/api/auth/cancel').length,0);
});

test("reload during validation invalidates the old reply; closed owners remove their handlers",async()=>{
  let release;const wait=new Promise(resolve=>release=resolve);
  const f=fixture(path=>path==='/api/status'?wait:{ok:true});const opened=f.open();
  f.owner.webContents.emit('did-start-navigation',{},origin,false,true);
  release({device:device(id)});assert.equal(await opened,false);assert.equal(f.views.length,0);
  assert.deepEqual(f.requests[1].body,{request_id:id});
  f.owner.emit('closed');assert.equal(f.handlers.has('signin:open'),false);assert.equal(f.ipcMain.listenerCount('signin:close'),0);
});

test("main-frame load failure offers fallback without cancelling the code; subresource failures and aborted redirects do not",async()=>{
  const f=fixture();await f.open();const web=f.views[0].webContents;
  web.emit('did-fail-load',{},-105,'private error','https://private',false);assert.ok(f.controller.window);
  web.emit('did-fail-load',{},-3,'aborted','https://private',true);assert.ok(f.controller.window);
  web.emit('did-fail-load',{},-105,'private error','https://private',true);
  assert.equal(f.controller.window,null);assert.equal(f.requests.length,1);
  assert.deepEqual(f.owner.webContents.sent,[['signin:closed',{requestId:id,reason:'load-failed'}]]);
});

test("local sign-in API uses fixed endpoints and rejects malformed or oversized responses",async t=>{
  const seen=[];let body='{"device":null}';
  const server=http.createServer((req,res)=>{let data='';req.on('data',c=>data+=c);req.on('end',()=>{seen.push({path:req.url,method:req.method,header:req.headers['x-tagcast'],body:data});res.end(body);});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  assert.deepEqual(await signInApi(base,'/api/status'),{device:null});
  await signInApi(base,'/api/auth/cancel',{request_id:id});assert.equal(seen[1].header,'1');assert.equal(seen[1].method,'POST');
  assert.deepEqual(JSON.parse(seen[1].body),{request_id:id});
  await assert.rejects(signInApi(base,'/api/save',{}),/Invalid sign-in operation/);assert.equal(seen.length,2);
  body='not JSON';await assert.rejects(signInApi(base,'/api/status'),/Invalid sign-in status/);
  body='x'.repeat(70000);await assert.rejects(signInApi(base,'/api/status'),/Sign-in status unavailable/);
});
