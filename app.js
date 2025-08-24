// IIR Speech Filter (WebAudio) — real-time chain + wav recording + plots

// UI helpers
const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $('status').textContent = m; };

let ctx, src, rawTap, filtTap, gainMute, dest, analyserWave, analyserFreq;
let hp, lp, notch;
let running = false, recording = false;
let sampleRate = 48000;

// PCM capture buffers (Float32)
let rawBuf = [];
let filtBuf = [];
let rawBlobURL = null, filtBlobURL = null;

const ui = {
  lowcut: $('lowcut'), highcut: $('highcut'), lpCut: $('lpCut'),
  notchF: $('notchF'), notchQ: $('notchQ'),
  enableFilter: $('enableFilter'), lpOnly: $('lpOnly'), enableNotch: $('enableNotch'),
  start: $('startBtn'), stop: $('stopBtn'),
  tel: $('telBtn'), pod: $('podBtn'),
  rec: $('recBtn'), save: $('saveBtn'),
  playRaw: $('playRawBtn'), playFilt: $('playFiltBtn'),
  canvSpec: $('spectrogram'), canvWave: $('waveform'), canvResp: $('response')
};

// ===== RBJ biquad coefficient helpers =====
function biquadLP(fs, f0, Q=Math.SQRT1_2){
  const w0 = 2*Math.PI*f0/fs, c = Math.cos(w0), s = Math.sin(w0), a = s/(2*Q);
  let b0=(1-c)/2, b1=1-c, b2=(1-c)/2, a0=1+a, a1=-2*c, a2=1-a;
  return norm(b0,b1,b2,a0,a1,a2);
}
function biquadHP(fs, f0, Q=Math.SQRT1_2){
  const w0 = 2*Math.PI*f0/fs, c = Math.cos(w0), s = Math.sin(w0), a = s/(2*Q);
  let b0=(1+c)/2, b1=-(1+c), b2=(1+c)/2, a0=1+a, a1=-2*c, a2=1-a;
  return norm(b0,b1,b2,a0,a1,a2);
}
function biquadNotch(fs, f0, Q=30){
  const w0 = 2*Math.PI*f0/fs, c = Math.cos(w0), s = Math.sin(w0), a = s/(2*Q);
  let b0=1, b1=-2*c, b2=1, a0=1+a, a1=-2*c, a2=1-a;
  return norm(b0,b1,b2,a0,a1,a2);
}
function norm(b0,b1,b2,a0,a1,a2){
  return { b0:b0/a0, b1:b1/a0, b2:b2/a0, a1:a1/a0, a2:a2/a0 };
}
function freqzBiquad(coeffs, freqs, fs){
  // H(z)= (b0 + b1 z^-1 + b2 z^-2)/(1 + a1 z^-1 + a2 z^-2)
  const out = new Float32Array(freqs.length);
  for(let i=0;i<freqs.length;i++){
    const w = 2*Math.PI*freqs[i]/fs;
    const z1r = Math.cos(-w), z1i = Math.sin(-w);
    const z2r = Math.cos(-2*w), z2i = Math.sin(-2*w);
    // numerator
    const nr = coeffs.b0 + coeffs.b1*z1r - coeffs.b1*0*z1i + coeffs.b2*z2r;
    const ni = coeffs.b1*z1i + coeffs.b2*z2i;
    // denominator
    const dr = 1 + coeffs.a1*z1r + coeffs.a2*z2r;
    const di = coeffs.a1*z1i + coeffs.a2*z2i;
    const mag = Math.sqrt((nr*nr+ni*ni)/(dr*dr+di*di));
    out[i] = 20*Math.log10(mag+1e-12);
  }
  return out;
}
function cascadeResponse(parts, freqs, fs){
  const acc = new Float32Array(freqs.length).fill(0);
  for(const p of parts){
    const h = freqzBiquad(p, freqs, fs);
    for(let i=0;i<acc.length;i++) acc[i]+=h[i];
  }
  return acc;
}

// ===== Drawing helpers =====
const gSpec = ui.canvSpec.getContext('2d');
const gWave = ui.canvWave.getContext('2d');
const gResp = ui.canvResp.getContext('2d');

function drawWave(array){
  const {width:w,height:h} = ui.canvWave;
  gWave.clearRect(0,0,w,h);
  gWave.strokeStyle = '#60a5fa'; gWave.lineWidth = 2;
  gWave.beginPath();
  for(let i=0;i<array.length;i++){
    const x = i/array.length*w;
    const y = (0.5 - array[i]/2)*h;
    if(i===0) gWave.moveTo(x,y); else gWave.lineTo(x,y);
  }
  gWave.stroke();
}

function drawSpectrogram(fft){
  const {width:w,height:h} = ui.canvSpec;
  // scroll left 1px
  const img = gSpec.getImageData(1,0,w-1,h);
  gSpec.putImageData(img,0,0);
  // new column on right (map magnitude to color)
  for(let y=0;y<h;y++){
    const bin = Math.floor(y/ h * fft.length);
    const v = fft[fft.length-1-bin]/255; // 0..1
    const hue = 260 - 260*v; // purple->yellow
    gSpec.fillStyle = `hsl(${hue} 90% ${Math.floor(20+60*v)}%)`;
    gSpec.fillRect(w-1, y, 1, 1);
  }
}

