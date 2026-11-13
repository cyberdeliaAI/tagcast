"use strict";
const {test} = require("node:test"), assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const {readFileSync} = require("node:fs"), vm = require("node:vm");
const {DesktopUpdates, checkedInfo, packageName, installation, installUpdateBridge, newer} = require("../updates.cjs");
const {applicationUrl} = require("../security.cjs");
const hash = Buffer.alloc(64, 12).toString("base64");
const info = (platform = "darwin", arch = "arm64") => ({version:"1.9.0", files:[{url:packageName("1.9.0",platform,arch),sha512:hash,size:100}]});
function fixture(options = {}) {
  const native = new EventEmitter(), changes = [], calls = [];
  native.setFeedURL = value => calls.push(["feed",value]);
  native.checkForUpdates = async () => { calls.push(["check"]); return {updateInfo:info()}; };
  native.downloadUpdate = async () => { calls.push(["download"]); native.emit("download-progress",{percent:47.9}); };
  native.quitAndInstall = (...args) => calls.push(["install",...args]);
  const files = {readFileSync:()=>{throw Error();},writeFileSync:()=>{},renameSync:()=>{}};
  const updater = new DesktopUpdates({current:"1.8.0",platform:"darwin",arch:"arm64",supported:true,file:"preferences.json",
    files,createUpdater:()=>native,onChange:value=>changes.push(value),onConfirm:async()=>true,...options});
  return {updater,native,changes,calls,files};
}
test("stable versions never downgrade, accept a prerelease, or become arbitrary URLs",()=>{
  assert.equal(newer("1.10.0","1.9.0"),true);
  for(const version of ["1.8.0","1.7.9","1.9.0-beta.1","1.9.0/../evil","01.9.0","9999999.0.0",["1.9.0"],{},null,42])assert.equal(newer(version,"1.8.0"),false);
});
test("all supported package identities require exact version, architecture, size and SHA-512",()=>{
  for(const [platform,arch] of [["darwin","arm64"],["darwin","x64"],["win32","x64"],["linux","x64"]]) {
    const good=info(platform,arch);assert.equal(checkedInfo(good,"1.9.0",platform,arch),good.files[0].url);
    for(const change of [{url:"https://evil.example/update.zip"},{url:"../update.zip"},{url:"tagcast-1.9.0-windows-x64.zip"},{size:-1},{size:2**40},{sha512:"invalid"}]) {
      assert.throws(()=>checkedInfo({...good,files:[{...good.files[0],...change}]},"1.9.0",platform,arch));
    }
    assert.throws(()=>checkedInfo({...good,packages:{x64:{path:"https://evil.example/payload"}}},"1.9.0",platform,arch));
    assert.throws(()=>checkedInfo({...good,version:"1.9.1"},"1.9.0",platform,arch));
  }
});
test("offering an update makes no request and installation on ordinary quit stays disabled",async()=>{
  const f=fixture();f.updater.offer("1.9.0",true);assert.equal(f.calls.length,0);
  await f.updater.download("1.9.0");
  assert.equal(f.native.autoDownload,false);assert.equal(f.native.autoInstallOnAppQuit,false);
  assert.equal(f.native.allowDowngrade,false);assert.equal(f.native.allowPrerelease,false);
  assert.equal(f.updater.snapshot().state,"ready");
  assert.equal(f.updater.finish(),false);assert.ok(f.calls.every(c=>c[0]!=="install"));
  assert.equal(f.calls[0][1].url,"https://github.com/cyberdeliaAI/tagcast/releases/download/v1.9.0/");
  assert.ok(f.changes.some(c=>c.state==="downloading"&&c.progress===47));
});
test("invalid metadata and failed downloads never install or retry themselves",async()=>{
  const f=fixture();f.updater.offer("1.9.0");
  f.native.checkForUpdates=async()=>({updateInfo:{...info(),files:[{...info().files[0],url:"https://evil.example/file"}]}});
  await f.updater.download("1.9.0");assert.equal(f.updater.snapshot().state,"error");
  assert.ok(f.calls.every(c=>c[0]!=="download"));
  await f.updater.install("1.9.0");assert.ok(f.calls.every(c=>c[0]!=="install"));
  f.native.checkForUpdates=async()=>({updateInfo:info()});let downloads=0;
  f.native.downloadUpdate=async()=>{downloads++;throw Error("private URL or exception");};
  await f.updater.download("1.9.0");await new Promise(r=>setImmediate(r));assert.equal(downloads,1);
  assert.equal(f.updater.snapshot().error,"download");assert.doesNotMatch(JSON.stringify(f.updater.snapshot()),/private/);
});
test("parallel clicks coalesce; changing the offered version cannot replace an in-flight package",async()=>{
  const f=fixture();let complete;f.updater.offer("1.9.0");
  f.native.downloadUpdate=()=>new Promise(r=>{complete=r;});
  const a=f.updater.download("1.9.0"),b=f.updater.download("1.9.0");assert.equal(a,b);
  await new Promise(r=>setImmediate(r));f.updater.offer("2.0.0");assert.equal(f.updater.snapshot().version,"1.9.0");
  complete();await a;assert.equal(f.calls.filter(c=>c[0]==="check").length,1);
  assert.equal(f.updater.snapshot().version,"2.0.0");assert.equal(f.updater.snapshot().state,"available");
  assert.equal(f.updater.finish(),false,"the older downloaded package cannot be installed as the newer offered version");
});
test("automatic downloading is opt-in, respects skipped releases, and never installs",async()=>{
  const f=fixture();f.updater.configure(true);f.updater.offer("1.9.0",true);await f.updater.busy;
  assert.equal(f.updater.snapshot().state,"ready");assert.ok(f.calls.every(c=>c[0]!=="install"));
  f.updater.skip("1.9.0");f.updater.offer("1.9.1",true);await f.updater.busy;
  const saved={autoDownload:true,skipped:"1.9.0"};
  const g=fixture({files:{readFileSync:()=>JSON.stringify(saved)}});g.updater.offer("1.9.0",true);assert.equal(g.calls.length,0);
});
test("preference persistence failure retains the old consent",()=>{
  const f=fixture();f.files.renameSync=()=>{throw Error("disk");};f.updater.configure(true);
  assert.equal(f.updater.snapshot().autoDownload,false);assert.equal(f.updater.snapshot().error,"preferences");
});
test("only the shutdown owner may complete installation, and cancellation leaves the update ready",async()=>{
  let requested=0;const f=fixture({onInstall:()=>{requested++;}});f.updater.offer("1.9.0");await f.updater.download("1.9.0");
  await f.updater.install("1.9.0");assert.equal(requested,1);assert.equal(f.updater.snapshot().state,"finishing");
  assert.ok(f.calls.every(c=>c[0]!=="install"));f.updater.defer("uncertain");assert.equal(f.updater.finish(),false);
  assert.equal(f.updater.snapshot().state,"ready");assert.equal(f.updater.snapshot().error,"uncertain");
  await f.updater.install("1.9.0");assert.equal(f.updater.finish(),true);assert.deepEqual(f.calls.at(-1),["install",false,true]);
});
test("installer failure releases the application instead of leaving a hidden process with the instance lock",async()=>{
  let failed=0;const f=fixture({onInstallError:()=>failed++});f.updater.offer("1.9.0");await f.updater.download("1.9.0");await f.updater.install("1.9.0");
  f.native.quitAndInstall=()=>f.native.emit("error",Error("installer refused"));
  assert.equal(f.updater.finish(),false);assert.equal(failed,1);
});

