"use strict";
const {test} = require("node:test"), assert = require("node:assert/strict");
const {command, snapshot, bounds} = require("../mini-contract.cjs");
test("Mini Player bridge rejects arbitrary commands, invalid seeks and private artwork URLs", () => {
  const token={document:"d",entry:"e",segment:"s"};
  for(const value of [null,{}, {action:"evaluate",...token},{action:"seek",...token,position:NaN},{action:"seek",...token,position:-1}]) assert.equal(command(value),null);
  assert.deepEqual(command({action:"seek",...token,position:12,token:"secret"}),{action:"seek",...token,position:12});
  const state={...token,sequence:1,duration:100,position:120,title:"Title",cover:"https://user:password@example.com/art"};
  assert.equal(snapshot(state).cover,""); assert.equal(snapshot(state).position,100);
  assert.equal(snapshot({...state,cover:"http://127.0.0.1/api/stream/1"}).cover,"");
  assert.equal(snapshot({...state,secret:"no",cover:"https://artwork.ibroadcast.com/a"}).secret,undefined);
  assert.equal(snapshot({...state,sequence:Infinity}),null);
});
test("Mini Player bounds recover corrupt preferences and stay on a visible display", () => {
 const area={x:-1440,y:0,width:1440,height:900};
 for(const saved of [null,{}, {x:9000,y:-9000,width:99999,height:99999},{x:NaN,width:"huge",height:-1}]) {
  const b=bounds(saved,area);assert.ok(b.x>=area.x);assert.ok(b.y>=area.y);assert.ok(b.x+b.width<=0);assert.ok(b.y+b.height<=900);assert.ok(b.width>=420);assert.ok(b.height>=210);
 }
});

test("Mini Player uses compact logical window bounds and preserves a larger saved window", () => {
 const area={x:0,y:0,width:1440,height:900};
 const initial=bounds(null,area);assert.equal(initial.width,500);assert.equal(initial.height,210);
 const old=bounds({x:10,y:20,width:420,height:250},area);assert.equal(old.width,420);assert.equal(old.height,250);
 const short=bounds({width:420,height:180},area);assert.equal(short.height,210);
 const resized=bounds({x:10,y:20,width:680,height:340},area);assert.equal(resized.width,680);assert.equal(resized.height,340);
});
