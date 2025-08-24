// Posts Float32 blocks to the main thread; can optionally pass audio through.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options){ super(); this.label=options?.processorOptions?.label||'tap'; this.passThrough=!!options?.processorOptions?.passThrough; }
  process(inputs, outputs){
    const input=inputs[0], output=outputs[0];
    if(input && input[0]){
      const ch=input[0];
      this.port.postMessage({label:this.label, samples:ch.slice(0)});
      if(this.passThrough && output && output[0]) output[0].set(ch);
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
