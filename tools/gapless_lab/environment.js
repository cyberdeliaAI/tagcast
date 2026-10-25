"use strict";
// Minimal host adapters: the actual unmodified engine owns preparation, MSE and the timeline.
const audio=document.querySelector('audio');
const state={connection:{premium:true,playback_session:'isolated-media-lab'},loading:false};
const player={queue:[],index:0,quality:'orig',repeat:'none',shuffle:false};
const lookup={streamQuality:'orig'},queueSync={active:false},visualPlayer={open:false},playReporting={watch:null};
const trace=[],fallbacks=[],inputChannels=[];
const live=()=>true,escapeHtml=s=>String(s),renderStreamQuality=()=>{},beginPlaybackWatch=()=>{},samplePlayback=()=>{},toast=s=>trace.push({name:'toast',message:s});
const renderCurrentPlayerTrack=()=>trace.push({name:'track',index:player.index,at:performance.now(),time:audio.currentTime});
function playCurrent(auto){fallbacks.push({at:performance.now(),index:player.index,reason:gaplessTrial.message,offset:gaplessTrial.offset});audio.pause();}
