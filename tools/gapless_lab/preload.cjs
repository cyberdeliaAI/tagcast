"use strict";
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('lab',{config:ipcRenderer.sendSync('lab-config'),pcm:buffer=>ipcRenderer.send('lab-pcm',buffer),done:result=>ipcRenderer.send('lab-done',result)});
