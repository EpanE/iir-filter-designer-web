// IIR Speech Filter (WebAudio) — Butterworth order control, phase plot, 16k WAV resampler, PWA-friendly.

const $ = id => document.getElementById(id);
const setStatus = m => $('status').textContent = m;

let ctx, src, dest, analyserWave, analyserFreq, rawTap, filtTap, muteGain;
let hpSections=[], lpSections=[], notch;
let running=false, recording=false, sampleRate=48000;

// capture buffers
let rawBuf=[], filtBuf=[];
let rawURL=null, filtURL=null;

const ui = {
  lowcut:$('lowcut'), highcut:$('highcut'), lpCut:$('lpCut'),
  hpOrder:$('hpOrder'), lpOrder:$('lpOrder'),
  notchF:$('notchF'), notchQ:$('notchQ'),
  enableFilter:$('enableFilter'), lpOnly:$('lpOnly'), enableNotch:$('enableNotch'),
  showPhase:$('showPhase'),
  wavRate:$('wavRate'),
  start:$('startBtn'), stop:$('stopBtn'),
  tel:$('telBtn'), pod:$('podBtn'),
  rec:$('recBtn'), save:$('saveBtn'),
  playRaw:$('playRawBtn'), playFilt:$('playFiltBtn'),
  canvSpec:$('spectrogram'), canvWave:$('waveform'), canvResp:$('response'), canvPhase:$('phase')
};

// ===== Butterworth helpers (RBJ-style biquads with Butterworth Qs) =====
function butterQList(N){ // N even
  const L = Math.floor(N/2), out=[];
  for(let k=1;k<=L;k++){ out.push(1/(2*Math.cos((2*k-1)*Math.PI/(2*N)))); }
  return out;
}
function biquadLP(fs,f0,Q=Math.SQRT1_2){
  const w0=2*Math.PI*f0/fs, c=Math.cos(w0), s=Math.sin(w0), a=s/(2*Q);
  let b0=(1-c)/2, b1=1-c, b2=(1-c)/2, a0=1+a, a1=-2*c, a2=1-a;
  return norm(b0,b1,b2,a0,a1,a2);
}
function biquadHP(fs,f0,Q=Math.SQRT1_2){
  const w0=2*Math.PI*f0/fs, c=Math.cos(w0), s=Math.sin(w0), a=s/(2*Q);
  let b0=(1+c)/2, b1=-(1+c), b2=(1+c)/2, a0=1+a, a1=-2*c, a2=1-a;
  return norm(b0,b1,b2,a0,a1,a2);
}
function biquadNotch(fs,f0,Q=30){
  const w0=2*Math.PI*f0/fs, c=Math.cos(w0), s=Math.sin(w0), a=s/(2*Q);
  let b0=1, b1=-2*c, b2=1, a0=1+a, a1=-2*c, a2=1-a;
  return norm(b0,b1,b2,a0,a1,a2);
}
function norm(b0,b1,b2,a0,a1,a2){ return { b0:b0/a0, b1:b1/a0, b2:b2/a0, a1:a1/a0, a2:a2/a0 }; }

// complex response for a biquad
function H_biquad(coeffs, w){
  const zr = Math.cos(-w), zi = Math.sin(-w);
  const z2r = Math.cos(-2*w), z2i = Math.sin(-2*w);
  // numerator n = b0 + b1 z^-1 + b2 z^-2
  let nr = coeffs.b0 + coeffs.b1*zr + coeffs.b2*z2r;
  let ni =           coeffs.b1*zi + coeffs.b2*z2i;
  // denominator d = 1 + a1 z^-1 + a2 z^-2
  let dr = 1 + coeffs.a1*zr + coeffs.a2*z2r;
  let di =     coeffs.a1*zi + coeffs.a2*z2i;
  // n/d
  const den = dr*dr + di*di;
  return { r:(nr*dr + ni*di)/den, i:(ni*dr - nr*di)/den };
}
function mulC(a,b){ return { r:a.r*b.r - a.i*b.i, i:a.r*b.i + a.i*b.r }; }
function mag(x){ return Math.hypot(x.r, x.i); }
function phase(x){ return Math.atan2(x.i, x.r); }
function unwrap(ph){ // simple unwrap
  const out=new Float32Array(ph.length); let off=0; out[0]=ph[0];
  for(let i=1;i<ph.length;i++){ let d=ph[i]-ph[i-1]; if(d>Math.PI) off-=2*Math.PI; else if(d<-Math.PI) off+=2*Math.PI; out[i]=ph[i]+off; }
  return out;
}

