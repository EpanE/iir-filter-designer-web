// IIR Speech Filter — WebAudio implementation with recording and plots

const byId = id => document.getElementById(id);

const els = {
  hpCut:      byId('hpCut'),
  lpCut:      byId('lpCut'),
  order:      byId('order'),
  notchFreq:  byId('notchFreq'),
  notchQ:     byId('notchQ'),
  wavRate:    byId('wavRate'),
  enable:     byId('enableFilter'),
  lpOnly:     byId('lowpassOnly'),
  notch:      byId('applyNotch'),
  showPhase:  byId('showPhase'),
  startBtn:   byId('startBtn'),
  stopBtn:    byId('stopBtn'),
  recStart:   byId('recStart'),
  recStop:    byId('recStop'),
  saveBtn:    byId('saveBtn'),
  playRaw:    byId('playRaw'),
  playFiltered: byId('playFiltered'),
  status:     byId('status'),
  hint:       byId('hint'),
  fsTip:      byId('fsTip'),
  cSpec:      byId('spec'),
  cWave:      byId('wave'),
  cMag:       byId('mag'),
  cPhase:     byId('phase'),
};

let ctx, src, stream, analyserTime, analyserFreq;
let chain = null;     // { hp:[], lp:[], notch:node|null, gain:node, out:node }
let rafId = 0;
let specImage;        // ImageData for spectrogram scroll
let running = false;

let rawDest, filtDest, recRaw, recFilt, rawChunks=[], filtChunks=[];
let lastRawBlob=null, lastFiltBlob=null;

function setStatus(msg){ if(els.status) els.status.innerHTML = msg; }
function setHint(msg, ok=false){ if(els.hint) els.hint.innerHTML = msg ? `<span class="${ok?'ok':'warn'}">${msg}</span>` : ''; }

function clampCutoffs(){
  if(!ctx) return;
  const nyq = ctx.sampleRate/2;
  let hp = parseFloat(els.hpCut.value)||0;
  let lp = parseFloat(els.lpCut.value)||0;
  let warn = [];
  if(hp >= nyq){ hp = nyq-1; warn.push(`HP >= Nyquist; clamped to ${hp.toFixed(0)} Hz`); }
  if(lp >= nyq){ lp = nyq-1; warn.push(`LP >= Nyquist; clamped to ${lp.toFixed(0)} Hz`); }
  if(hp < 20){ warn.push('HP < 20 Hz may include rumble'); }
  if(lp <= hp && !els.lpOnly.checked){ warn.push('For band filters, LP must be > HP'); }
  els.hpCut.value = hp;
  els.lpCut.value = lp;
  setHint(warn.join(' · '), warn.length===0);
}

function makeCascade(type, freq, order){
  // Cascade N/2 biquads; simple Q ~ 0.707 each (approximate "Butterworth-like")
  const stages = [];
  const biquads = order/2;
  for(let i=0;i<biquads;i++){
    const biq = new BiquadFilterNode(ctx, { type, frequency: freq, Q: 1/Math.SQRT2 });
    stages.push(biq);
  }
  // chain
  for(let i=1;i<stages.length;i++) stages[i-1].connect(stages[i]);
  return stages;
}

