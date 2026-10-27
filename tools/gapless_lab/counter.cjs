"use strict";
// Independent test oracle. This code never imports the production FLAC parser/encoder.
(function(scope) {
  function word(index, track, channel, bits) {
    const mask = 2 ** bits - 1;
    let n = (index + track * (channel ? 104729 : 7919) + channel * 5003) & mask;
    n ^= n >>> 7; n = Math.imul(n, 0x9e3779b1) & mask;
    n ^= n >>> 9; n = Math.imul(n, 0x85ebca77) & mask; n ^= n >>> 8;
    return (n & mask) - 2 ** (bits - 1);
  }
  const value = (i, track, channel, bits) => word(i, track, channel, bits) / 2 ** (bits - 1);
  function reference(specs) {
    const offsets = []; let length = 0;
    for (const s of specs) { offsets.push(length); length += s.samples; }
    return {length, offsets, at(index, c) {
      let n = offsets.length - 1;
      while (n > 0 && index < offsets[n]) n--;
      return value(index - offsets[n] + (specs[n].sourceStart || 0), specs[n].track, c, specs[n].bits);
    }};
  }
  function inspect(channels, specs, options = {}) {
    if(!options.normalization) {
      const candidates=["power2","asymmetric"].map(normalization=>inspect(channels,specs,{...options,normalization}));
      return candidates.find(r=>r.measurable) || candidates[0];
    }
    const normalization=options.normalization;
    const quantize=(v,bits)=>Number.isFinite(v)?Math.round(v*(2**(bits-1)-(normalization==="asymmetric"&&v>0?1:0))):NaN;
    const ref = reference(specs), frames = channels[0]?.length || 0, count = specs[0].channels;
    const anchor = options.anchor ?? Math.min(2048, Math.floor(specs[0].samples / 4));
    const firstSignal = channels.reduce((first, plane) => {
      const at = plane.findIndex(v => v !== 0);
      return at < 0 ? first : Math.min(first, at);
    }, frames);
    let start = null;
    // Anchor inside the first file, then account for the inferred start; never realign at boundaries.
    // Device startup can produce seconds of capture silence before any audio arrives.
    // Bound the anchor search from the first signal, not the recorder's startup.
    search: for (let p = firstSignal; p < Math.min(frames - 8, firstSignal + (options.anchorLimit || specs[0].rate * 3)); p++) {
      for (let k = 0; k < 8; k++) for (let c = 0; c < count; c++) {
        if (quantize(channels[c]?.[p + k],specs[0].bits) !== Math.round(ref.at(anchor + k, c)*2**(specs[0].bits-1))) continue search;
      }
      start = p - anchor; break;
    }
    if (start === null) return {measurable:false, reason:"No exact two-channel anchor; calibrate sample rate, channel mapping and gain first.",frames};
    const boundaries = ref.offsets.slice(1).map((at, i) => ({at,from:specs[i].track,to:specs[i+1].track,mismatches:0,firstMismatch:null}));
    let mismatches = 0, firstMismatch = null, leadingMismatch = 0, trailingMissing = 0, maxZeroRun = 0, zeroRun = 0;
    const examples = [];
    for (let i = 0; i < ref.length; i++) {
      const p = start + i; let equal = p >= 0 && p < frames, zero = equal;
      for (let c = 0; c < count; c++) {
        equal &&= quantize(channels[c]?.[p],specs[0].bits) === Math.round(ref.at(i,c)*2**(specs[0].bits-1)); zero &&= channels[c]?.[p] === 0;
      }
      zeroRun = zero ? zeroRun + 1 : 0; maxZeroRun = Math.max(maxZeroRun,zeroRun);
      if (!equal) {
        mismatches++; firstMismatch ??= i;
        if (i < anchor) leadingMismatch++;
        if (p >= frames) trailingMissing++;
        if (examples.length < 12) examples.push({sample:i,captured:p,expected:Array.from({length:count},(_,c)=>ref.at(i,c)),actual:Array.from({length:count},(_,c)=>channels[c]?.[p] ?? null)});
        for (const b of boundaries) if (Math.abs(i-b.at) <= 4096) {b.mismatches++; b.firstMismatch ??= i;}
      }
    }
    let extraSignalFrames=0;
    for(let p=Math.max(0,start+ref.length);p<frames;p++)if(channels.some(c=>c[p]!==0))extraSignalFrames++;
    // Diagnostic observations only: never use these to realign or forgive the comparison above.
    const observedTrackStarts = specs.map((s,n)=>{
      const inside=Math.min(128,Math.floor(s.samples/4));
      search: for(let p=Math.max(0,start+ref.offsets[n]);p<frames-8;p++) {
        for(let k=0;k<8;k++)for(let c=0;c<count;c++)
          if(quantize(channels[c]?.[p+k],s.bits)!==word(inside+k+(s.sourceStart||0),s.track,c,s.bits))continue search;
        return {track:s.track,expected:ref.offsets[n],observed:p-inside-start,displacement:p-inside-start-ref.offsets[n]};
      }
      return {track:s.track,expected:ref.offsets[n],observed:null,displacement:null};
    });
    return {measurable:true,normalization,start,frames,extraSignalFrames,expectedFrames:ref.length,channels:count,mismatches,firstMismatch,leadingMismatch,trailingMissing,maxZeroRun,boundaries,observedTrackStarts,examples,
      exact: mismatches === 0 && extraSignalFrames === 0};
  }
  const exported = {word,value,reference,inspect};
  if (typeof module !== "undefined") module.exports = exported; else scope.gaplessCounter = exported;
})(typeof globalThis !== "undefined" ? globalThis : this);
