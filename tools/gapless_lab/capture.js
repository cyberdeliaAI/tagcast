/* Measurement tap only; it outputs silence and never schedules playback. */
class CounterCapture extends AudioWorkletProcessor {
  constructor(){super();this.block=new Float32Array(8192*2);this.used=0;this.lastChannels=-1;this.port.onmessage=e=>{if(e.data==='flush'){this.flush();this.port.postMessage({flush:true});}};}
  flush(){if(!this.used)return;const data=this.block.slice(0,this.used*2);this.port.postMessage({pcm:data.buffer},[data.buffer]);this.used=0;}
  process(inputs,outputs){const input=inputs[0]||[],n=input[0]?.length||128;if(input.some(ch=>ch.some(v=>v!==0))&&input.length!==this.lastChannels){this.lastChannels=input.length;this.port.postMessage({channels:input.length,frame:currentFrame});}for(let i=0;i<n;i++){this.block[this.used*2]=input[0]?.[i]||0;this.block[this.used*2+1]=input[1]?.[i]||0;this.used++;if(this.used===8192)this.flush();}for(const out of outputs)for(const ch of out)ch.fill(0);return true;}
}
registerProcessor('counter-capture',CounterCapture);