function drawResponse(){
  if(!ctx) return;
  const {width:w,height:h} = ui.canvResp;
  gResp.clearRect(0,0,w,h);
  const fs = sampleRate;
  const freqs = new Float32Array(w);
  for(let i=0;i<w;i++) freqs[i] = i/w*(fs/2);

  const parts = [];
  if (ui.enableFilter.checked){
    if (ui.lpOnly.checked){
      parts.push(biquadLP(fs, +ui.lpCut.value));
    } else {
      parts.push(biquadHP(fs, +ui.lowcut.value));
      parts.push(biquadLP(fs, +ui.highcut.value));
    }
  }
  if (ui.enableNotch.checked){
    parts.push(biquadNotch(fs, +ui.notchF.value, +ui.notchQ.value));
  }

  const dB = parts.length ? cascadeResponse(parts, freqs, fs) : new Float32Array(freqs.length);
  // axes
  gResp.strokeStyle = 'rgba(255,255,255,.15)'; gResp.lineWidth=1;
  gResp.beginPath(); gResp.moveTo(0,h-40); gResp.lineTo(w,h-40); gResp.stroke();
  gResp.beginPath(); gResp.moveTo(0,0); gResp.lineTo(0,h); gResp.stroke();

  // plot
  gResp.strokeStyle = '#60a5fa'; gResp.lineWidth=2;
  gResp.beginPath();
  for(let i=0;i<w;i++){
    const db = Math.max(-100, Math.min(10, dB[i]));
    const y = (1-(db+100)/110)*h;
    if(i===0) gResp.moveTo(i,y); else gResp.lineTo(i,y);
  }
  gResp.stroke();
}

// ===== Audio graph =====
async function start() {
  if (running) return;
  setStatus('Starting…');
  const stream = await navigator.mediaDevices.getUserMedia({audio:true});
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  sampleRate = ctx.sampleRate;

  // Worklet for capture
  await ctx.audioWorklet.addModule('worklet-processor.js');

  src = ctx.createMediaStreamSource(stream);

  // DSP nodes
  hp = ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value = +ui.lowcut.value; hp.Q.value=Math.SQRT1_2;
  lp = ctx.createBiquadFilter(); lp.type='lowpass';  lp.frequency.value = +ui.highcut.value; lp.Q.value=Math.SQRT1_2;
  notch = ctx.createBiquadFilter(); notch.type='notch'; notch.frequency.value=+ui.notchF.value; notch.Q.value=+ui.notchQ.value;

  analyserWave = ctx.createAnalyser(); analyserWave.fftSize = 2048;
  analyserFreq = ctx.createAnalyser(); analyserFreq.fftSize = 1024;
  dest = ctx.destination;

  // Taps
  rawTap = new AudioWorkletNode(ctx, 'capture-processor', { processorOptions: { label: 'raw', passThrough: false }});
  filtTap = new AudioWorkletNode(ctx, 'capture-processor', { processorOptions: { label: 'filt', passThrough: true }});
  rawTap.port.onmessage = onCaptured;
  filtTap.port.onmessage = onCaptured;

  // Sink for rawTap (must connect to be active, mute to 0)
  gainMute = ctx.createGain(); gainMute.gain.value = 0.0;

  // Routing
  src.connect(rawTap).connect(gainMute).connect(dest); // capture raw silently
  // Filter chain
  let chain = src;
  if (ui.enableFilter.checked){
    if (ui.lpOnly.checked){
      chain = chain.connect(lp);
    } else {
      chain = chain.connect(hp).connect(lp);
    }
  }
  if (ui.enableNotch.checked){
    chain = chain.connect(notch);
  }
  chain.connect(filtTap).connect(analyserWave).connect(dest);
  chain.connect(analyserFreq);

  running = true;
  ui.start.disabled = true; ui.stop.disabled = false;
  drawResponse();
  loopVisuals();
  setStatus(`Running @ ${sampleRate.toFixed(0)} Hz`);
}

function stop() {
  if(!running) return;
  ctx.close(); running = false;
  ui.start.disabled = false; ui.stop.disabled = true;
  setStatus('Stopped.');
}

// capture handler
function onCaptured(ev){
  if (!recording) return;
  const {label, samples} = ev.data;
  if (label==='raw') rawBuf.push(samples);
  else if (label==='filt') filtBuf.push(samples);
}

// visuals loop
function loopVisuals(){
  if (!running) return;
  // waveform
  const tbuf = new Float32Array(analyserWave.fftSize);
  analyserWave.getFloatTimeDomainData(tbuf);
  drawWave(tbuf);

  // spectrogram (magnitude)
  const fbuf = new Uint8Array(analyserFreq.frequencyBinCount);
  analyserFreq.getByteFrequencyData(fbuf);
  drawSpectrogram(fbuf);

  requestAnimationFrame(loopVisuals);
}

