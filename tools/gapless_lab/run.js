"use strict";
(async()=>{
 const config={...window.lab.config},started=performance.now(),startedEpoch=Date.now(),events=[],operations=[];
 let context,node,flush;
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const sbAdd=MediaSource.prototype.addSourceBuffer;
 const eos=MediaSource.prototype.endOfStream;MediaSource.prototype.endOfStream=function(...args){trace.push({name:'endOfStream',at:performance.now()-started,time:audio.currentTime,duration:this.duration});return eos.apply(this,args);};
 for(const name of ['parseFlac','pack']){const original=gaplessMedia[name];gaplessMedia[name]=function(...args){const t=performance.now();const result=original(...args);trace.push({name,at:t-started,elapsedMs:performance.now()-t,bytes:args[0]?.byteLength||0});return result;};}
 MediaSource.prototype.addSourceBuffer=function(...args){const sb=sbAdd.apply(this,args);const media=this;for(const name of ['sourceopen','sourceended','sourceclose'])media.addEventListener(name,()=>trace.push({name,at:performance.now()-started,time:audio.currentTime,state:media.readyState}));for(const method of ['appendBuffer','remove']){const original=sb[method].bind(sb);sb[method]=(...params)=>{try{const stateBefore=media.readyState,result=original(...params);operations.push({method,stateBefore,stateAfter:media.readyState,at:performance.now()-started,bytes:params[0]?.byteLength||0,time:audio.currentTime,ranges:Array.from({length:sb.buffered.length},(_,i)=>[sb.buffered.start(i),sb.buffered.end(i)]),offset:sb.timestampOffset});return result;}catch(e){operations.push({method,error:e.name,message:e.message,at:performance.now()-started});throw e;}};}return sb;};
 for(const name of ['playing','waiting','stalled','seeking','seeked','ended','error'])audio.addEventListener(name,()=>events.push({name,at:performance.now()-started,time:audio.currentTime,index:player.index,error:audio.error?.message||''}));
 audio.addEventListener('timeupdate',()=>gaplessAdvance());audio.addEventListener('error',()=>gaplessAudioError());
 const finish=async(error='')=>{
   audio.pause();await wait(250);
   if(node)await new Promise(resolve=>{flush=resolve;node.port.postMessage('flush');});
   const result={id:config.id,startedEpoch,mode:config.referenceMode?'reference':'engine',error,rate:config.rate,contextRate:context?.sampleRate,events,operations,trace,fallbacks,inputChannels,time:audio.currentTime,duration:audio.duration,finalIndex:player.index,message:gaplessTrial.message,engineActive:Boolean(gaplessTrial.active),elapsedMs:performance.now()-started,engineState:gaplessTrial.active?{finished:gaplessTrial.active.finished,pending:gaplessTrial.active.pending,wanted:Boolean(gaplessTrial.active.wanted),readyState:gaplessTrial.active.media?.readyState,currentPart:gaplessTrial.active.current?.part,totalParts:gaplessTrial.active.current?.media.parts.length,ranges:gaplessTrial.active.buffer?Array.from({length:gaplessTrial.active.buffer.buffered.length},(_,i)=>[gaplessTrial.active.buffer.buffered.start(i),gaplessTrial.active.buffer.buffered.end(i)]):[]}:null,seekProbe:config.probeResult};
   gaplessCancel();audio.removeAttribute('src');audio.load();if(context)await context.close();window.lab.done(result);
 };
 try {
   context=new AudioContext({sampleRate:config.rate});await context.audioWorklet.addModule('/capture.js');
   node=new AudioWorkletNode(context,'counter-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2],channelCountMode:'max',channelInterpretation:'discrete'});
   node.port.onmessage=e=>{if(e.data.pcm)window.lab.pcm(e.data.pcm);if(e.data.channels!==undefined)inputChannels.push({channels:e.data.channels,frame:e.data.frame});if(e.data.flush)flush?.();};
   context.createMediaElementSource(audio).connect(node).connect(context.destination);audio.volume=1;audio.playbackRate=1;await context.resume();
   if(config.referenceMode){audio.src='/reference';await audio.play();}
   else {
    gaplessTrial.enabled=true;player.queue=config.tracks.map((s,i)=>({id:String(i),title:s.id,album:{id:'fixture'}}));gaplessAlbumQueue(player.queue,true);
    if(!gaplessBegin(player.queue[0],true))throw Error('MSE FLAC unsupported');
    if(config.seekProbe){
      for(let i=0;i<1500&&player.index!==1;i++)await wait(10);
      const g=gaplessTrial.active;if(!g?.ready||player.index!==1)throw Error('Seek setup did not become ready');
      audio.pause();
      const beforeTimeline=audio.currentTime,t=performance.now();gaplessSeek(1);config.probeResult={from:gaplessPosition(),target:1,remaining:gaplessDuration()-1,deferred:Boolean(g.seekIntent),timelineBefore:beforeTimeline,positionAfterRequest:audio.currentTime,at:performance.now()-t};
      await finish();return;
    }
   }
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Diagnostic playback timed out')),config.timeoutMs||20000);const poll=setInterval(()=>{if(fallbacks.length){clearTimeout(timer);clearInterval(poll);reject(Error('Production engine requested ordinary fallback'));}},25);audio.addEventListener('ended',()=>{clearTimeout(timer);clearInterval(poll);resolve();},{once:true});});
   await finish();
 }catch(e){await finish(e.message);}
})();
