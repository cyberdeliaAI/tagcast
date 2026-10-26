"use strict";
// Opt-in visual regression fixtures. No accounts, providers or real music.
const assert = require("node:assert/strict");
const {mkdirSync, writeFileSync} = require("node:fs");
const path = require("node:path");
const coverUrl = "https://mini-player-fixture.invalid/cover.svg";
const artwork = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320"><defs><linearGradient id="a" x2="1" y2="1"><stop stop-color="#192f38"/><stop offset="1" stop-color="#467674"/></linearGradient></defs><path fill="url(#a)" d="M0 0h320v320H0z"/><circle cx="218" cy="157" r="120" fill="none" stroke="#b3c5a2" stroke-width="1" opacity=".55"/><circle cx="218" cy="157" r="94" fill="none" stroke="#b3c5a2" opacity=".5"/><circle cx="218" cy="157" r="68" fill="none" stroke="#b3c5a2" opacity=".5"/><path d="M-25 260 280-30M-10 310 330-10" stroke="#e5be79" stroke-width="22" opacity=".85"/><text x="24" y="39" fill="#f2eddb" font-family="sans-serif" font-size="14" letter-spacing="3">TAGCAST SESSIONS</text><text x="24" y="287" fill="#f2eddb" font-family="Georgia" font-size="34">After Hours</text></svg>`;
async function captureMini({owner, mini}) {
  const directory = process.env.TAGCAST_MINI_VISUAL_REPORT;
  mkdirSync(directory, {recursive:true});
  const wc=mini.webContents, results=[];
  wc.session.protocol.handle("https", request => new Response(request.url===coverUrl?artwork:"", {status:request.url===coverUrl?200:404,headers:{"Content-Type":"image/svg+xml"}}));
  const active=await owner.executeJavaScript('miniOwner.active');
  await owner.executeJavaScript('miniOwner.active=false');
  const normal={title:"Blue in the evening",artist:"The Tagcast Ensemble",album:"After Hours",cover:coverUrl,position:142,duration:267,paused:false,controllable:true,seekable:true,previous:true,next:true,status:""};
  async function shot(name,width,height,state={}) {
    mini.setSize(width,height);
    const next={...normal,theme:"dark",palette:"ocean",...state};
    await owner.executeJavaScript(`window.tagcastMiniOwner.publish({...miniSnapshot(),...${JSON.stringify(next)}})`);
    for(let n=0;n<50;n++) {
      if(await wc.executeJavaScript(`playback?.title===${JSON.stringify(next.title)}&&playback?.theme===${JSON.stringify(next.theme)}&&playback?.palette===${JSON.stringify(next.palette)}&&playback?.status===${JSON.stringify(next.status)}`))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    if(next.cover)await wc.executeJavaScript(`nodes.cover.decode().catch(()=>{})`);
    await wc.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const metrics=await wc.executeJavaScript(`(()=>{
      const r=n=>{const b=n.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom};};
      const slider=r(nodes.position),transport=r(document.querySelector('[aria-label="Playback"]'));
      return {viewport:{width:innerWidth,height:innerHeight},horizontalOverflow:document.documentElement.scrollWidth>innerWidth,verticalOverflow:document.documentElement.scrollHeight>innerHeight,slider,transport,buttons:[nodes.previous,nodes.play,nodes.next,nodes.pin,nodes.open].map(r),audioElements:document.querySelectorAll('audio,video').length,elapsed:document.querySelector('#elapsed')?.textContent||document.querySelector('#time')?.textContent,title:nodes.title.textContent,artist:nodes.artist.textContent};
    })()`);
    assert.equal(metrics.horizontalOverflow,false,name+" horizontal overflow");
    assert.equal(metrics.audioElements,0);
    if(process.env.TAGCAST_MINI_VISUAL_STRICT){
      assert.equal(metrics.verticalOverflow,false,name+" vertical overflow");
      for(const b of metrics.buttons)assert.ok(b.width>=32&&b.height>=32,name+" hit target");
      const [previous,play,nextButton]=metrics.buttons;
      assert.ok(Math.abs(play.x+play.width/2-(metrics.transport.x+metrics.transport.width/2))<1,name+" balanced transport");
      if(metrics.viewport.width>360){
        assert.ok(metrics.transport.right<=metrics.slider.x,name+" transport before progress");
        assert.ok(Math.abs(play.y+play.height/2-(metrics.slider.y+metrics.slider.height/2))<1,name+" shared controls row");
      }
      assert.ok(play.width>previous.width&&play.width>nextButton.width,name+" dominant Play/Pause");
    }
    writeFileSync(path.join(directory,name+".png"),(await wc.capturePage()).toPNG());
    results.push({name,width,height,...metrics});
  }
  try {
    await shot("normal",500,210);
    await shot("narrow-long",420,210,{title:"A very long track title from the live concert recording (Original album version)",artist:"The Tagcast Ensemble with an exceptionally long guest artist credit",album:"After Hours · The Complete Sessions"});
    await shot("resized",680,340);
    for(const palette of ["forest","ocean","warm","ibroadcast"])for(const theme of ["light","dark"]){
      await shot(palette+"-"+theme,500,210,{theme,palette});
      await wc.executeJavaScript('bridge.pin(true)');
      await wc.executeJavaScript('new Promise(resolve=>requestAnimationFrame(resolve))');
      const contrast=await wc.executeJavaScript(`(()=>{const s=getComputedStyle(nodes.pin),rgb=c=>c.match(/[\\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}),l=c=>{const v=rgb(c);return .2126*v[0]+.7152*v[1]+.0722*v[2];};const a=l(s.color),b=l(s.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);})()`);
      assert.ok(contrast>=3,`Active Pin contrast ${palette}/${theme}: ${contrast}`);
      const visibility=await wc.executeJavaScript(`(()=>{
        const probe=document.createElement('span');document.body.append(probe);
        const rgb=c=>{const values=c.match(/[\\d.]+/g).slice(0,3).map(Number);return values.map(n=>{n=c.startsWith('color(')?n:n/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});};
        const l=c=>{const v=rgb(c);return .2126*v[0]+.7152*v[1]+.0722*v[2];};const contrast=(a,b)=>(Math.max(l(a),l(b))+.05)/(Math.min(l(a),l(b))+.05);
        const paper=getComputedStyle(document.body).backgroundColor;
        const trackExpression=getComputedStyle(nodes.position).getPropertyValue('--mini-track');
        probe.style.color=trackExpression||'var(--muted)';const track=contrast(getComputedStyle(probe).color,paper);
        nodes.pin.focus();const focusStyle=getComputedStyle(nodes.pin),focus=contrast(focusStyle.outlineColor,paper),width=parseFloat(focusStyle.outlineWidth);
        probe.remove();return {track,focus,width};
      })()`);
      if(process.env.TAGCAST_MINI_VISUAL_STRICT){assert.ok(visibility.track>=3,`Track contrast ${palette}/${theme}: ${visibility.track}`);assert.ok(visibility.focus>=3&&visibility.width>=2,`Focus ${palette}/${theme}: ${JSON.stringify(visibility)}`);}
      results.at(-1).contrast={pin:contrast,...visibility};
      if(palette==='ocean'&&theme==='dark')writeFileSync(path.join(directory,'keyboard-focus.png'),(await wc.capturePage()).toPNG());
      await wc.executeJavaScript('nodes.pin.blur();bridge.pin(false)');
    }
    await shot("missing-artwork",500,210,{cover:"",paused:true});
    await shot("preparing",500,210,{paused:true,position:0,duration:0,seekable:false,status:"Preparing audio…"});
    await shot("waiting",500,210,{status:"Buffering…"});
    await shot("error",500,210,{paused:true,seekable:false,status:"Playback error · try Next or open Tagcast"});
    await shot("empty",500,210,{title:"Nothing playing",artist:"Choose an album in Tagcast",album:"",cover:"",position:0,duration:0,paused:true,controllable:false,seekable:false,previous:false,next:false});
    wc.setZoomFactor(2);await shot("zoom-200",520,570);wc.setZoomFactor(1);
    await shot("preview",500,210,{paused:true,status:"Gapless · experimental"});
    writeFileSync(path.join(directory,"results.json"),JSON.stringify(results,null,2));
    if(process.env.TAGCAST_MINI_VISUAL_PREVIEW){
      await owner.executeJavaScript(`audio.pause();audio.currentTime=24;player.queue[0].title='Blue in the evening';player.queue[0].artist='The Tagcast Ensemble';player.queue[0].album.name='After Hours';player.queue[0].album.artwork=${JSON.stringify(coverUrl)};miniOwner.active=true;publishMiniPlayer()`);
      await new Promise(resolve=>mini.once("closed",resolve));
    }
  }finally{
    if(!wc.isDestroyed())wc.session.protocol.unhandle("https");
    await owner.executeJavaScript(`miniOwner.active=${JSON.stringify(active)};publishMiniPlayer()`);
  }
  return results.length;
}
module.exports={captureMini};