// ===== Drawing =====
const gSpec = ui.canvSpec.getContext('2d');
const gWave = ui.canvWave.getContext('2d');
const gResp = ui.canvResp.getContext('2d');
const gPhase = ui.canvPhase.getContext('2d');

function drawWave(arr){
  const {width:w,height:h} = ui.canvWave;
  gWave.clearRect(0,0,w,h);
  gWave.strokeStyle='#60a5fa'; gWave.lineWidth=2;
  gWave.beginPath();
  for(let i=0;i<arr.length;i++){
    const x=i/arr.length*w;
    const y=(0.5 - arr[i]/2)*h;
    if(i===0) gWave.moveTo(x,y); else gWave.lineTo(x,y);
  }
  gWave.stroke();
}

function drawSpectrogram(fft){
  const {width:w,height:h} = ui.canvSpec;
  const img = gSpec.getImageData(1,0,w-1,h);
  gSpec.putImageData(img,0,0);
  for(let y=0;y<h;y++){
    const bin=Math.floor(y/h*fft.length);
    const v=fft[fft.length-1-bin]/255;
    const hue=260-260*v;
    gSpec.fillStyle=`hsl(${hue} 90% ${20+60*v}%)`;
    gSpec.fillRect(w-1,y,1,1);
  }
}

function drawResponseAndPhase(){
  if(!ctx) return;
  const fs = sampleRate;
  const w = ui.canvResp.width, h = ui.canvResp.height;
  const w2 = ui.canvPhase.width, h2 = ui.canvPhase.height;
  gResp.clearRect(0,0,w,h); gPhase.clearRect(0,0,w2,h2);

  const freqs = new Float32Array(w);
  for(let i=0;i<w;i++) freqs[i] = i/w*(fs/2);

  // build digital sections for plotting
  const sections = [];
  if(ui.enableFilter.checked){
    if(ui.lpOnly.checked){
      butterQList(+ui.lpOrder.value).forEach(Q=>sections.push(biquadLP(fs,+ui.lpCut.value,Q)));
    }else{
      butterQList(+ui.hpOrder.value).forEach(Q=>sections.push(biquadHP(fs,+ui.lowcut.value,Q)));
      butterQList(+ui.lpOrder.value).forEach(Q=>sections.push(biquadLP(fs,+ui.highcut.value,Q)));
    }
  }
  if(ui.enableNotch.checked) sections.push(biquadNotch(fs,+ui.notchF.value,+ui.notchQ.value));

  const dB = new Float32Array(freqs.length);
  const ph = new Float32Array(freqs.length);
  for(let i=0;i<freqs.length;i++){
    const w0 = 2*Math.PI*freqs[i]/fs;
    let H = {r:1,i:0};
    for(const s of sections) H = mulC(H, H_biquad(s,w0));
    dB[i] = 20*Math.log10(mag(H)+1e-12);
    ph[i] = phase(H);
  }
  const phu = unwrap(ph);

  // magnitude
  gResp.strokeStyle='rgba(255,255,255,.15)'; gResp.lineWidth=1;
  gResp.beginPath(); gResp.moveTo(0,h-40); gResp.lineTo(w,h-40); gResp.stroke();
  gResp.beginPath(); gResp.moveTo(0,0); gResp.lineTo(0,h); gResp.stroke();

  gResp.strokeStyle='#60a5fa'; gResp.lineWidth=2; gResp.beginPath();
  for(let i=0;i<w;i++){
    const db = Math.max(-100, Math.min(10, dB[i]));
    const y = (1-(db+100)/110)*h;
    if(i===0) gResp.moveTo(i,y); else gResp.lineTo(i,y);
  } gResp.stroke();

  // phase
  if(ui.showPhase.checked){
    const deg = new Float32Array(phu.length); for(let i=0;i<deg.length;i++) deg[i]=phu[i]*180/Math.PI;
    // normalize to visible window
    let min=deg[0], max=deg[0]; for(const v of deg){ if(v<min)min=v; if(v>max)max=v; }
    const pad=20; if(max-min<180) { max=min+180; }
    gPhase.strokeStyle='rgba(255,255,255,.15)'; gPhase.lineWidth=1;
    gPhase.beginPath(); gPhase.moveTo(0,h2-pad); gPhase.lineTo(w2,h2-pad); gPhase.stroke();
    gPhase.beginPath(); gPhase.moveTo(0,0); gPhase.lineTo(0,h2); gPhase.stroke();

    gPhase.strokeStyle='#9ae6b4'; gPhase.lineWidth=2; gPhase.beginPath();
    for(let i=0;i<w;i++){
      const y = (1-(deg[i]-min)/(max-min))*h2;
      if(i===0) gPhase.moveTo(i,y); else gPhase.lineTo(i,y);
    } gPhase.stroke();
  }
}

