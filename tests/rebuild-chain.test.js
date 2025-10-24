const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeAudioNode {
  constructor(ctx){
    this.context = ctx;
    this.connections = [];
    this.inputs = [];
  }
  connect(node){
    if(node){
      this.connections.push(node);
      if(!node.inputs) node.inputs = [];
      node.inputs.push(this);
    }
    return node;
  }
  disconnect(){
    this.connections = [];
  }
}

class FakeMediaStreamSource extends FakeAudioNode {
  constructor(ctx, stream){
    super(ctx);
    this.stream = stream;
  }
}

class FakeMediaStreamDestination extends FakeAudioNode {
  constructor(ctx){
    super(ctx);
    this.stream = {};
  }
}

class FakeGainNode extends FakeAudioNode {
  constructor(ctx, opts={}){
    super(ctx);
    this.gain = { value: opts.gain ?? 1 };
  }
}

class FakeBiquadFilterNode extends FakeAudioNode {
  constructor(ctx, opts={}){
    super(ctx);
    this.type = opts.type;
    this.frequency = { value: opts.frequency ?? 0 };
    this.Q = { value: opts.Q ?? 1 };
  }
  getFrequencyResponse(freqs, mag, phase){
    for(let i=0;i<freqs.length;i++){
      mag[i] = 1;
      phase[i] = 0;
    }
  }
}

class FakeAnalyserNode extends FakeAudioNode {
  constructor(ctx, opts={}){
    super(ctx);
    this.fftSize = opts.fftSize ?? 2048;
    this.smoothingTimeConstant = opts.smoothingTimeConstant ?? 0;
    this.frequencyBinCount = Math.floor(this.fftSize / 2);
  }
  getFloatTimeDomainData(arr){ arr.fill(0); }
  getFloatFrequencyData(arr){ arr.fill(-100); }
}

class FakeAudioContext {
  constructor(){
    this.sampleRate = 48000;
    this.destination = new FakeAudioNode(this);
    this._destinations = [];
  }
  createMediaStreamSource(stream){
    return new FakeMediaStreamSource(this, stream);
  }
  createMediaStreamDestination(){
    const dest = new FakeMediaStreamDestination(this);
    this._destinations.push(dest);
    return dest;
  }
  close(){ this.closed = true; }
}

class FakeMediaRecorder {
  constructor(stream){
    this.stream = stream;
    this.handlers = {};
  }
  start(){ if(this.handlers.start) this.handlers.start(); }
  stop(){ if(this.handlers.stop) this.handlers.stop(); }
  addEventListener(type, fn){ this.handlers[type] = fn; }
}

function createCanvasContext(){
  const ctx = {
    canvas: { width: 800, height: 300 },
    clearRect(){},
    fillRect(){},
    strokeRect(){},
    beginPath(){},
    moveTo(){},
    lineTo(){},
    stroke(){},
    save(){},
    restore(){},
    translate(){},
    scale(){},
    fillText(){},
    measureText(){ return { width: 0 }; },
    putImageData(){},
    setLineDash(){},
    getImageData(){
      const width = ctx.canvas.width;
      const height = ctx.canvas.height;
      return { data: new Uint8ClampedArray(width * height * 4), width, height };
    },
    createImageData(width, height){
      return { data: new Uint8ClampedArray(width * height * 4), width, height };
    },
    get globalAlpha(){ return this._alpha ?? 1; },
    set globalAlpha(v){ this._alpha = v; },
  };
  return ctx;
}

function createElement(id){
  const el = {
    id,
    value: '',
    checked: false,
    innerHTML: '',
    textContent: '',
    style: {},
    classList: { add(){}, remove(){}, toggle(){} },
    addEventListener(){},
    removeEventListener(){},
    setAttribute(){},
  };
  if(['spec','wave','mag','phase'].includes(id)){
    const ctx = createCanvasContext();
    el.clientWidth = 800;
    el.clientHeight = id === 'phase' ? 220 : 280;
    el.width = el.clientWidth;
    el.height = el.clientHeight;
    ctx.canvas = el;
    el.getContext = () => ctx;
  }else{
    el.clientWidth = 200;
    el.clientHeight = 40;
  }
  return el;
}

