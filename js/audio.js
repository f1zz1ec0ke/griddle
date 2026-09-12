/*
 * audio.js — procedural kitchen audio with the Web Audio API. No samples.
 *
 * The sizzle is a diagnostic, not decoration: it has two voices and they say different things.
 *   boil    : water flashing out of the face that is against the metal. Millimetre bubbles
 *             collapsing by the hundred — low (1–2 kHz), loud, and violently amplitude-modulated.
 *             It is the sound of a wet underside, and nothing browns while you can hear it.
 *   fry     : what is left once that face has boiled dry — fat at 180 °C on hot metal. Much
 *             higher (5–7 kHz), much quieter, steady, with sparse pops where a droplet of water
 *             trapped in the fat flashes. The moment the first turns into the second is the
 *             moment the crust starts, and a cook hears it long before they see it.
 *   roar    : a kettle drawing air through its vents. A pan does not have this at all.
 *   whoosh  : fat landing on the coals and lighting.
 *   crackle : short noise bursts (spatter, and pops off a dry crust) through a highpass whose
 *             corner rises as the pan dries out, because dry pops are brighter than wet ones.
 *   hum     : low sawtooth + noise for the gas burner, level follows the knob.
 *   muffle  : a lid on the pan (or the kettle) is a low-pass filter and about 5 dB down. Everything
 *             goes through it, which is why a lid makes the pan sound as if it is a room away.
 * A patty lifted on the blade stops sizzling: physics scales both voices by the contact fraction
 * (diag.contact), so the sound drops with the meat and comes back when it lands.
 */