// ===== Audio graph =====
async function start(){
  if(running) return;
  setStatus('Requesting microphone…');
  const stream = await navigator.mediaDevices.getUserMedia({audio:true});
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  sampleRate = ctx.sampleRate;

  await ctx.audioWorklet.addModule('worklet-processor.js?v=1');

  src = ctx.createMediaStreamSource(stream);
  dest = ctx.destination;
  analyserWave = ctx.createAnalyser(); analyserWave.fftSize=2048;
  analyserFreq = ctx.createAnalyser(); analyserFreq.fftSize=1024;
  notch = ctx.createBiquadFilter(); notch.type='notch';

  rawTap = new AudioWorkletNode(ctx,'capture-processor',{processorOptions:{label:'raw',passThrough:false}});
  filtTap = new AudioWorkletNode(ctx,'capture-processor',{processorOptions:{label:'filt',passThrough:true}});
  rawTap.port.onmessage = onCaptured; filtTap.port.onmessage = onCaptured;
  muteGain = ctx.createGain(); muteGain.gain.value=0;

  // Initial build
  rebuildCascade();
  buildRouting();

  running=true; ui.start.disabled=true; ui.stop.disabled=false;
  setStatus(`Running @ ${sampleRate.toFixed(0)} Hz`);
  loopVisuals();
  drawResponseAndPhase();
}

function stop(){
  if(!running) return;
  try{ ctx.close(); }catch{}
  running=false; ui.start.disabled=false; ui.stop.disabled=true;
  setStatus('Stopped.');
}

function onCaptured(e){
  if(!recording) return;
  const {label, samples} = e.data;
  if(label==='raw') rawBuf.push(samples);
  else if(label==='filt') filtBuf.push(samples);
}

// Build cascades from order selects
function rebuildCascade(){
  hpSections=[]; lpSections=[];
  if(ctx){
    const hpN = Math.max(0, (+ui.hpOrder.value|0));
    const lpN = Math.max(0, (+ui.lpOrder.value|0));
    const hpL = Math.floor(hpN/2), lpL=Math.floor(lpN/2);

    for(let i=0;i<hpL;i++){ const n = ctx.createBiquadFilter(); n.type='highpass'; hpSections.push(n); }
    for(let i=0;i<lpL;i++){ const n = ctx.createBiquadFilter(); n.type='lowpass';  lpSections.push(n); }
  }
  updateFilterParams();
}