test("ordinary quit or canceled shutdown cannot install while native confirmation is still pending",async()=>{
  let confirm,requests=0;const f=fixture({onConfirm:()=>new Promise(resolve=>{confirm=resolve;}),onInstall:()=>requests++});
  f.updater.offer("1.9.0");await f.updater.download("1.9.0");
  const attempt=f.updater.install("1.9.0");assert.equal(f.updater.finish(),false);assert.equal(requests,0);
  f.updater.defer("uncertain");confirm(true);await attempt;
  assert.equal(requests,0);assert.equal(f.updater.snapshot().state,"ready");assert.equal(f.updater.finish(),false);
});
test("portable, unsigned test, Homebrew and reused-server installs cannot silently become native updates",()=>{
  const files={readFileSync:()=>'{"protocol":1,"developerId":false}',existsSync:()=>false,realpathSync:x=>x};
  const base={packaged:true,platform:"darwin",arch:"arm64",execPath:"/Applications/Tagcast.app/Contents/MacOS/Tagcast",resourcesPath:"/resources",files};
  assert.equal(installation(base).reason,"test");files.readFileSync=()=>'{"protocol":1,"developerId":true}';
  assert.equal(installation(base).supported,true);files.existsSync=x=>x==="/opt/homebrew/Caskroom/tagcast";
  assert.equal(installation(base).reason,"homebrew");
  assert.equal(installation({...base,platform:"win32",arch:"x64",execPath:"portable/Tagcast.exe"}).supported,false);
  assert.equal(installation({...base,platform:"linux",arch:"x64",execPath:"/tmp/Tagcast"}).supported,false);
});
test("an installed Windows copy requires a bounded trusted publisher list before native updates are enabled",()=>{
  let publisherName=[];
  const files={existsSync:()=>true,readFileSync:name=>JSON.stringify(name.endsWith("update-capabilities.json")?{protocol:1}:{publisherName})};
  const base={packaged:true,platform:"win32",arch:"x64",execPath:"Tagcast.exe",resourcesPath:"resources",files};
  for(const publishers of [[],"Trusted",[""],["bad\nname"],Array(5).fill("Trusted")]) {
    publisherName=publishers;assert.deepEqual(installation(base),{supported:false,reason:"signing"});
  }
  publisherName=["Trusted Publisher"];assert.deepEqual(installation(base),{supported:true,reason:""});
});
test("updater IPC refuses other windows, subframes and non-application navigation",async()=>{
  const handlers={},calls=[],contents={isDestroyed:()=>false,mainFrame:{},getURL:()=>"http://127.0.0.1:8912/"};
  const updates={snapshot:()=>({supported:true}),download:x=>calls.push(x)};
  installUpdateBridge({ipcMain:{handle:(name,fn)=>handlers[name]=fn},window:()=>({webContents:contents}),origin:()=>"http://127.0.0.1:8912",applicationUrl,updates});
  const valid={sender:contents,senderFrame:contents.mainFrame};
  for(const event of [{...valid,sender:{}},{...valid,senderFrame:{}}])assert.equal(await handlers["updates:download"](event,"1.9.0"),null);
  contents.getURL=()=>"https://example.com";assert.equal(await handlers["updates:download"](valid,"1.9.0"),null);
  assert.equal(calls.length,0);contents.getURL=()=>"http://127.0.0.1:8912/";
  await handlers["updates:download"](valid,"1.9.0");assert.deepEqual(calls,["1.9.0"]);
});
test("uncertain writes resume the same backend and never approve update shutdown",async()=>{
  const main=readFileSync(require.resolve("../main.cjs"),"utf8"),start=main.indexOf("async function finishRenderer("),end=main.indexOf("\nfunction beginShutdown",start);
  const errors=[];const context={window:null,bounded:async x=>x,desktopUpdates:{installing:true,defer:x=>errors.push(x)},dialog:{showMessageBoxSync:()=>{throw Error("must not offer unsafe close-and-install");}}};
  vm.runInNewContext(main.slice(start,end),context);
  assert.equal(await context.finishRenderer({uncertain:true}),false);assert.deepEqual(errors,["uncertain"]);
});

