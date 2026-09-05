/*
 * audio.js — procedural kitchen audio with the Web Audio API. No samples.
 *  sizzle  : white noise → bandpass (centre/Q follow boil intensity) → gain
 *  crackle : random short bursts of noise through a highpass (fat spatter)
 *  hum     : low sawtooth + noise for the gas burner, level follows the knob
 *  hiss    : one-shot burst when the patty lands
 */
(function (root) {
  'use strict';
  class KitchenAudio {
    constructor() { this.ctx = null; this.enabled = false; this.level = 0; this.crackAcc = 0; }
    start() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); this.enabled = true; return; }
      const AC = root.AudioContext || root.webkitAudioContext; if (!AC) return;
      const ctx = (this.ctx = new AC());
      const master = (this.master = ctx.createGain()); master.gain.value = 0.9; master.connect(ctx.destination);
      // noise source
      const len = ctx.sampleRate * 2; const buf = ctx.createBuffer(1, len, ctx.sampleRate); const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      const mk = () => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };
      // sizzle chain
      this.sizzleBP = ctx.createBiquadFilter(); this.sizzleBP.type = 'bandpass'; this.sizzleBP.frequency.value = 4200; this.sizzleBP.Q.value = 0.7;
      this.sizzleHP = ctx.createBiquadFilter(); this.sizzleHP.type = 'highpass'; this.sizzleHP.frequency.value = 1200;
      this.sizzleGain = ctx.createGain(); this.sizzleGain.gain.value = 0;
      // amplitude flutter (the irregular "spitting")
      this.flutter = ctx.createGain(); this.flutter.gain.value = 1;
      const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 9; const lfoG = ctx.createGain(); lfoG.gain.value = 0.35; lfo.connect(lfoG); lfoG.connect(this.flutter.gain); lfo.start();
      mk().connect(this.sizzleBP); this.sizzleBP.connect(this.sizzleHP); this.sizzleHP.connect(this.flutter); this.flutter.connect(this.sizzleGain); this.sizzleGain.connect(master);
      // gentle oil bubbling (lower band)
      this.bubbleBP = ctx.createBiquadFilter(); this.bubbleBP.type = 'bandpass'; this.bubbleBP.frequency.value = 900; this.bubbleBP.Q.value = 1.5;
      this.bubbleGain = ctx.createGain(); this.bubbleGain.gain.value = 0;
      mk().connect(this.bubbleBP); this.bubbleBP.connect(this.bubbleGain); this.bubbleGain.connect(master);
      // burner hum
      this.humGain = ctx.createGain(); this.humGain.gain.value = 0;
      const humLP = ctx.createBiquadFilter(); humLP.type = 'lowpass'; humLP.frequency.value = 220;
      const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 55; osc.connect(humLP); osc.start();
      const humNoise = mk(); const hnLP = ctx.createBiquadFilter(); hnLP.type = 'lowpass'; hnLP.frequency.value = 500; humNoise.connect(hnLP); hnLP.connect(this.humGain);
      humLP.connect(this.humGain); this.humGain.connect(master);
      // crackle chain
      this.crackHP = ctx.createBiquadFilter(); this.crackHP.type = 'highpass'; this.crackHP.frequency.value = 2500; this.crackHP.connect(master);
      this.enabled = true;
    }
    stop() { this.enabled = false; if (this.ctx) this.ctx.suspend(); }
    toggle() { if (this.enabled) this.stop(); else this.start(); return this.enabled; }
    /** diag: {sizzle, spatter, oilBubble}, knob 0..1, dt */
    update(diag, knob, dt) {
      if (!this.enabled || !this.ctx) return;
      const t = this.ctx.currentTime;
      const s = Math.min(1.5, diag.sizzle || 0);
      const target = Math.pow(s, 0.8) * 0.5;
      this.sizzleGain.gain.setTargetAtTime(target, t, 0.08);
      this.sizzleBP.frequency.setTargetAtTime(3000 + 3500 * Math.min(1, s), t, 0.1);
      this.sizzleBP.Q.setValueAtTime(0.5 + 0.6 * Math.min(1, s), t);
      this.bubbleGain.gain.setTargetAtTime(Math.min(1, diag.oilBubble || 0) * 0.06, t, 0.2);
      this.humGain.gain.setTargetAtTime(knob * 0.05, t, 0.2);
      // crackles: Poisson process at the spatter rate
      this.crackAcc += (diag.spatter || 0) * dt;
      while (this.crackAcc >= 1) { this.crackAcc -= 1; this.crack(0.2 + Math.random() * 0.8); }
    }
    crack(amp) {
      if (!this.ctx) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp * 0.5, t + 0.002); g.gain.exponentialRampToValueAtTime(0.001, t + 0.02 + Math.random() * 0.05);
      src.connect(g); g.connect(this.crackHP); src.start(t, Math.random() * 1.5); src.stop(t + 0.1);
    }
    /** big initial hiss when cold meat hits hot metal */
    hiss(strength) {
      if (!this.ctx || !this.enabled) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 5000; bp.Q.value = 0.6;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.7 * strength, t + 0.05); g.gain.exponentialRampToValueAtTime(0.01, t + 1.6);
      src.connect(bp); bp.connect(g); g.connect(this.master); src.start(t, Math.random()); src.stop(t + 1.8);
      // thud
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
      const og = ctx.createGain(); og.gain.setValueAtTime(0.4, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.2); o.connect(og); og.connect(this.master); o.start(t); o.stop(t + 0.25);
    }
    click() { if (!this.ctx || !this.enabled) return; this.crack(0.3); }
  }
  root.KitchenAudio = KitchenAudio;
})(window);
