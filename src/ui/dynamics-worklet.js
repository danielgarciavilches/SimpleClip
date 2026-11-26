'use strict';

// Live preview of the "Tame loud parts" / "Boost quiet parts" controls.
// Same math as ffmpeg's acompressor (rms detection, averaged channels, hard knee),
// so what you hear here is what the export produces.

class DynamicsProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stages = [];
    this.port.onmessage = (e) => {
      this.stages = e.data.map((p, i) => ({
        upward: p.upward,
        ratio: p.ratio,
        thr: Math.log(p.threshold),
        thrSq: p.threshold * p.threshold,
        atk: Math.min(1, 4000 / (p.attack * sampleRate)),
        rel: Math.min(1, 4000 / (p.release * sampleRate)),
        env: this.stages[i] ? this.stages[i].env : 0,
      }));
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input.length) return true;
    const chs = input.length;
    for (let c = 0; c < output.length; c++) output[c].set(input[Math.min(c, chs - 1)]);
    const n = output[0].length;
    for (const s of this.stages) {
      for (let i = 0; i < n; i++) {
        let det = 0;
        for (let c = 0; c < chs; c++) det += Math.abs(output[c][i]);
        det /= chs;
        det *= det;
        s.env += (det - s.env) * (det > s.env ? s.atk : s.rel);
        if (s.env > 0 && (s.upward ? s.env < s.thrSq : s.env > s.thrSq)) {
          const slope = 0.5 * Math.log(s.env);
          const gain = Math.exp((slope - s.thr) / s.ratio + s.thr - slope);
          for (let c = 0; c < output.length; c++) output[c][i] *= gain;
        }
      }
    }
    return true;
  }
}

registerProcessor('dynamics', DynamicsProcessor);