function rebuildChain(){
  if(!ctx || !src) return;
  if(chain){
    try{
      // disconnect old chain
      src.disconnect(); 
      if(chain.gain) chain.gain.disconnect();
      if(chain.out) chain.out.disconnect();
      if(analyserTime) analyserTime.disconnect();
      if(analyserFreq) analyserFreq.disconnect();
      if(filtDest) filtDest.disconnect();
    }catch(e){}
  }
  const enable = els.enable.checked;
  const lpOnly = els.lpOnly.checked;
  const applyNotch = els.notch.checked;

  const hpCut = parseFloat(els.hpCut.value)||300;
  const lpCut = parseFloat(els.lpCut.value)||3400;
  const ord   = parseInt(els.order.value,10) || 4;
  const nf    = parseFloat(els.notchFreq.value)||50;
  const nq    = parseFloat(els.notchQ.value)||30;

  const g = new GainNode(ctx, { gain: 1.0 });
  let first = src;
  let last = g;

  if(enable){
    if(!lpOnly){
      const hp = makeCascade('highpass', hpCut, ord);
      first.connect(hp[0]); last = hp.at(-1);
      // connect chain continuation
      hp.at(-1).connect(g);
      first = g;
    }
    const lp = makeCascade('lowpass', lpCut, ord);
    (first || src).connect(lp[0]); last = lp.at(-1);
    if(applyNotch){
      const notch = new BiquadFilterNode(ctx, { type:'notch', frequency:nf, Q:nq });
      last.connect(notch); last = notch;
      chain = { hp: lpOnly?[]:[], lp, notch, gain:g };
    }else{
      chain = { hp: lpOnly?[]:[], lp, notch:null, gain:g };
    }
  }else{
    chain = { hp:[], lp:[], notch:null, gain:g };
    last = src;
  }

  // Analysis + outputs
  analyserTime = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0.4 });
  analyserFreq = new AnalyserNode(ctx, { fftSize: 1024, smoothingTimeConstant: 0.5 });

  last.connect(analyserTime);
  last.connect(analyserFreq);

  // to speakers
  last.connect(ctx.destination);

  // to filtered recorder
  if(!filtDest) filtDest = ctx.createMediaStreamDestination();
  last.connect(filtDest);

  // raw recorder split
  if(!rawDest) rawDest = ctx.createMediaStreamDestination();
  src.connect(rawDest);

  drawResponses(); // recalc response curves immediately
}

function setupSpectrogram(){
  const w = els.cSpec.width = els.cSpec.clientWidth * devicePixelRatio;
  const h = els.cSpec.height = (els.cSpec.clientHeight||240) * devicePixelRatio;
  const ctx2d = els.cSpec.getContext('2d');
  specImage = ctx2d.createImageData(w, h);
  // clear
  ctx2d.fillStyle = 'transparent';
  ctx2d.fillRect(0,0,w,h);
}

