// Minimal capture worklet: posts Float32 chunks to main thread.
// If passThrough is true, forwards input to output.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.label = options?.processorOptions?.label || 'tap';
    this.passThrough = !!options?.processorOptions?.passThrough;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (input && input[0]) {
      const ch0 = input[0];
      // post a copy
      this.port.postMessage({ label: this.label, samples: ch0.slice(0) });
      // pass-through if requested
      if (this.passThrough && output && output[0]) {
        output[0].set(ch0);
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