function updateFilterParams(){
  if(!ctx) return;
  // set frequencies and Q (Butterworth)
  const hpQs = butterQList(+ui.hpOrder.value);
  const lpQs = butterQList(+ui.lpOrder.value);
  hpSections.forEach((n,i)=>{ n.frequency.value=+ui.lowcut.value; n.Q.value=hpQs[i]||Math.SQRT1_2; });
  lpSections.forEach((n,i)=>{ n.frequency.value=+ui.highcut.value; n.Q.value=lpQs[i]||Math.SQRT1_2; });
  notch.frequency.value=+ui.notchF.value; notch.Q.value=+ui.notchQ.value;
  drawResponseAndPhase();
}

function buildRouting(){
  if(!ctx) return;
  // Disconnect previous
  try{ src.disconnect(); rawTap.disconnect(); muteGain.disconnect(); analyserWave.disconnect(); analyserFreq.disconnect(); }catch{}
  // raw capture silent
  src.connect(rawTap).connect(muteGain).connect(ctx.destination);

  // chain
  let chain = src;
  if(ui.enableFilter.checked){
    if(ui.lpOnly.checked){
      // use lp only (frequency from lpCut)
      lpSections.forEach((n,i)=>{
        n.frequency.value = +ui.lpCut.value;
      });
      for(const n of lpSections) chain = chain.connect(n);
    }else{
      for(const n of hpSections) chain = chain.connect(n);
      for(const n of lpSections) chain = chain.connect(n);
    }
  }
  if(ui.enableNotch.checked) chain = chain.connect(notch);

  chain.connect(filtTap).connect(analyserWave).connect(ctx.destination);
  chain.connect(analyserFreq);
}

// visuals loop
function loopVisuals(){
  if(!running) return;
  const tbuf = new Float32Array(analyserWave.fftSize);
  analyserWave.getFloatTimeDomainData(tbuf);
  drawWave(tbuf);

  const fbuf = new Uint8Array(analyserFreq.frequencyBinCount);
  analyserFreq.getByteFrequencyData(fbuf);
  drawSpectrogram(fbuf);

  requestAnimationFrame(loopVisuals);
}

// Presets
function telephone(){ ui.lowcut.value=300; ui.highcut.value=3400; ui.lpCut.value=4000; ui.notchF.value=50; ui.notchQ.value=30; updateFilterParams(); buildRouting(); }
function podcast(){ ui.lowcut.value=80; ui.highcut.value=8000; ui.lpCut.value=6000; ui.notchF.value=50; ui.notchQ.value=35; updateFilterParams(); buildRouting(); }

// Recording
function toggleRecord(){
  if(!running){ setStatus('Start mic first.'); return; }
  recording=!recording;
  if(recording){
    rawBuf=[]; filtBuf=[];
    ui.rec.textContent='Stop Recording';
    ui.save.disabled=true; ui.playRaw.disabled=true; ui.playFilt.disabled=true;
    setStatus('Recording…');
  }else{
    ui.rec.textContent='Start Recording';
    ui.save.disabled=false; ui.playRaw.disabled=false; ui.playFilt.disabled=false;
    setStatus('Recording stopped.');
  }
}

function float32ToWavBlob(f32, sr){
  const pcm16 = new Int16Array(f32.length);
  for(let i=0;i<f32.length;i++){
    let s=Math.max(-1,Math.min(1,f32[i])); pcm16[i]= s<0 ? s*0x8000 : s*0x7FFF;
  }
  const byteRate=sr*2, blockAlign=2, dataSize=pcm16.length*2;
  const buf=new ArrayBuffer(44+dataSize), dv=new DataView(buf); let p=0;
  const W8=(v)=>{dv.setUint8(p++,v)}, W16=(v)=>{dv.setUint16(p,v,true);p+=2}, W32=(v)=>{dv.setUint32(p,v,true);p+=4};
  "RIFF".split('').forEach(ch=>W8(ch.charCodeAt(0))); W32(36+dataSize);
  "WAVEfmt ".split('').forEach(ch=>W8(ch.charCodeAt(0))); W32(16); W16(1); W16(1); W32(sr); W32(byteRate); W16(blockAlign); W16(16);
  "data".split('').forEach(ch=>W8(ch.charCodeAt(0))); W32(dataSize);
  new Uint8Array(buf,44).set(new Uint8Array(pcm16.buffer));
  return new Blob([buf],{type:'audio/wav'});
}