(function (root) {
  'use strict';
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  class KitchenAudio {
    constructor(options={}) { this.options=options;this.ctx = null; this.enabled = false; this.level = 0; this.crackAcc = 0; this.flareWas = 0; this.lastWhoosh = -9; }
    start() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume();this.master.gain.value=.9; this.enabled = true; return; }
      const AC = root.AudioContext || root.webkitAudioContext; if (!AC) return;
      const ctx = (this.ctx = this.options.context||new AC());
      // everything goes through the lid before it reaches the room
      const muffle = (this.muffle = ctx.createBiquadFilter()); muffle.type = 'lowpass'; muffle.frequency.value = 20000; muffle.Q.value = 0.7;
      const muffleGain = (this.muffleGain = ctx.createGain()); muffleGain.gain.value = 1;
      muffle.connect(muffleGain); muffleGain.connect(this.options.output||ctx.destination);
      const master = (this.master = ctx.createGain()); master.gain.value = 0.9; master.connect(muffle);
      // noise source
      const len = ctx.sampleRate * 2; const buf = ctx.createBuffer(1, len, ctx.sampleRate); const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      const mk = () => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };
      // ---- boiling: low band, hard flutter
      this.boilBP = ctx.createBiquadFilter(); this.boilBP.type = 'bandpass'; this.boilBP.frequency.value = 1500; this.boilBP.Q.value = 0.5;
      this.boilGain = ctx.createGain(); this.boilGain.gain.value = 0;
      this.flutter = ctx.createGain(); this.flutter.gain.value = 1;
      // the irregular spitting: two detuned LFOs so it never sounds like a tremolo pedal
      this.flutterDepth = ctx.createGain(); this.flutterDepth.gain.value = 0.4;
      const lfo1 = ctx.createOscillator(); lfo1.type = 'sine'; lfo1.frequency.value = 9;
      const lfo2 = ctx.createOscillator(); lfo2.type = 'triangle'; lfo2.frequency.value = 3.3;
      const mix = ctx.createGain(); mix.gain.value = 0.5; lfo1.connect(mix); lfo2.connect(mix);
      mix.connect(this.flutterDepth); this.flutterDepth.connect(this.flutter.gain); lfo1.start(); lfo2.start();
      mk().connect(this.boilBP); this.boilBP.connect(this.flutter); this.flutter.connect(this.boilGain); this.boilGain.connect(master);
      // ---- frying: high, quiet, steady
      this.fryHP = ctx.createBiquadFilter(); this.fryHP.type = 'highpass'; this.fryHP.frequency.value = 5000; this.fryHP.Q.value = 0.8;
      this.fryGain = ctx.createGain(); this.fryGain.gain.value = 0;
      mk().connect(this.fryHP); this.fryHP.connect(this.fryGain); this.fryGain.connect(master);
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
      // the fire's draught: broad low noise, level and corner following the vents
      this.roarLP = ctx.createBiquadFilter(); this.roarLP.type = 'lowpass'; this.roarLP.frequency.value = 160; this.roarLP.Q.value = 1.2;
      this.roarGain = ctx.createGain(); this.roarGain.gain.value = 0;
      mk().connect(this.roarLP); this.roarLP.connect(this.roarGain); this.roarGain.connect(master);
      // crackle chain
      this.crackHP = ctx.createBiquadFilter(); this.crackHP.type = 'highpass'; this.crackHP.frequency.value = 2500; this.crackHP.connect(master);
      this.enabled = true;
    }
    stop() { this.enabled = false; if (this.ctx){if(this.options.context)this.master.gain.value=0;else this.ctx.suspend();} }
    toggle() { if (this.enabled) this.stop(); else this.start(); return this.enabled; }
    /** diag from the physics: {boilNoise, hiss, roar, flare, contact, lid, spatter, oilBubble}; knob 0..1; dt */
    update(diag, knob, dt) {
      if (!this.enabled || !this.ctx) return;
      const t = this.ctx.currentTime;
      const boil = clamp(diag.boilNoise || 0, 0, 1.5), fry = clamp(diag.hiss || 0, 0, 1.2);
      this.level = boil + fry;
      // wet: loud, low and rough. The band drops as the boiling gets fiercer — bigger bubbles.
      this.boilGain.gain.setTargetAtTime(Math.pow(boil, 0.8) * 0.42, t, 0.08);
      this.boilBP.frequency.setTargetAtTime(2000 - 700 * Math.min(1, boil), t, 0.12);
      this.boilBP.Q.setValueAtTime(0.4 + 0.5 * Math.min(1, boil), t);
      this.flutterDepth.gain.setTargetAtTime(0.2 + 0.55 * Math.min(1, boil), t, 0.15);
      // dry: a fifth of the level, an octave and a half up, and steady
      this.fryGain.gain.setTargetAtTime(Math.pow(fry, 0.9) * 0.11, t, 0.15);
      this.fryHP.frequency.setTargetAtTime(4400 + 2600 * Math.min(1, fry), t, 0.2);
      this.bubbleGain.gain.setTargetAtTime(Math.min(1, diag.oilBubble || 0) * 0.06, t, 0.2);
      this.humGain.gain.setTargetAtTime(knob * 0.05 * (diag.roar ? 0 : 1), t, 0.2); // a kettle has no gas burner under it
      const roar = clamp(diag.roar || 0, 0, 1.4);
      this.roarGain.gain.setTargetAtTime(roar * 0.09, t, 0.4);
      this.roarLP.frequency.setTargetAtTime(110 + 130 * roar, t, 0.4);
      // the lid: high end gone and the whole thing further away
      const lid = diag.lid ? 1 : 0;
      this.muffle.frequency.setTargetAtTime(lid ? 800 : 20000, t, 0.3);
      this.muffleGain.gain.setTargetAtTime(lid ? 0.55 : 1, t, 0.3);
      // pops: spatter, the wet crackle itself, and sparse bright pops off a dry crust
      const dryShare = fry / (fry + boil + 1e-6);
      this.crackHP.frequency.setTargetAtTime(1800 + 3400 * dryShare, t, 0.2);
      this.crackAcc += Math.min(45, Math.min(40, diag.spatter || 0) + 34 * boil + 3 * fry) * dt;
      while (this.crackAcc >= 1) { this.crackAcc -= 1; this.crack((0.2 + Math.random() * 0.8) * (1 - 0.45 * dryShare)); }
      // a flare-up: fat lighting on the coals is a whoosh, not a crackle
      const flare = diag.flare || 0;
      if (flare > this.flareWas + 0.3 && t - this.lastWhoosh > 1.2) { this.lastWhoosh = t; this.whoosh(clamp(flare / 1.5, 0.3, 1)); }
      this.flareWas = Math.max(flare, this.flareWas - dt * 0.8);
    }
    crack(amp) {
      if (!this.ctx) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp * 0.5, t + 0.002); g.gain.exponentialRampToValueAtTime(0.001, t + 0.02 + Math.random() * 0.05);
      src.connect(g); g.connect(this.crackHP); src.start(t, Math.random() * 1.5); src.stop(t + 0.1);
    }
    /** Fat catching on the coals: a body of low noise sweeping up through a band as the flame climbs. */
    whoosh(strength) {
      if (!this.ctx || !this.enabled) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.9;
      bp.frequency.setValueAtTime(260, t); bp.frequency.exponentialRampToValueAtTime(1600, t + 0.45); bp.frequency.exponentialRampToValueAtTime(400, t + 1.4);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5 * strength, t + 0.12); g.gain.exponentialRampToValueAtTime(0.01, t + 1.5);
      src.connect(bp); bp.connect(g); g.connect(this.master); src.start(t, Math.random()); src.stop(t + 1.6);
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
  class SpatialKitchenAudio {
    constructor(){this.ctx=null;this.voices=new Map();this.enabled=false;}
    start(){const AC=root.AudioContext||root.webkitAudioContext;if(!AC)return;this.ctx ||= new AC();this.ctx.resume();this.enabled=true;}
    stop(){this.enabled=false;for(const {voice} of this.voices.values())voice.stop();this.ctx?.suspend();}
    effect(kind,point){
      if(!this.enabled||!this.ctx)return;const ctx=this.ctx,t=ctx.currentTime;
      const soft=['grab','food','form','pour','taste'].includes(kind),osc=ctx.createOscillator(),gain=ctx.createGain(),pan=ctx.createPanner();
      pan.panningModel='equalpower';pan.refDistance=.7;pan.rolloffFactor=1;const at=point||{x:0,y:1,z:0};pan.setPosition(at.x,at.y,at.z);
      osc.type='sine';osc.frequency.setValueAtTime(soft?150:kind==='slice'?480:900,t);osc.frequency.exponentialRampToValueAtTime(soft?65:220,t+.075);
      gain.gain.setValueAtTime(0,t);gain.gain.linearRampToValueAtTime(soft?.035:.028,t+.004);gain.gain.exponentialRampToValueAtTime(.0001,t+.12);
      osc.connect(gain);gain.connect(pan);pan.connect(ctx.destination);osc.start(t);osc.stop(t+.14);osc.onended=()=>{osc.disconnect();gain.disconnect();pan.disconnect();};
    }
    update(sources,position,forward,dt){
      if(!this.enabled||!this.ctx)return;const ctx=this.ctx,t=ctx.currentTime,listener=ctx.listener;
      if(listener.positionX){for(const [key,v] of Object.entries({positionX:position.x,positionY:position.y,positionZ:position.z,forwardX:forward.x,forwardY:forward.y,forwardZ:forward.z,upX:0,upY:1,upZ:0}))listener[key].setTargetAtTime(v,t,.04);}
      else {listener.setPosition(position.x,position.y,position.z);listener.setOrientation(forward.x,forward.y,forward.z,0,1,0);}
      const active=new Set();for(const source of sources){
        active.add(source.id);let rec=this.voices.get(source.id);
        if(!rec){const pan=ctx.createPanner();pan.panningModel='HRTF';pan.distanceModel='inverse';pan.refDistance=.75;pan.maxDistance=12;pan.rolloffFactor=1.2;pan.connect(ctx.destination);rec={pan,voice:new KitchenAudio({context:ctx,output:pan})};this.voices.set(source.id,rec);}
        if(!rec.voice.enabled)rec.voice.start();const p=source.position;
        if(rec.pan.positionX){rec.pan.positionX.setTargetAtTime(p.x,t,.05);rec.pan.positionY.setTargetAtTime(p.y,t,.05);rec.pan.positionZ.setTargetAtTime(p.z,t,.05);}else rec.pan.setPosition(p.x,p.y,p.z);
        rec.voice.update(source.state.diag,source.state.stove.knob/10,dt);
      }
      for(const [id,rec] of this.voices)if(!active.has(id)&&rec.voice.enabled)rec.voice.stop();
    }
  }
  root.SpatialKitchenAudio=SpatialKitchenAudio;
})(window);