// update nodes + response when UI changes
function refreshNodes(){
  if (!ctx || !running) return drawResponse();
  hp.frequency.value = +ui.lowcut.value;
  lp.frequency.value = +ui.highcut.value;
  notch.frequency.value = +ui.notchF.value;
  notch.Q.value = +ui.notchQ.value;

  // Rebuild chain for enable/disable toggles
  // Disconnect everything first (safe in this small graph)
  try { src.disconnect(); } catch{}
  try { rawTap.disconnect(); gainMute.disconnect(); } catch{}
  try { analyserWave.disconnect(); analyserFreq.disconnect(); } catch{}

  src.connect(rawTap).connect(gainMute).connect(ctx.destination);

  let chain = src;
  if (ui.enableFilter.checked){
    if (ui.lpOnly.checked){ chain = chain.connect(lp); }
    else { chain = chain.connect(hp).connect(lp); }
  }
  if (ui.enableNotch.checked){ chain = chain.connect(notch); }

  chain.connect(filtTap).connect(analyserWave).connect(ctx.destination);
  chain.connect(analyserFreq);

  drawResponse();
}

// presets
function telephone(){ ui.lowcut.value=300; ui.highcut.value=3400; ui.lpCut.value=4000; ui.notchF.value=50; ui.notchQ.value=30; refreshNodes(); }
function podcast(){ ui.lowcut.value=80; ui.highcut.value=8000; ui.lpCut.value=6000; ui.notchF.value=50; ui.notchQ.value=35; refreshNodes(); }

// ===== Recording / WAV =====
function startStopRecording(){
  if (!running){ setStatus('Start mic first.'); return; }
  recording = !recording;
  if (recording){
    rawBuf = []; filtBuf = [];
    ui.rec.textContent = 'Stop Recording';
    ui.save.disabled = true; ui.playRaw.disabled = true; ui.playFilt.disabled = true;
    setStatus('Recording raw & filtered…');
  } else {
    ui.rec.textContent = 'Start Recording';
    ui.save.disabled = false; ui.playRaw.disabled = false; ui.playFilt.disabled = false;
    setStatus('Recording stopped.');
  }
}

function float32ToWavBlob(float32s, sr){
  // concat
  let total = 0; for(const b of float32s) total += b.length;
  const pcm16 = new Int16Array(total);
  let off=0;
  for(const b of float32s){
    for(let i=0;i<b.length;i++){
      let s = Math.max(-1, Math.min(1, b[i]));
      pcm16[off++] = s<0 ? s*0x8000 : s*0x7FFF;
    }
  }
  // WAV header
  const byteRate = sr * 2;
  const blockAlign = 2;
  const dataSize = pcm16.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  let p=0;
  function wStr(s){ for(let i=0;i<s.length;i++) dv.setUint8(p++, s.charCodeAt(i)); }
  function w32(v){ dv.setUint32(p, v, true); p+=4; }
  function w16(v){ dv.setUint16(p, v, true); p+=2; }

  wStr('RIFF'); w32(36 + dataSize); wStr('WAVE');
  wStr('fmt '); w32(16); w16(1); w16(1); w32(sr); w32(byteRate); w16(blockAlign); w16(16);
  wStr('data'); w32(dataSize);
  // PCM
  new Uint8Array(buf, 44).set(new Uint8Array(pcm16.buffer));
  return new Blob([buf], {type:'audio/wav'});
}

function saveRecordings(){
  const rawBlob = float32ToWavBlob(rawBuf, sampleRate);
  const filtBlob = float32ToWavBlob(filtBuf, sampleRate);
  // download
  const a = document.createElement('a');
  a.download = 'raw.wav'; a.href = URL.createObjectURL(rawBlob); a.click();
  URL.revokeObjectURL(a.href);
  const b = document.createElement('a');
  b.download = 'filtered.wav'; b.href = URL.createObjectURL(filtBlob); b.click();
  URL.revokeObjectURL(b.href);

  rawBlobURL && URL.revokeObjectURL(rawBlobURL);
  filtBlobURL && URL.revokeObjectURL(filtBlobURL);
  rawBlobURL = URL.createObjectURL(rawBlob);
  filtBlobURL = URL.createObjectURL(filtBlob);
  ui.playRaw.disabled = false; ui.playFilt.disabled = false;
  setStatus('Saved raw.wav and filtered.wav');
}

function play(url){
  const a = new Audio(url);
  a.play();
}

// ===== Wire up UI =====
ui.start.onclick = start;
ui.stop.onclick = stop;
ui.tel.onclick = telephone;
ui.pod.onclick = podcast;
ui.rec.onclick = startStopRecording;
ui.save.onclick = saveRecordings;
ui.playRaw.onclick = () => rawBlobURL && play(rawBlobURL);
ui.playFilt.onclick = () => filtBlobURL && play(filtBlobURL);

['lowcut','highcut','lpCut','notchF','notchQ','enableFilter','lpOnly','enableNotch']
  .forEach(id => $(id).addEventListener('input', refreshNodes));
