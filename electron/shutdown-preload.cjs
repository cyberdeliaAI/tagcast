"use strict";
const {ipcRenderer}=require("electron");
window.addEventListener("DOMContentLoaded",()=>{
  const button=document.getElementById("reopen");
  button.addEventListener("click",()=>ipcRenderer.send("shutdown:resume"));
  ipcRenderer.on("shutdown:state",(_event,value)=>{
    for(const key of ["title","message","status","elapsed","detail","reopen"]){
      const node=document.getElementById(key);
      if(node&&typeof value?.[key]==="string")node.textContent=value[key];
    }
    button.disabled=value?.canResume!==true;
  });
  ipcRenderer.send("shutdown:ready");
});
