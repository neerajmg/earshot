// Accumulates 128-sample quanta into 4096-sample chunks and posts them to the
// main thread with a running quantum count, so dropped quanta are countable.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.quanta = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this.quanta++;
      if (this.n + ch.length <= this.buf.length) { this.buf.set(ch, this.n); this.n += ch.length; }
      if (this.n >= 4096) {
        const out = this.buf.slice(0, this.n);
        this.port.postMessage({ buf: out.buffer, quanta: this.quanta, t: currentTime }, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);