test("actual shutdown waits for the owned backend before handing off installation",async()=>{
  const main=readFileSync(require.resolve("../main.cjs"),"utf8"),start=main.indexOf("function beginShutdown("),end=main.indexOf("\nfunction requestShutdown",start);
  let drain,finished=false,installed=0,destroyed=0;
  const context={window:{isDestroyed:()=>false,hide:()=>{},destroy:()=>destroyed++,webContents:{executeJavaScript:()=>Promise.resolve()}},
    stopping:null,rendererFailed:false,signIn:null,miniPlayer:{beginShutdown:()=>{}},canReopen:()=>true,
    shutdownView:{show:()=>{},destroy:()=>destroyed++},backend:{stop:()=>new Promise(resolve=>{drain=resolve;})},
    desktopUpdates:{installing:true,finish:()=>{assert.equal(finished,true);installed++;return true;}},
    dialog:{showErrorBox:()=>{throw Error("unexpected shutdown error");}},app:{quit:()=>{}},t:x=>x};
  vm.runInNewContext(main.slice(start,end),context);context.beginShutdown();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(installed,0);assert.equal(destroyed,0);
  finished=true;drain({stopped:true,code:0});await context.stopping;
  assert.equal(installed,1);assert.equal(destroyed,0,"the finishing window stays visible until native installation quits the app");
});