function startLoop(){
  cancelAnimationFrame(rafId);
  const waveCtx = els.cWave.getContext('2d');
  const specCtx = els.cSpec.getContext('2d');
  const magCtx  = els.cMag.getContext('2d');
  const phCtx   = els.cPhase.getContext('2d');

  // size canvases
  [els.cWave, els.cMag, els.cPhase].forEach(c=>{
    c.width  = c.clientWidth * devicePixelRatio;
    c.height = (c.clientHeight||240) * devicePixelRatio;
  });
  setupSpectrogram();

  const timeData = new Float32Array(analyserTime.fftSize);
  const freqData = new Float32Array(analyserFreq.frequencyBinCount);

  function loop(){
    if(!running) return;

    analyserTime.getFloatTimeDomainData(timeData);
    analyserFreq.getFloatFrequencyData(freqData);

    // Waveform
    drawAxes(waveCtx, els.cWave.width, els.cWave.height, 'Time');
    drawWave(waveCtx, timeData, '#60a5fa');

    // Spectrogram (scroll left)
    drawSpectrogram(specCtx, freqData);

    // Mag/Phase response updated at lower rate in drawResponses()
    // Just blit existing bitmaps (they persist on canvas)

    rafId = requestAnimationFrame(loop);
  }
  loop();

  // also recalc response at ~8 fps
  let timer = 0;
  function tick(t){
    if(!running) return;
    if(!timer || t - timer > 120){ drawResponses(); timer = t; }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function drawAxes(ctx, w, h, label){
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle = getCSS('--border');
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5,0.5,w-1,h-1);
  // grid
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  for(let i=1;i<=4;i++){
    const y = (h*i)/5;
    ctx.moveTo(0,y); ctx.lineTo(w,y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawWave(ctx, data, color){
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2*devicePixelRatio;
  const N = data.length;
  for(let i=0;i<N;i++){
    const x = (i/(N-1))*w;
    const y = (0.5 - data[i]*0.45) * h;
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();
}

function drawSpectrogram(ctx2d, freqArray){
  const w = els.cSpec.width, h = els.cSpec.height;
  // shift left by 1 px
  const img = ctx2d.getImageData(1,0,w-1,h);
  ctx2d.putImageData(img, 0, 0);

  // new column on the right from freqArray (values in dB, negative)
  const col = ctx2d.createImageData(1,h);
  for(let y=0;y<h;y++){
    const bin = Math.floor((y/h) * freqArray.length);
    const v = freqArray[bin]; // dB, negative
    const norm = Math.min(1, Math.max(0, (v + 100) / 70)); // map [-100..-30] dB -> [0..1]
    const rgb = heat(norm);
    const idx = (h-1-y)*4;
    col.data[idx] = rgb[0];
    col.data[idx+1] = rgb[1];
    col.data[idx+2] = rgb[2];
    col.data[idx+3] = 255;
  }
  ctx2d.putImageData(col, w-1, 0);
}

function heat(t){
  // simple magma-ish gradient
  const r = Math.floor(255 * Math.min(1, Math.max(0, t*1.2)));
  const g = Math.floor(255 * Math.pow(t, 2.0) * 0.8);
  const b = Math.floor(255 * Math.pow(t, 0.5) * (1-t)*0.9);
  return [r,g,b];
}

function getCSS(varName){
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || '#999';
}

function drawResponses(){
  const w = els.cMag.width, h = els.cMag.height;
  const mw = els.cMag.getContext('2d');
  const ph = els.cPhase.getContext('2d');
  drawAxes(mw, w, h, 'Mag');
  if(els.showPhase.checked) drawAxes(ph, els.cPhase.width, els.cPhase.height, 'Phase');
  else ph.clearRect(0,0,els.cPhase.width, els.cPhase.height);

  if(!ctx) return;

  // Build frequency list
  const N = 512;
  const freqs = new Float32Array(N);
  const nyq = ctx.sampleRate/2;
  for(let i=0;i<N;i++) freqs[i] = (i/(N-1))*nyq;

  // Accumulate response across active nodes using Biquad.getFrequencyResponse
  let mag = new Float32Array(N).fill(1);
  let phs = new Float32Array(N).fill(0);
  const tmpMag = new Float32Array(N);
  const tmpPhs = new Float32Array(N);

  function applyNode(node){
    node.getFrequencyResponse(freqs, tmpMag, tmpPhs);
    for(let i=0;i<N;i++){
      mag[i] *= tmpMag[i];
      phs[i] += tmpPhs[i];
    }
  }

  const enable = els.enable.checked;
  const lpOnly = els.lpOnly.checked;

  if(enable && chain){
    // hp
    if(!lpOnly && chain.hp){
      chain.hp.forEach(b=> applyNode(b));
    }
    // lp
    if(chain.lp){
      chain.lp.forEach(b=> applyNode(b));
    }
    // notch
    if(chain.notch){
      applyNode(chain.notch);
    }
  }

  // Draw magnitude (dB)
  mw.beginPath();
  mw.strokeStyle = '#60a5fa';
  mw.lineWidth = 2*devicePixelRatio;
  for(let i=0;i<N;i++){
    const x = (i/(N-1))*w;
    const dB = 20*Math.log10(Math.max(1e-5, mag[i]));
    const y = ((-dB+60)/120) * h; // map ~[+60..-60] dB to [0..h]
    if(i===0) mw.moveTo(x,y); else mw.lineTo(x,y);
  }
  mw.stroke();

  // Cutoff markers
  mw.globalAlpha = 0.7;
  mw.setLineDash([6,6]);
  mw.strokeStyle = getCSS('--border');
  const hp = parseFloat(els.hpCut.value)||300;
  const lp = parseFloat(els.lpCut.value)||3400;
  const xhp = (hp/nyq)*w;
  const xlp = (lp/nyq)*w;
  if(!els.lpOnly.checked) { mw.beginPath(); mw.moveTo(xhp,0); mw.lineTo(xhp,h); mw.stroke(); }
  mw.beginPath(); mw.moveTo(xlp,0); mw.lineTo(xlp,h); mw.stroke();
  mw.setLineDash([]);
  mw.globalAlpha = 1;

  // Phase (deg)
  if(els.showPhase.checked){
    const pctx = ph;
    const H = pctx.canvas.height, W = pctx.canvas.width;
    pctx.beginPath();
    pctx.strokeStyle = '#eab308';
    pctx.lineWidth = 2*devicePixelRatio;
    let base = unwrap(phs[0]);
    for(let i=0;i<N;i++){
      const angle = unwrap(phs[i]);
      const deg = (angle-base) * 180/Math.PI;
      const y = (0.5 - deg/720) * H; // +/-360° range centered
      const x = (i/(N-1))*W;
      if(i===0) pctx.moveTo(x,y); else pctx.lineTo(x,y);
    }
    pctx.stroke();
  }
}

function unwrap(a){
  // simple unwrap to keep continuity
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// ------- Recording & WAV export -------

function blobToArrayBuffer(blob){ return blob.arrayBuffer(); }

function encodeWavPCM16(float32, sampleRate){
  // Normalize to [-1,1], then int16
  const len = float32.length;
  const buffer = new ArrayBuffer(44 + len*2);
  const view = new DataView(buffer);
  const writeString = (o,s)=>{ for(let i=0;i<s.length;i++) view.setUint8(o+i, s.charCodeAt(i)); };

  // RIFF header
  writeString(0,'RIFF');
  view.setUint32(4, 36 + len*2, true);
  writeString(8,'WAVE');
  writeString(12,'fmt ');
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, 1, true);  // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate*2, true); // byte rate
  view.setUint16(32, 2, true);  // block align
  view.setUint16(34, 16, true); // bits
  writeString(36,'data');
  view.setUint32(40, len*2, true);

  let offset = 44;
  for(let i=0;i<len;i++){
    let s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, s < 0 ? s*0x8000 : s*0x7FFF, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function decodeToFloat(blob){
  const ab = await blobToArrayBuffer(blob);
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ac.decodeAudioData(ab);
  const ch0 = buf.getChannelData(0);
  ac.close();
  return { data: new Float32Array(ch0), rate: buf.sampleRate };
}

async function resampleTo(float32, inRate, outRate){
  if(inRate === outRate) return float32;
  const len = Math.floor(float32.length * (outRate / inRate));
  const out = new Float32Array(len);
  const ratio = inRate / outRate;
  for(let i=0;i<len;i++){
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(float32.length-1, i0+1);
    const t = x - i0;
    out[i] = float32[i0]*(1-t) + float32[i1]*t;
  }
  return out;
}

async function saveRecordings(){
  if(!lastRawBlob && !lastFiltBlob){ setStatus('No recordings to save.'); return; }

  const target = els.wavRate.value === '16000' ? 16000 : 'auto';

  async function saveOne(blob, name){
    let { data, rate } = await decodeToFloat(blob);
    if(target !== 'auto'){
      data = await resampleTo(data, rate, target);
      rate = target;
    }
    const wav = encodeWavPCM16(data, rate);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(wav);
    a.download = name;
    (document.body||document.documentElement).appendChild(a);
    a.click();
    a.remove();
  }

  if(lastRawBlob) await saveOne(lastRawBlob, 'raw.wav');
  if(lastFiltBlob) await saveOne(lastFiltBlob, 'filtered.wav');
  setStatus('Saved WAV files.');
}

// ------- Events & lifecycle -------

async function startMic(){
  if(running){ setStatus('Mic already running.'); return; }

  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    setStatus('Microphone not supported in this browser.');
    return;
  }

  try{
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation:false, noiseSuppression:false, autoGainControl:false
      }
    });
  }catch(err){
    console.error('getUserMedia failed', err);
    setStatus('Unable to access the microphone. Please allow mic permissions.');
    return;
  }

  try{
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    src = ctx.createMediaStreamSource(stream);
  }catch(err){
    console.error('AudioContext failed', err);
    setStatus('Audio system unavailable. Try a different browser.');
    stopMic();
    return;
  }

  els.fsTip.textContent = `fs: ${ctx.sampleRate} Hz`;

  // Setup recorders
  recRaw = null;
  recFilt = null;
  rawDest = null;
  filtDest = null;
  try{
    rawDest = ctx.createMediaStreamDestination();
    filtDest = ctx.createMediaStreamDestination();
    src.connect(rawDest);

    if(typeof MediaRecorder === 'undefined'){
      throw new Error('MediaRecorder unsupported');
    }

    recRaw = new MediaRecorder(rawDest.stream);
    recFilt = new MediaRecorder(filtDest.stream);
  }catch(err){
    console.error('Recorder setup failed', err);
    setStatus('Recording not supported in this environment.');
    filtDest = null;
    rawDest = null;
  }

  rawChunks = []; filtChunks = [];
  if(recRaw){
    recRaw.ondataavailable = e=> { if(e.data.size) rawChunks.push(e.data); };
    recRaw.onstop = ()=> { lastRawBlob = new Blob(rawChunks, { type: rawChunks[0]?.type || 'audio/webm' }); };
  }
  if(recFilt){
    recFilt.ondataavailable = e=> { if(e.data.size) filtChunks.push(e.data); };
    recFilt.onstop = ()=> { lastFiltBlob = new Blob(filtChunks, { type: filtChunks[0]?.type || 'audio/webm' }); };
  }

  rebuildChain();
  running = true;
  startLoop();
  setStatus('Mic running. Adjust parameters freely.');
}

function stopMic(){
  running = false;
  cancelAnimationFrame(rafId);
  if(stream){
    stream.getTracks().forEach(t=> t.stop());
    stream = null;
  }
  try{ ctx && ctx.close(); }catch(e){}
  ctx = null; src = null;
  setStatus('Stopped. Click Start Mic to run again.');
}

function recStart(){
  if(!ctx){ setStatus('Start the mic first.'); return; }
  rawChunks=[]; filtChunks=[];
  recRaw.start(); recFilt.start();
  setStatus('Recording…');
}
function recStop(){
  try{ recRaw && recRaw.stop(); }catch(e){}
  try{ recFilt && recFilt.stop(); }catch(e){}
  setStatus('Recording stopped. Click Save Recordings.');
}

// UI bindings
['hpCut','lpCut','order','notchFreq','notchQ','enable','lpOnly','notch','showPhase']
  .forEach(key=>{
    const el = els[key];
    if(!el) return;
    el.addEventListener('input', ()=>{
      clampCutoffs();
      if(ctx) rebuildChain();
    });
  });

els.startBtn.addEventListener('click', startMic);
els.stopBtn.addEventListener('click', stopMic);
els.recStart.addEventListener('click', recStart);
els.recStop.addEventListener('click', recStop);
els.saveBtn.addEventListener('click', saveRecordings);

els.playRaw.addEventListener('click', ()=>{
  if(!lastRawBlob){ setStatus('No raw recording yet.'); return; }
  new Audio(URL.createObjectURL(lastRawBlob)).play();
});
els.playFiltered.addEventListener('click', ()=>{
  if(!lastFiltBlob){ setStatus('No filtered recording yet.'); return; }
  new Audio(URL.createObjectURL(lastFiltBlob)).play();
});

window.addEventListener('resize', ()=>{
  if(!ctx) return;
  startLoop(); // resizes canvases and restarts RAF loop
});

// initial
setStatus('Ready. Click Start Mic and allow access.');
