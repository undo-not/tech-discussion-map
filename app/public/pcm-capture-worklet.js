class TechMapPcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions.targetSampleRate;
    this.batchSamples = options.processorOptions.batchSamples;
    this.buffer = new Int16Array(this.batchSamples);
    this.buffered = 0;
    this.position = 0;
    this.paused = false;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'pause') this.paused = true;
      if (event.data?.type === 'resume') this.paused = false;
      if (event.data?.type === 'stop') this.stopped = true;
    };
  }

  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (!channel || this.paused) return true;
    const ratio = sampleRate / this.targetRate;
    while (this.position < channel.length) {
      const start = Math.floor(this.position);
      const end = Math.min(channel.length, Math.floor(this.position + ratio));
      let total = 0;
      for (let index = start; index < end; index += 1) total += channel[index];
      const sample = total / Math.max(1, end - start);
      this.buffer[this.buffered] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      this.buffered += 1;
      this.position += ratio;
      if (this.buffered === this.batchSamples) {
        const ready = this.buffer.buffer;
        this.port.postMessage(ready, [ready]);
        this.buffer = new Int16Array(this.batchSamples);
        this.buffered = 0;
      }
    }
    this.position -= channel.length;
    return true;
  }
}

registerProcessor('techmap-pcm-capture', TechMapPcmCapture);
