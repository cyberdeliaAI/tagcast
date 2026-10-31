"use strict";
const {test}=require("node:test"), assert=require("node:assert/strict"), vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");
function view(){
 const nodes=new Map(),sent=[];let onState,resolve;
 const document={activeElement:null,documentElement:{dataset:{},style:{properties:{},setProperty(k,v){this.properties[k]=v;},removeProperty(k){delete this.properties[k];}}},getElementById(id){if(!nodes.has(id)){const listeners={},attributes={},properties={};let text="",writes=0,disabled=false;
  const node={dataset:{},hidden:false,value:"0",style:{setProperty(k,v){properties[k]=v;},properties},get textContent(){return text;},set textContent(v){text=v;writes++;},get writes(){return writes;},get disabled(){return disabled;},set disabled(value){disabled=value;if(value&&document.activeElement===node)document.activeElement=null;},setAttribute(k,v){attributes[k]=v;},getAttribute(k){return attributes[k];},removeAttribute(k){delete attributes[k];},addEventListener(k,v){listeners[k]=v;},emit(k){return listeners[k]?.();}};nodes.set(id,node);}return nodes.get(id);}};
 const bridge={onState(fn){onState=fn;},ready(){},openMain(){sent.push({action:"open"});},pin(value){sent.push({action:"pin",value});},command(value){sent.push(value);return new Promise(done=>{resolve=done;});}};
 const context=vm.createContext({window:{tagcastMini:bridge},document,console});
 vm.runInContext(fs.readFileSync(path.join(__dirname,"../src/tagcast/static/mini-player/view.js"),"utf8"),context);
 const state={document:"d",entry:"e",segment:"s",title:"A track",artist:"An artist",album:"An album",position:75,duration:300,paused:true,controllable:true,seekable:true,previous:true,next:true,status:"Gapless · experimental",theme:"dark",palette:"ocean"};
 return {nodes,document,sent,run:code=>vm.runInContext(code,context),state:value=>onState({playback:{...state,...value},pinned:false,canPin:true}),done:value=>resolve(value)};
}
test("Mini Player elapsed time, total time and progress show the same track-relative position",()=>{
 const v=view();v.state();assert.equal(v.nodes.get("elapsed").textContent,"1:15");assert.equal(v.nodes.get("duration").textContent,"5:00");assert.equal(v.nodes.get("position").style.properties["--mini-progress"],"25%");assert.equal(v.nodes.get("position").getAttribute("aria-valuetext"),"1:15 of 5:00");
 v.state({position:3665,duration:7200});assert.equal(v.nodes.get("elapsed").textContent,"1:01:05");assert.equal(v.nodes.get("duration").textContent,"2:00:00");
});
test("Mini Player does not rebuild transport icons or repeatedly announce an unchanged status",()=>{
 const v=view();v.state();const count=v.nodes.get("status").writes;v.state({position:76,paused:false});assert.equal(v.nodes.get("status").writes,count);assert.equal(v.nodes.get("play").writes,0);assert.equal(v.nodes.get("play").dataset.paused,"false");assert.equal(v.nodes.get("play").getAttribute("aria-label"),"Pause");v.state({status:"Buffering…"});assert.equal(v.nodes.get("status").writes,count+1);
});
test("Mini Player keeps keyboard focus through a seek acknowledgement while serializing IPC commands",async()=>{
 const v=view();v.state();const slider=v.nodes.get("position");v.document.activeElement=slider;slider.emit("pointerdown");slider.value="80";slider.emit("input");slider.emit("change");assert.equal(v.sent.length,1);assert.equal(v.sent[0].position,80);assert.equal(slider.disabled,false);assert.equal(v.document.activeElement,slider);await v.run('send("play")');assert.equal(v.sent.length,1);v.done(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(v.document.activeElement,slider);assert.equal(slider.disabled,false);
});
test("Unavailable controls remain disabled and a changed track discards a pending seek preview",()=>{
 const v=view();v.state();const slider=v.nodes.get("position");slider.emit("pointerdown");slider.value="90";slider.emit("input");v.state({entry:"new",position:3});slider.emit("change");assert.equal(v.sent.length,0);assert.equal(Number(slider.value),3);v.state({controllable:false,seekable:false,previous:false,next:false});for(const id of ["play","position","previous","next"])assert.equal(v.nodes.get(id).disabled,true);
});
test("Mini Player applies validated custom colours and clears them when returning to a built-in palette",()=>{
 const v=view();v.state({colours:{paper:"#123456",ink:"#abcdef",unknown:"#ffffff",link:"url(secret)"}});
 assert.deepEqual(v.document.documentElement.style.properties,{"--palette-paper":"#123456","--palette-ink":"#abcdef"});
 v.state({colours:{paper:"#654321"}});assert.deepEqual(v.document.documentElement.style.properties,{"--palette-paper":"#654321"});
 v.state();assert.deepEqual(v.document.documentElement.style.properties,{});
});