function createDom(){
  const elements = new Map();
  const documentElement = { style: {}, appendChild(){}, removeChild(){} };
  const body = { appendChild(){}, removeChild(){}, style: {} };
  const document = {
    body,
    documentElement,
    getElementById(id){
      if(!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    },
    createElement(tag){
      if(tag === 'a'){
        return {
          href: '',
          download: '',
          click(){},
          remove(){},
          setAttribute(){},
        };
      }
      if(tag === 'canvas') return createElement('canvas-'+Math.random());
      return createElement(tag + '-' + Math.random());
    }
  };
  return { document, elements };
}

function buildContext(){
  const { document, elements } = createDom();
  const windowObj = {
    document,
    addEventListener(){},
    removeEventListener(){},
  };

  const globals = {
    console,
    window: windowObj,
    document,
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks(){ return []; } })
      }
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout,
    clearTimeout,
    devicePixelRatio: 1,
    getComputedStyle: () => ({ getPropertyValue: () => '#000' }),
    AudioContext: FakeAudioContext,
    webkitAudioContext: FakeAudioContext,
    GainNode: FakeGainNode,
    BiquadFilterNode: FakeBiquadFilterNode,
    AnalyserNode: FakeAnalyserNode,
    MediaRecorder: FakeMediaRecorder,
    Uint8ClampedArray,
    Float32Array,
    Int16Array,
    Date,
    ImageData: class ImageData {
      constructor(width, height){
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    },
    URL: {
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: () => {}
    },
    Audio: class {
      constructor(){ }
      play(){}
    }
  };

  globals.window.AudioContext = FakeAudioContext;
  globals.window.webkitAudioContext = FakeAudioContext;

  return { context: vm.createContext(globals), elements };
}

function loadAppJs(vmContext){
  const filePath = path.join(__dirname, '..', 'app.js');
  const code = fs.readFileSync(filePath, 'utf8');
  vm.runInContext(code, vmContext, { filename: 'app.js' });
}

test('rebuildChain creates recorder destinations via audio context', () => {
  const { context: vmContext, elements } = buildContext();
  loadAppJs(vmContext);

  const hp = elements.get('hpCut'); if(hp) hp.value = '300';
  const lp = elements.get('lpCut'); if(lp) lp.value = '3400';
  const order = elements.get('order'); if(order) order.value = '4';
  const notchFreq = elements.get('notchFreq'); if(notchFreq) notchFreq.value = '50';
  const notchQ = elements.get('notchQ'); if(notchQ) notchQ.value = '30';
  const wavRate = elements.get('wavRate'); if(wavRate) wavRate.value = 'auto';
  const enable = elements.get('enableFilter'); if(enable) enable.checked = true;
  const lpOnly = elements.get('lowpassOnly'); if(lpOnly) lpOnly.checked = false;
  const applyNotch = elements.get('applyNotch'); if(applyNotch) applyNotch.checked = false;
  const showPhase = elements.get('showPhase'); if(showPhase) showPhase.checked = false;

  const audioCtx = new FakeAudioContext();
  const srcNode = new FakeMediaStreamSource(audioCtx, {});

  vmContext.__testCtx = audioCtx;
  vmContext.__testSrc = srcNode;

  assert.ok(typeof vmContext.rebuildChain === 'function', 'rebuildChain should be defined');

  vm.runInContext('ctx = __testCtx; src = __testSrc; rawDest = null; filtDest = null; chain = null;', vmContext);
  vm.runInContext('rebuildChain();', vmContext);

  const filtDest = vm.runInContext('filtDest;', vmContext);
  const rawDest = vm.runInContext('rawDest;', vmContext);

  assert.ok(filtDest instanceof FakeMediaStreamDestination, 'filtered destination created');
  assert.ok(rawDest instanceof FakeMediaStreamDestination, 'raw destination created');

  assert.strictEqual(audioCtx._destinations.length, 2, 'destinations created via AudioContext');
  assert.strictEqual(rawDest.inputs[0], srcNode, 'raw destination connected to source');

  // Second rebuild should reuse existing destinations
  const firstDestCalls = audioCtx._destinations.length;
  vm.runInContext('rebuildChain();', vmContext);
  assert.strictEqual(audioCtx._destinations.length, firstDestCalls, 'destinations reused on rebuild');
});