async function concatToF32(chunks){
  let total=0; for(const c of chunks) total+=c.length;
  const out=new Float32Array(total); let o=0;
  for(const c of chunks){ out.set(c,o); o+=c.length; }
  return out;
}

async function resampleToRate(f32, fromRate, toRate){
  if(fromRate===toRate) return f32;
  const length = Math.ceil(f32.length * toRate / fromRate);
  // Offline resampler (high-quality)
  const offline = new OfflineAudioContext(1, length, toRate);
  const buf = offline.createBuffer(1, f32.length, fromRate);
  buf.copyToChannel(f32,0);
  const src = offline.createBufferSource(); src.buffer=buf; src.connect(offline.destination); src.start();
  const rendered = await offline.startRendering();
  const out = new Float32Array(rendered.length); rendered.copyFromChannel(out,0);
  return out;
}

async function saveRecordings(){
  if(rawBuf.length===0 && filtBuf.length===0) { setStatus('Nothing recorded.'); return; }
  const raw = await concatToF32(rawBuf);
  const fil = await concatToF32(filtBuf);
  const target = (ui.wavRate.value==='16000') ? 16000 : sampleRate;

  const rawR = await resampleToRate(raw, sampleRate, target);
  const filR = await resampleToRate(fil, sampleRate, target);

  const rawBlob=float32ToWavBlob(rawR, target);
  const filBlob=float32ToWavBlob(filR, target);

  const a=document.createElement('a'); a.download='raw.wav'; a.href=URL.createObjectURL(rawBlob); a.click(); URL.revokeObjectURL(a.href);
  const b=document.createElement('a'); b.download='filtered.wav'; b.href=URL.createObjectURL(filBlob); b.click(); URL.revokeObjectURL(b.href);

  rawURL && URL.revokeObjectURL(rawURL); filtURL && URL.revokeObjectURL(filtURL);
  rawURL=URL.createObjectURL(rawBlob); filtURL=URL.createObjectURL(filBlob);
  ui.playRaw.disabled=false; ui.playFilt.disabled=false;
  setStatus(`Saved WAVs @ ${target} Hz`);
}

function play(url){ new Audio(url).play(); }

// Wire up
ui.start.onclick=start; ui.stop.onclick=stop;
ui.tel.onclick=telephone; ui.pod.onclick=podcast;
ui.rec.onclick=toggleRecord; ui.save.onclick=saveRecordings;
ui.playRaw.onclick=()=>rawURL&&play(rawURL); ui.playFilt.onclick=()=>filtURL&&play(filtURL);

// parameter changes
['lowcut','highcut','lpCut','notchF','notchQ'].forEach(id => $(id).addEventListener('input', ()=>{ updateFilterParams(); buildRouting(); }));
['enableFilter','lpOnly','enableNotch','showPhase','wavRate'].forEach(id => $(id).addEventListener('change', ()=>{ updateFilterParams(); buildRouting(); }));
['hpOrder','lpOrder'].forEach(id => $(id).addEventListener('change', ()=>{ rebuildCascade(); buildRouting(); }));

// visuals
function loopVisuals(){
  if(!running) return;
  const tbuf=new Float32Array(analyserWave.fftSize); analyserWave.getFloatTimeDomainData(tbuf); drawWave(tbuf);
  const fbuf=new Uint8Array(analyserFreq.frequencyBinCount); analyserFreq.getByteFrequencyData(fbuf); drawSpectrogram(fbuf);
  requestAnimationFrame(loopVisuals);
}
