"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {Backend, shutdownMessage} = require("../backend.cjs");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(options = {}) {
  const states = [];
  const script = `
    const readline=require('node:readline');
    const send=value=>console.log(JSON.stringify(value));
    const status=phase=>send({event:'shutdown',phase,writes:phase==='writes'?1:0,reads:0,checks:0,elapsed:0,uncertain:false});
    setTimeout(()=>send({event:'ready',protocol:1,version:'1.6.5',owned:true,url:'http://127.0.0.1:12345',shutdown_control:1}),${options.readyDelay||0});
    readline.createInterface({input:process.stdin}).on('line',line=>{
      if(line==='drain')status('writes');
      if(line==='complete')status('ready');
      if(line==='resume')send({event:'resumed'});
      if(line==='finish')process.exit(0);
    }).on('close',()=>process.exit(0));`;
  const backend = new Backend({file:process.execPath,args:["-e",script]}, {
    version:"1.6.5", onShutdown:state=>states.push(state), ...options});
  return {backend, states};
}
async function until(test) {
  const deadline = Date.now() + 3000;
  while (!test()) { if (Date.now() > deadline) throw Error("Fixture did not progress"); await wait(10); }
}

test("accepted work has no kill deadline and exit requires ready plus renderer acknowledgment", async () => {
  let approve;
  const {backend,states}=fixture({onShutdownReady:()=>new Promise(resolve=>{approve=resolve;})});
  try {
    await backend.start();
    const stopped=backend.stop();
    assert.equal(backend.stop(),stopped,"Repeated native close is idempotent");
    await until(()=>states.length);
    await wait(250);
    assert.equal(backend.child.exitCode,null);
    backend.child.stdin.write("complete\n");
    await until(()=>approve);
    await wait(30);
    assert.equal(backend.child.exitCode,null,"History acknowledgment is still pending");
    approve(true);
    assert.deepEqual(await stopped,{stopped:true,code:0,signal:null});
  } finally { if (backend.child.exitCode===null) backend.child.stdin.end(); await backend.exited; }
});

test("resume keeps the same child and rejects a stale renderer finish", async () => {
  const approvals=[];
  const {backend}=fixture({onShutdownReady:()=>new Promise(resolve=>approvals.push(resolve))});
  try {
    await backend.start();const pid=backend.child.pid;
    const first=backend.stop();backend.child.stdin.write("complete\n");
    await until(()=>approvals.length===1);
    assert.equal(backend.resume(),true);
    assert.deepEqual(await first,{stopped:false});
    const second=backend.stop();
    approvals[0](true);await wait(30);
    assert.equal(backend.child.stdin.writableEnded,false);
    assert.equal(backend.child.pid,pid);
    backend.child.stdin.write("complete\n");
    await until(()=>approvals.length===2);
    approvals[1](true);
    assert.equal((await second).code,0);
  } finally { if (backend.child.exitCode===null) backend.child.stdin.end(); await backend.exited; }
});

test("closing before readiness retains the control pipe and can reopen after startup", async () => {
  const {backend,states}=fixture({readyDelay:100});
  const started=backend.start(),stopped=backend.stop();
  try {
    assert.equal(backend.child.stdin.writableEnded,false);
    await started;
    await until(()=>states.length>0);
    assert.equal(states[0].phase,"writes");
    assert.equal(backend.resume(),true);
    assert.deepEqual(await stopped,{stopped:false});
    assert.equal(backend.child.stdin.writableEnded,false);
  } finally { backend.child.stdin.end();await backend.exited; }
});

test("an uncertain result can reopen and a broken feedback callback cannot strand shutdown", async () => {
  const {backend}=fixture({onShutdown:()=>{throw Error("UI lost");},onShutdownReady:()=>false});
  try {
    await backend.start();const stopped=backend.stop();backend.child.stdin.write("complete\n");
    assert.deepEqual(await stopped,{stopped:false});
    assert.equal(backend.child.exitCode,null);
  } finally { backend.child.stdin.end();await backend.exited; }
});

test("shutdown progress accepts only bounded counts and fixed account-free phases", () => {
  const valid={event:"shutdown",phase:"checking",writes:0,reads:0,checks:1,elapsed:10,uncertain:true};
  assert.equal(shutdownMessage(valid).checks,1);
  for(const change of [{phase:"https://secret"},{elapsed:-1},{writes:Infinity},{reads:"2"},{uncertain:1},{checks:1.5}])
    assert.equal(shutdownMessage({...valid,...change}),null);
  assert.equal(shutdownMessage({...valid,account:"private",token:"secret"}).account,undefined);
});
