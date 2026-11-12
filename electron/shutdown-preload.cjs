"use strict";
const {ipcRenderer}=require("electron");
window.addEventListener("DOMContentLoaded",()=>{
  const button=document.getElementById("reopen");
  button.addEventListener("click",()=>ipcRenderer.send("shutdown:resume"));
  ipcRenderer.on("shutdown:state",(_event,value)=>{
    const appearance=value?.appearance,root=document.documentElement;
    if(["light","dark"].includes(appearance?.theme))root.style.colorScheme=appearance.theme;
    for(const role of ["paper","ink","muted","surface","line","focus","tint"]){
      const colour=appearance?.colours?.[role];
      if(typeof colour==="string"&&/^#[0-9a-f]{6}$/i.test(colour))root.style.setProperty("--"+role,colour);
    }
    for(const key of ["title","message","status","elapsed","detail","reopen"]){
      const node=document.getElementById(key);
      if(node&&typeof value?.[key]==="string")node.textContent=value[key];
    }
    button.disabled=value?.canResume!==true;
  });
  ipcRenderer.send("shutdown:ready");
});
