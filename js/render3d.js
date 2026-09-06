/*
 * render3d.js — Three.js viewport: stove, pan, patty (custom lathe with cutaway),
 * canvas-generated meat textures driven by the physics state, particles for steam,
 * smoke, spatter, sizzle bubbles, juice beads and fat drips, and orbit/zoom controls.
 */
(function (root) {
  'use strict';
  const T = root.THREE;
  const P = root.BurgerPhysics;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  const rand = (a, b) => a + Math.random() * (b - a);
  let tintedId = 0; // identifies a mask canvas in the tinted-mask cache

  // ------------------------------------------------------------ colour model
  const COL = {
    frozen: [190, 120, 130], raw: [150, 32, 44], rawWarm: [176, 58, 66], pink: [205, 118, 118],
    cooked: [158, 112, 96], dry: [118, 82, 62],
    fat: [236, 226, 208], fatMelt: [238, 200, 140],
    brown: [[168, 122, 88], [190, 140, 92], [160, 100, 52], [122, 66, 30], [86, 42, 20], [56, 28, 14], [32, 18, 12], [22, 14, 10]],
    char: [14, 12, 11],
  };
  /** Colour of one cell of the meat grid (layer k, ring j). */
  function nodeColour(p, k, j) {
    const c = k * p.Nr + (j || 0);
    const Tn = p.T[c];
    let col;
    if (Tn < 0) col = mix3(COL.frozen, COL.raw, clamp((Tn + 8) / 8, 0, 1));
    else col = mix3(COL.raw, COL.rawWarm, clamp(Tn / 40, 0, 1));
    const g = p.dG[c], m = p.dM[c];
    col = mix3(col, COL.pink, clamp(m * 0.6 + g * 0.5, 0, 1));
    col = mix3(col, COL.cooked, clamp(g, 0, 1));
    const dryness = 1 - clamp(p.w[c] / p.w0c[c], 0, 1);
    col = mix3(col, COL.dry, clamp((dryness - 0.35) / 0.6, 0, 1));
    return col;
  }
  /** Crust colour for a face (whole face, or ring j of it). */
  function faceColour(face, baseCol, j) {
    const brown = j == null ? face.brown : face.brownR[j], char = j == null ? face.char : face.charR[j];
    const b = clamp(brown, 0, 7);
    const i = Math.floor(b), t = b - i;
    let c = mix3(COL.brown[i], COL.brown[Math.min(7, i + 1)], t);
    c = mix3(baseCol, c, clamp(b / 0.8, 0, 1));
    c = mix3(c, COL.char, clamp(char / 1.1, 0, 1));
    return c;
  }

  // ------------------------------------------------------------ procedural masks
  function makeNoise(size, octaves, streak) {
    const cv = document.createElement('canvas'); cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size); const d = img.data;
    // value noise via random grids + bilinear
    const grids = [];
    for (let o = 0; o < octaves; o++) { const n = 4 << o; const g = new Float32Array(n * n); for (let k = 0; k < g.length; k++) g[k] = Math.random(); grids.push({ n, g }); }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let v = 0, amp = 1, sum = 0;
      for (let o = 0; o < octaves; o++) {
        const { n, g } = grids[o];
        const fx = ((x * (streak ? 0.35 : 1)) / size) * n, fy = (y / size) * n;
        const x0 = Math.floor(fx) % n, y0 = Math.floor(fy) % n, x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
        const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
        const a = lerp(g[y0 * n + x0], g[y0 * n + x1], tx), b = lerp(g[y1 * n + x0], g[y1 * n + x1], tx);
        v += lerp(a, b, ty) * amp; sum += amp; amp *= 0.55;
      }
      v /= sum;
      const k = (y * size + x) * 4; const val = 110 + v * 150;
      d[k] = d[k + 1] = d[k + 2] = val; d[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }
  function makeBlobs(size, count, rMin, rMax, colour) {
    const cv = document.createElement('canvas'); cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    for (let i = 0; i < count; i++) {
      const x = Math.random() * size, y = Math.random() * size, r = rand(rMin, rMax);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, colour); g.addColorStop(0.7, colour); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, r * rand(0.6, 1.4), r * rand(0.6, 1.4), Math.random() * 3, 0, Math.PI * 2); ctx.fill();
    }
    return cv;
  }

  // ------------------------------------------------------------ geometry
  /** Surface of revolution with hard corners and band UVs. profile: [{r,y,v,hard}] */
  function buildLathe(profile, segs, phiLen, phiStart) {
    phiStart = phiStart || 0;
    const pts = [];
    const same = (a, b) => a && b && Math.abs(a.r - b.r) < 1e-7 && Math.abs(a.y - b.y) < 1e-7;
    const tan = (a, b) => { const dr = b.r - a.r, dy = b.y - a.y, l = Math.hypot(dr, dy) || 1; return [dy / l, -dr / l]; };
    for (let i = 0; i < profile.length; i++) {
      const p = profile[i];
      let prev = profile[i - 1], next = profile[i + 1];
      if (same(prev, p)) prev = null; // second of a coincident pair: normal from the outgoing edge
      if (same(next, p)) next = null; // first of a coincident pair: normal from the incoming edge
      let n;
      if (prev && next) { const a = tan(prev, p), b = tan(p, next); const l = Math.hypot(a[0] + b[0], a[1] + b[1]) || 1; n = [(a[0] + b[0]) / l, (a[1] + b[1]) / l]; }
      else if (prev) n = tan(prev, p); else if (next) n = tan(p, next); else n = [0, 1];
      if (p.hard && prev && next) { pts.push({ ...p, n: tan(prev, p) }); pts.push({ ...p, n: tan(p, next) }); }
      else pts.push({ ...p, n });
    }
    const rows = pts.length, cols = segs + 1;
    const pos = new Float32Array(rows * cols * 3), nor = new Float32Array(rows * cols * 3), uv = new Float32Array(rows * cols * 2);
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      const phi = phiStart + (j / segs) * phiLen; const c = Math.cos(phi), s = Math.sin(phi);
      const k = i * cols + j; const p = pts[i];
      pos[3 * k] = p.r * c; pos[3 * k + 1] = p.y; pos[3 * k + 2] = p.r * s;
      nor[3 * k] = p.n[0] * c; nor[3 * k + 1] = p.n[1]; nor[3 * k + 2] = p.n[0] * s;
      if (p.cap) { const rr = p.r / p.cap.R; uv[2 * k] = p.cap.cx + rr * 0.235 * c; uv[2 * k + 1] = p.cap.cy + rr * 0.235 * s; }
      else { uv[2 * k] = j / segs; uv[2 * k + 1] = p.v; }
    }
    const idx = [];
    for (let i = 0; i < rows - 1; i++) for (let j = 0; j < segs; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('normal', new T.BufferAttribute(nor, 3));
    g.setAttribute('uv', new T.BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }
  // atlas layout (GL v up): top cap = planar disc centred (0.25,0.75); bottom cap = (0.75,0.75); side strip v∈[0.02,0.48]
  const BANDS = { side: [0.02, 0.48], topCap: { cx: 0.25, cy: 0.75 }, bottomCap: { cx: 0.75, cy: 0.75 } };
  function pattyProfile(R, h, dome, dimple, rawness) {
    const pr = [];
    const nb = 10, ns = 8, nt = 12;
    const cup = dome * 0.12 * h; // bottom lifts at centre when the patty domes
    const capB = { ...BANDS.bottomCap, R: R * 1.06 }, capT = { ...BANDS.topCap, R: R * 1.06 };
    for (let i = 0; i <= nb; i++) { const t = i / nb; const r = R * t; const y = cup * (1 - t * t); pr.push({ r, y: y, cap: capB }); }
    for (let i = 0; i <= ns; i++) { const t = i / ns; const bulge = Math.sin(t * Math.PI) * 0.06 * R * (0.3 + 0.7 * (1 - rawness)); pr.push({ r: R + bulge, y: t * h, v: lerp(BANDS.side[0], BANDS.side[1], t) }); }
    for (let i = 0; i <= nt; i++) {
      const t = i / nt; const r = R * (1 - t);
      let y = h + dome * 0.28 * h * (1 - (1 - t) * (1 - t));
      if (dimple) { const rr = r / (0.45 * R); if (rr < 1) y -= 0.18 * h * rawness * (1 - rr * rr); }
      pr.push({ r, y, cap: capT, hard: false });
    }
    return pr;
  }
  function crossSectionShape(profile) {
    const sh = new T.Shape();
    const right = profile.map((p) => [p.r, p.y]);
    const left = right.slice().reverse().map(([r, y]) => [-r, y]);
    const pts = right.concat(left);
    sh.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
    sh.closePath();
    return sh;
  }

  // ------------------------------------------------------------ particles
  class Puffs {
    constructor(scene, opts) {
      this.max = opts.max; this.opts = opts;
      const cv = document.createElement('canvas'); cv.width = cv.height = 64; const c = cv.getContext('2d');
      const g = c.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.4, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fillRect(0, 0, 64, 64);
      const tex = new T.CanvasTexture(cv);
      this.geo = new T.BufferGeometry();
      this.pos = new Float32Array(this.max * 3); this.alpha = new Float32Array(this.max); this.size = new Float32Array(this.max);
      this.geo.setAttribute('position', new T.BufferAttribute(this.pos, 3));
      this.geo.setAttribute('aAlpha', new T.BufferAttribute(this.alpha, 1));
      this.geo.setAttribute('aSize', new T.BufferAttribute(this.size, 1));
      this.mat = new T.ShaderMaterial({
        uniforms: { map: { value: tex }, color: { value: new T.Color(opts.color) }, scale: { value: 1 } },
        vertexShader: `attribute float aAlpha; attribute float aSize; varying float vA; uniform float scale;
          void main(){ vA=aAlpha; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=aSize*scale/-mv.z; gl_Position=projectionMatrix*mv; }`,
        fragmentShader: `uniform sampler2D map; uniform vec3 color; varying float vA;
          void main(){ vec4 t=texture2D(map,gl_PointCoord); gl_FragColor=vec4(color,t.a*vA); }`,
        transparent: true, depthWrite: false, blending: opts.additive ? T.AdditiveBlending : T.NormalBlending,
      });
      this.points = new T.Points(this.geo, this.mat); this.points.frustumCulled = false; scene.add(this.points);
      this.parts = []; this.acc = 0;
    }
    spawn(x, y, z) {
      if (this.parts.length >= this.max) return;
      const o = this.opts;
      this.parts.push({ x, y, z, vx: rand(-1, 1) * o.spread, vy: rand(o.rise * 0.6, o.rise * 1.4), vz: rand(-1, 1) * o.spread, age: 0, life: rand(o.life * 0.6, o.life * 1.4), s: rand(o.size * 0.6, o.size * 1.4), a: o.alpha });
    }
    update(dt, rate, emitter, wind) {
      this.acc += rate * dt;
      while (this.acc >= 1) { this.acc -= 1; const e = emitter(); this.spawn(e[0], e[1], e[2]); }
      const o = this.opts; let n = 0;
      for (let i = this.parts.length - 1; i >= 0; i--) {
        const p = this.parts[i]; p.age += dt;
        if (p.age > p.life) { this.parts.splice(i, 1); continue; }
        p.vx += (rand(-1, 1) * o.turb + (wind || 0)) * dt; p.vz += rand(-1, 1) * o.turb * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vy += o.accel * dt;
        const t = p.age / p.life;
        this.pos[3 * n] = p.x; this.pos[3 * n + 1] = p.y; this.pos[3 * n + 2] = p.z;
        this.alpha[n] = p.a * Math.sin(Math.PI * Math.min(1, t * 1.2)) * (1 - t * 0.5);
        this.size[n] = p.s * (1 + t * o.grow); n++;
      }
      this.geo.setDrawRange(0, n);
      this.geo.attributes.position.needsUpdate = true; this.geo.attributes.aAlpha.needsUpdate = true; this.geo.attributes.aSize.needsUpdate = true;
    }
    setScale(px) { this.mat.uniforms.scale.value = px; }
  }

  class Droplets {
    // small spheres with ballistic motion; used for spatter, beads and drips
    constructor(scene, max, radius, matOpts) {
      this.max = max;
      const geo = new T.SphereGeometry(radius, 6, 5);
      this.mesh = new T.InstancedMesh(geo, new T.MeshPhysicalMaterial(matOpts), max);
      this.mesh.instanceMatrix.setUsage(T.DynamicDrawUsage); this.mesh.frustumCulled = false;
      this.mesh.count = 0; scene.add(this.mesh);
      this.parts = []; this.dummy = new T.Object3D(); this.acc = 0;
    }
    spawn(p) { if (this.parts.length < this.max) this.parts.push(p); }
    update(dt, fn) {
      let n = 0;
      for (let i = this.parts.length - 1; i >= 0; i--) {
        const p = this.parts[i]; if (fn(p, dt) === false) { this.parts.splice(i, 1); continue; }
        this.dummy.position.set(p.x, p.y, p.z); const s = p.s || 1; this.dummy.scale.set(s, s * (p.sy || 1), s); this.dummy.updateMatrix();
        this.mesh.setMatrixAt(n++, this.dummy.matrix);
      }
      this.mesh.count = n; this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ one patty on screen
  /**
   * Everything drawn for one patty: the lathe mesh with its canvas textures, the cut face when it
   * is sliced, the cheese stack, cheese under it, and the bun once served. Textures are painted
   * from the 2-D grid: caps as concentric rings, the side band from the outer ring, the cut face
   * cell by cell.
   */
  class PattyView {
    constructor(vp, p) {
      this.vp = vp; this.p = p;
      this.group = new T.Group(); vp.scene.add(this.group);
      this.atlas = document.createElement('canvas'); this.atlas.width = 1024; this.atlas.height = 1024;
      this.atlasTex = new T.CanvasTexture(this.atlas); this.atlasTex.anisotropy = 8;
      this.roughCv = document.createElement('canvas'); this.roughCv.width = 256; this.roughCv.height = 256;
      this.roughTex = new T.CanvasTexture(this.roughCv);
      this.cut = document.createElement('canvas'); this.cut.width = 512; this.cut.height = 256;
      this.cutTex = new T.CanvasTexture(this.cut);
      this.mat = new T.MeshPhysicalMaterial({ map: this.atlasTex, roughnessMap: this.roughTex, roughness: 0.75, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.5 });
      this.cutMat = new T.MeshStandardMaterial({ map: this.cutTex, roughness: 0.6, side: T.DoubleSide });
      this.mesh = new T.Mesh(new T.BufferGeometry(), this.mat); this.mesh.castShadow = true; this.mesh.receiveShadow = true; this.mesh.userData.patty = p; this.group.add(this.mesh);
      this.cutMesh = new T.Mesh(new T.BufferGeometry(), this.cutMat); this.cutMesh.visible = false; this.cutMesh.castShadow = true; this.cutMesh.userData.patty = p; this.group.add(this.cutMesh);
      this.cheeseMeshes = []; this.underMeshes = []; this.bunGroup = null; this.bunTop = null; this.served = false;
      this.cutaway = false; this.cutPhi = 0; this.lastGeo = null; this.forceTex = true; this.texClock = 0;
      this.rebuildGeometry(true); this.paintTextures();
    }
    dispose() { this.vp.scene.remove(this.group); }
    setCutaway(on, phi) { this.cutaway = on; if (on) this.cutPhi = phi; this.rebuildGeometry(true); this.forceTex = true; }
    rebuildGeometry(force) {
      const p = this.p, R = p.D / 2, h = p.h, dome = p.dome;
      const raw = 1 - clamp(P.gridMean(p, p.dM) * 1.2, 0, 1);
      const key = [R.toFixed(4), h.toFixed(4), dome.toFixed(2), raw.toFixed(2), this.cutaway, this.served].join('|');
      if (!force && key === this.lastGeo) return; this.lastGeo = key;
      const prof = pattyProfile(R, h, dome, p.dimple, raw);
      const phi = this.cutaway ? Math.PI : Math.PI * 2;
      this.mesh.geometry.dispose(); this.mesh.geometry = buildLathe(prof, 96, phi, this.cutaway ? this.cutPhi : 0);
      if (this.served) this.buildBuns();
      if (this.cutaway) {
        this.cutMesh.geometry.dispose(); this.cutMesh.geometry = new T.ShapeGeometry(crossSectionShape(prof), 4);
        this.cutMesh.rotation.y = -(this.cutPhi || 0);
        this.cutMesh.visible = true;
        this.cutTex.repeat.set(1 / (2 * R * 1.06), 1 / (h * 1.02)); this.cutTex.offset.set(0.5, 0); this.cutTex.wrapS = this.cutTex.wrapT = T.ClampToEdgeWrapping;
      } else this.cutMesh.visible = false;
    }
    buildBuns() {
      const p = this.p, g = this.group, vp = this.vp;
      if (this.bunGroup) g.remove(this.bunGroup);
      const bg = new T.Group(); this.bunGroup = bg; g.add(bg);
      const Rb = Math.max(0.05, (p.D / 2) * 0.96);
      const crust = new T.MeshStandardMaterial({ color: 0xc98a45, roughness: 0.75 });
      const crumbTex = (soak) => {
        const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128; const c = cv.getContext('2d');
        c.fillStyle = '#f3e4c4'; c.fillRect(0, 0, 256, 128);
        c.globalCompositeOperation = 'multiply'; c.globalAlpha = 0.35; c.drawImage(vp.noiseFine, 0, 0, 256, 128); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
        for (let i = 0; i < 260; i++) { c.fillStyle = `rgba(200,170,120,${0.3 + Math.random() * 0.4})`; c.beginPath(); c.ellipse(Math.random() * 256, Math.random() * 128, 1 + Math.random() * 3, 1 + Math.random() * 2, Math.random() * 3, 0, Math.PI * 2); c.fill(); }
        if (soak > 0) { const gr = c.createLinearGradient(0, 0, 0, 128); gr.addColorStop(0, `rgba(120,50,40,${clamp(soak / 0.006, 0, 0.75)})`); gr.addColorStop(0.7, 'rgba(120,50,40,0)'); c.fillStyle = gr; c.fillRect(0, 0, 256, 128); }
        const t = new T.CanvasTexture(cv); t.wrapS = t.wrapT = T.ClampToEdgeWrapping; return t;
      };
      const phi = this.cutaway ? Math.PI : Math.PI * 2, phiStart = this.cutaway ? this.cutPhi : 0;
      const half = (prof, y0, soak) => {
        const hgrp = new T.Group(); hgrp.position.y = y0;
        const m = new T.Mesh(buildLathe(prof, 72, phi, phiStart), crust); m.castShadow = true; m.receiveShadow = true; hgrp.add(m);
        if (this.cutaway) {
          const hh = Math.max(...prof.map((q) => q.y)), rr = Math.max(...prof.map((q) => q.r));
          const tex = crumbTex(soak); tex.repeat.set(1 / (2 * rr), 1 / hh); tex.offset.set(0.5, 0);
          const face = new T.Mesh(new T.ShapeGeometry(crossSectionShape(prof), 3), new T.MeshStandardMaterial({ map: tex, roughness: 0.9, side: T.DoubleSide }));
          face.rotation.y = -phiStart; hgrp.add(face);
        }
        bg.add(hgrp); return hgrp;
      };
      const bottom = [{ r: 0, y: 0, v: 0 }, { r: Rb * 0.92, y: 0, v: 0.2 }, { r: Rb, y: 0.007, v: 0.4 }, { r: Rb * 0.98, y: 0.017, v: 0.6 }, { r: Rb * 0.85, y: 0.022, v: 0.8 }, { r: 0, y: 0.022, v: 1 }];
      const top = [{ r: 0, y: 0, v: 0 }, { r: Rb * 0.97, y: 0, v: 0.15 }, { r: Rb, y: 0.006, v: 0.3 }, { r: Rb * 0.93, y: 0.013, v: 0.5 }, { r: Rb * 0.72, y: 0.02, v: 0.7 }, { r: Rb * 0.4, y: 0.024, v: 0.85 }, { r: 0, y: 0.025, v: 1 }];
      this.bunBottomH = 0.022;
      half(bottom, -this.bunBottomH, p.bunSoak || 0);
      this.bunTop = half(top, 0, 0);
      const seedGeo = new T.SphereGeometry(1, 6, 5); const seedMat = new T.MeshStandardMaterial({ color: 0xf6ead2, roughness: 0.6 });
      let sd = 7 + (p.id || 0); const rnd = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; };
      for (let i = 0; i < 70; i++) {
        const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * Rb * 0.9;
        if (this.cutaway) { const rel = ((a - phiStart) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2); if (rel > Math.PI) continue; }
        let y = 0; for (let k = 1; k < top.length; k++) if (rr <= top[k - 1].r && rr >= top[k].r) { const t = (top[k - 1].r - rr) / (top[k - 1].r - top[k].r + 1e-9); y = lerp(top[k - 1].y, top[k].y, t); }
        const sm = new T.Mesh(seedGeo, seedMat); sm.position.set(Math.cos(a) * rr, y + 0.0005, Math.sin(a) * rr); sm.scale.set(0.0016, 0.0009, 0.0011); sm.rotation.y = rnd() * 3; this.bunTop.add(sm);
      }
    }
    paintTextures() {
      const p = this.p, vp = this.vp, Nz = p.Nz, Nr = p.Nr, A = this.atlas, c = A.getContext('2d'), W = A.width, H = A.height;
      const bt = { y0: 0, y1: H / 2, x0: 0, x1: W / 2 }, bb = { y0: 0, y1: H / 2, x0: W / 2, x1: W }, bs = { y0: H * (1 - BANDS.side[1]), y1: H * (1 - BANDS.side[0]), x0: 0, x1: W };
      c.clearRect(0, 0, W, H);
      const rawTop = p.faceUp.brown < 0.3;
      // caps: concentric rings, each ring its own cooked/crust colour (uv radius 0.235·W maps to R·1.06)
      const capR = 0.235 * W;
      const paintCap = (rg, face, k, isUp) => {
        const cx = (rg.x0 + rg.x1) / 2, cy = (rg.y0 + rg.y1) / 2;
        const g = c.createRadialGradient(cx, cy, 0, cx, cy, capR);
        for (let j = 0; j < Nr; j++) {
          const base = nodeColour(p, k, j);
          const col = isUp && rawTop ? base : faceColour(face, base, j);
          g.addColorStop(clamp((j + 0.5) / (Nr * 1.06), 0, 1), rgb(col));
        }
        const edge = isUp && rawTop ? nodeColour(p, k, Nr - 1) : faceColour(face, nodeColour(p, k, Nr - 1), Nr - 1);
        g.addColorStop(1, rgb(edge));
        c.fillStyle = g; c.fillRect(rg.x0, rg.y0, rg.x1 - rg.x0, rg.y1 - rg.y0);
      };
      paintCap(bt, p.faceUp, Nz - 1, true); paintCap(bb, p.faceDown, 0, false);
      const topEdge = rawTop ? nodeColour(p, Nz - 1, Nr - 1) : faceColour(p.faceUp, nodeColour(p, Nz - 1, Nr - 1), Nr - 1);
      const botEdge = faceColour(p.faceDown, nodeColour(p, 0, Nr - 1), Nr - 1);
      // side band: the outer ring of each layer, bottom→top
      for (let k = 0; k < Nz; k++) {
        const y1 = bs.y1 - (k / Nz) * (bs.y1 - bs.y0), y0 = bs.y1 - ((k + 1) / Nz) * (bs.y1 - bs.y0);
        let col = mix3(nodeColour(p, k, Nr - 1), nodeColour(p, k, Math.max(0, Nr - 2)), 0.3);
        if (p.faceSide && p.faceSide.brown > 0.3) col = faceColour(p.faceSide, col);
        if (k === 0) col = mix3(col, botEdge, 0.7); if (k === Nz - 1) col = mix3(col, topEdge, 0.7);
        c.fillStyle = rgb(col); c.fillRect(0, y0 - 0.5, W, y1 - y0 + 1);
      }
      c.globalCompositeOperation = 'multiply'; c.globalAlpha = 0.7; c.drawImage(vp.noise, 0, 0, W, H); c.globalAlpha = 1;
      c.globalCompositeOperation = 'multiply'; c.globalAlpha = 0.35; c.drawImage(vp.noiseFine, 0, 0, W, H); c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      const fatLeft = (k, j) => { const i = k * Nr + j; return clamp((p.fs[i] + p.fl[i]) / (p.fat0c[i] + 1e-12), 0, 1); };
      const fatLeftLayer = (k) => { let f = 0; for (let j = 0; j < Nr; j++) f += fatLeft(k, j) * p.aj[j]; return f; };
      // Lay a blob mask over one region of the atlas in a fixed colour. The colours are constants
      // (fat, melted fat, crust speckle, char, torn meat) and only the opacity follows the state,
      // so each mask is coloured once and kept (vp.tinted) and a tint is then a single blit of the
      // region. Nine of these run per repaint, and building a full-atlas colour layer for every
      // one of them was the most expensive thing the renderer did.
      const tintMask = (mask, colour, alpha, rg) => {
        if (alpha <= 0.002) return;
        const rw = rg.x1 - rg.x0, rh = rg.y1 - rg.y0;
        c.globalAlpha = alpha; c.drawImage(vp.tinted(mask, colour, W, H), rg.x0, rg.y0, rw, rh, rg.x0, rg.y0, rw, rh); c.globalAlpha = 1;
      };
      const topC = (Nz - 1) * Nr;
      if (rawTop) tintMask(vp.marble, p.T[topC] > 40 ? COL.fatMelt : COL.fat, 0.9 * fatLeftLayer(Nz - 1) * p.fatFrac * 3, bt);
      tintMask(vp.marble, COL.fatMelt, 0.6 * fatLeft(Math.floor(Nz / 2), Nr - 1) * p.fatFrac * 3, bs);
      const crustSpots = (face, rg) => {
        tintMask(vp.spots, [40, 20, 10], clamp(face.brown / 4, 0, 0.6), rg);
        tintMask(vp.blotch, COL.char, clamp(face.char / 0.6, 0, 0.75), rg);
        tintMask(vp.spots, COL.char, clamp(face.char / 0.4, 0, 0.9), rg);
        if (face.torn > 0) tintMask(vp.marbleCut, [150, 60, 60], clamp(face.torn * 3, 0, 0.8), rg);
        // grill marks: dark bars where the grate pressed into the face
        if (face.marks > 0.2) {
          const cx = (rg.x0 + rg.x1) / 2, cy = (rg.y0 + rg.y1) / 2;
          const mc = faceColour({ brown: face.marks, char: face.marksChar || 0 }, [90, 55, 30]);
          c.save(); c.beginPath(); c.arc(cx, cy, capR, 0, Math.PI * 2); c.clip(); c.translate(cx, cy); c.rotate(face.marksAngle || 0.6);
          c.fillStyle = rgb(mc); c.globalAlpha = clamp(face.marks / 2, 0, 0.9);
          for (let x = -capR; x < capR; x += capR * 0.28) c.fillRect(x - capR * 0.035, -capR, capR * 0.07, 2 * capR);
          c.restore();
        }
      };
      crustSpots(p.faceDown, bb); if (!rawTop) crustSpots(p.faceUp, bt);
      if (p.poolTop > 1e-5) { c.fillStyle = `rgba(200,70,80,${clamp(p.poolTop / 0.002, 0, 0.5)})`; c.fillRect(bt.x0, bt.y0, bt.x1 - bt.x0, bt.y1 - bt.y0); }
      if (p.T[topC] < -2) { c.fillStyle = `rgba(235,240,255,${clamp(-p.T[topC] / 20, 0, 0.6)})`; c.fillRect(0, 0, W, H); }
      this.atlasTex.needsUpdate = true;
      // roughness: wet is shiny, dry crust is matte
      const rc = this.roughCv.getContext('2d'), RW = this.roughCv.width, RH = this.roughCv.height;
      const wet = (k) => { let v = 0; for (let j = 0; j < Nr; j++) v += clamp(p.w[k * Nr + j] / p.w0c[k * Nr + j], 0, 1) * p.aj[j]; return v; };
      const rough = (v) => `rgb(${(v * 255) | 0},${(v * 255) | 0},${(v * 255) | 0})`;
      rc.fillStyle = rough(lerp(0.9, 0.35, clamp(wet(Nz - 1) * (rawTop ? 1 : 0.4) + clamp(p.poolTop / 0.002, 0, 0.6) + clamp(p.fatTop / 0.001, 0, 0.4), 0, 1))); rc.fillRect(0, 0, RW / 2, RH / 2);
      rc.fillStyle = rough(lerp(0.95, 0.5, wet(0) * 0.3)); rc.fillRect(RW / 2, 0, RW / 2, RH / 2);
      rc.fillStyle = rough(lerp(0.9, 0.3, wet(Math.floor(Nz / 2)))); rc.fillRect(0, RH / 2, RW, RH / 2);
      this.roughTex.needsUpdate = true;
      // cross-section: every cell of the grid, mirrored about the axis
      if (this.cutaway) {
        const cc = this.cut.getContext('2d'), CW = this.cut.width, CH = this.cut.height;
        const colW = CW / 2 / (Nr * 1.06), rowH = CH / Nz;
        cc.fillStyle = '#000'; cc.fillRect(0, 0, CW, CH);
        for (let k = 0; k < Nz; k++) for (let j = 0; j < Nr; j++) {
          const y0 = CH - (k + 1) * rowH;
          cc.fillStyle = rgb(nodeColour(p, k, j));
          cc.fillRect(CW / 2 + j * colW - 0.5, y0 - 0.5, colW + 1, rowH + 1);
          cc.fillRect(CW / 2 - (j + 1) * colW - 0.5, y0 - 0.5, colW + 1, rowH + 1);
        }
        cc.globalCompositeOperation = 'multiply'; cc.globalAlpha = 0.45; cc.drawImage(vp.noiseFine, 0, 0, CW, CH); cc.globalAlpha = 1; cc.globalCompositeOperation = 'source-over';
        // marbling per layer, fading as it renders
        for (let k = 0; k < Nz; k++) {
          const y1 = CH - (k / Nz) * CH, y0 = CH - ((k + 1) / Nz) * CH;
          const fl = fatLeftLayer(k); const melted = p.T[k * Nr] > 42;
          if (fl > 0.02) {
            const marb = vp.tinted(vp.marbleCut, melted ? COL.fatMelt : COL.fat, CW, CH);
            cc.globalAlpha = 0.9 * fl * p.fatFrac * 3; cc.drawImage(marb, 0, y0, CW, y1 - y0, 0, y0, CW, y1 - y0); cc.globalAlpha = 1;
          }
        }
        // crust bands, ring by ring, and the browned edge
        const crustH = (b) => clamp(b / 7, 0, 1) * 0.06 * CH + 2;
        for (let j = 0; j < Nr; j++) {
          const hb = crustH(p.faceDown.brownR[j]); cc.fillStyle = rgb(faceColour(p.faceDown, nodeColour(p, 0, j), j));
          cc.fillRect(CW / 2 + j * colW - 0.5, CH - hb, colW + 1, hb); cc.fillRect(CW / 2 - (j + 1) * colW - 0.5, CH - hb, colW + 1, hb);
          if (p.faceUp.brown > 0.3) { const ht = crustH(p.faceUp.brownR[j]); cc.fillStyle = rgb(faceColour(p.faceUp, nodeColour(p, Nz - 1, j), j)); cc.fillRect(CW / 2 + j * colW - 0.5, 0, colW + 1, ht); cc.fillRect(CW / 2 - (j + 1) * colW - 0.5, 0, colW + 1, ht); }
        }
        // free juice glistening between fibres
        for (let k = 0; k < Nz; k++) for (let j = 0; j < Nr; j++) {
          const i = k * Nr + j; const free = Math.max(0, p.w[i] - P.waterHolding(p, i) * p.w0c[i]) / p.w0c[i];
          if (free > 0.005) { const y0 = CH - (k + 1) * rowH; cc.fillStyle = `rgba(230,90,100,${clamp(free * 6, 0, 0.5)})`; cc.fillRect(CW / 2 + j * colW, y0, colW, rowH); cc.fillRect(CW / 2 - (j + 1) * colW, y0, colW, rowH); }
        }
        this.cutTex.needsUpdate = true;
      }
    }
    /**
     * Everything the canvas textures are painted from, quantised to the smallest step that could
     * show up on screen: a hundredth of a browning unit (the crust ramp has eight colour stops
     * across seven units), a fifth of a degree, half a percent of moisture, a twentieth of a
     * millimetre. Sampled at both faces, both rings and six depths, so any change big enough to
     * move a pixel of the caps, the side band or the cut face moves one of these numbers.
     */
    texSignature(out) {
      const p = this.p, Nz = p.Nz, Nr = p.Nr, q = (v, step) => Math.round(v / step);
      let i = 0;
      for (const f of [p.faceDown, p.faceUp]) {
        out[i++] = q(f.brown, 0.01); out[i++] = q(f.char, 0.004); out[i++] = q(f.torn, 0.01); out[i++] = q(f.marks || 0, 0.01);
        out[i++] = q(f.brownR[0], 0.01); out[i++] = q(f.brownR[Nr >> 1], 0.01); out[i++] = q(f.brownR[Nr - 1], 0.01); out[i++] = q(f.charR[Nr - 1], 0.004);
      }
      out[i++] = q(p.faceSide.brown, 0.01); out[i++] = q(p.faceSide.char, 0.004);
      out[i++] = q(p.dome, 0.01); out[i++] = q(p.D, 5e-5); out[i++] = q(p.h, 5e-5);
      out[i++] = q(p.poolTop, 2e-6); out[i++] = q(p.fatTop, 2e-6); out[i++] = q(p.cheeses.length, 1);
      for (let n = 0; n < 6; n++) {
        const k = Math.min(Nz - 1, Math.round((n * (Nz - 1)) / 5));
        for (const j of [0, Nr - 1]) {
          const c = k * Nr + j;
          out[i++] = q(p.T[c], 0.2); out[i++] = q(p.dG[c], 0.004); out[i++] = q(p.dM[c], 0.004);
          out[i++] = q(p.w[c] / p.w0c[c], 0.004); out[i++] = q((p.fs[c] + p.fl[c]) / (p.fat0c[c] + 1e-12), 0.01);
        }
      }
      return i;
    }
    /** True when anything the textures are painted from has moved a visible amount. */
    texDirty() {
      const cur = this._sigA || (this._sigA = new Float64Array(128)); // 84 numbers today, room to add more
      const n = this._sigN = this.texSignature(cur), prev = this._sigB;
      if (!prev) return true;
      for (let i = 0; i < n; i++) if (cur[i] !== prev[i]) return true;
      return false;
    }
    /** Remember what the atlas was last painted from (only after it really was repainted). */
    texCommit() { const cur = this._sigA; this._sigB = this._sigB || new Float64Array(cur.length); this._sigB.set(cur); }
    /** Per-frame: position, geometry, textures, cheese, buns. */
    update(state, dt, where, position, mode) {
      const p = this.p, g = this.group;
      this.texClock += dt;
      if (where === 'pan') g.position.set(position.x, this.vp.panFloorY + 0.0012 * p.cheeseUnder.length, position.z);
      else if (where === 'board') g.position.set(position.x, 0, position.z);
      else {
        const served = where === 'cut';
        if (served !== this.served) { this.served = served; if (served) this.buildBuns(); else if (this.bunGroup) { g.remove(this.bunGroup); this.bunGroup = null; } }
        g.position.set(position.x, position.y + (served ? this.bunBottomH : 0), position.z);
        if (this.bunTop) this.bunTop.position.y = p.h * (1 + 0.28 * p.dome) + p.cheeses.length * 0.0015 + 0.001;
      }
      this.rebuildGeometry(false);
      // Repaint at most ten times a second, and only when the meat actually looks different:
      // resting, plated or paused, nothing moves and the atlas is left alone entirely.
      if (this.forceTex) { this.texClock = 0; this.forceTex = false; this.texDirty(); this.texCommit(); this.paintTextures(); }
      else if (this.texClock > 0.1 && this.texDirty() && this.vp.claimTexBudget()) { this.texClock = 0; this.texCommit(); this.paintTextures(); }
      this.updateCheese();
    }
    updateCheese() {
      const p = this.p, g = this.group;
      while (this.cheeseMeshes.length > p.cheeses.length) g.remove(this.cheeseMeshes.pop());
      while (this.cheeseMeshes.length < p.cheeses.length) {
        const k = this.cheeseMeshes.length;
        const geo = new T.PlaneGeometry(0.095, 0.095, 14, 14); geo.rotateX(-Math.PI / 2);
        geo.setAttribute('color', new T.BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(1), 3));
        const m = new T.Mesh(geo, new T.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, clearcoat: 0.3, side: T.DoubleSide }));
        m.castShadow = true; m.userData.base = geo.attributes.position.array.slice(); m.rotation.y = p.cheeses[k].rot; g.add(m); this.cheeseMeshes.push(m);
      }
      const yellow = [0.95, 0.70, 0.24], melted = [0.99, 0.74, 0.20], golden = [0.72, 0.42, 0.10], dark = [0.28, 0.13, 0.05];
      const skirtColour = (sk, onTop) => { if (!sk) return onTop; let c = mix3(onTop, golden, clamp(sk.brown / 2.5, 0, 1)); c = mix3(c, dark, clamp((sk.brown - 2.5) / 3, 0, 1)); return mix3(c, [0.06, 0.05, 0.04], clamp(sk.char / 0.8, 0, 1)); };
      while (this.underMeshes.length > p.cheeseUnder.length) g.remove(this.underMeshes.pop());
      while (this.underMeshes.length < p.cheeseUnder.length) {
        const geo = new T.PlaneGeometry(0.095, 0.095, 2, 2); geo.rotateX(-Math.PI / 2);
        const m = new T.Mesh(geo, new T.MeshPhysicalMaterial({ color: 0xf2b23c, roughness: 0.5, clearcoat: 0.2, side: T.DoubleSide }));
        m.receiveShadow = true; g.add(m); this.underMeshes.push(m);
      }
      for (let k = 0; k < this.underMeshes.length; k++) {
        const mesh = this.underMeshes[k], ch = p.cheeseUnder[k], sk = ch.skirt;
        const lift = 0.0012 * p.cheeseUnder.length;
        mesh.rotation.y = ch.rot; mesh.position.y = -lift + 0.0005 + k * 0.0012; const sp = 1.06 + 0.06 * ch.melt; mesh.scale.set(sp, 1, sp);
        const c = skirtColour(sk, mix3(yellow, melted, ch.melt)); mesh.material.color.setRGB(c[0], c[1], c[2]);
        mesh.material.roughness = clamp(0.5 - 0.3 * ch.melt + (sk ? 0.4 * sk.dry : 0), 0.05, 1);
      }
      const TAU = Math.PI * 2;
      const clipFor = (rot) => {
        if (!this.cutaway) return null;
        const cr = Math.cos(rot), sr = Math.sin(rot), cp = this.cutPhi, dx = Math.cos(cp), dz = Math.sin(cp);
        return (x, z) => { const gx = x * cr + z * sr, gz = -x * sr + z * cr; const rel = ((Math.atan2(gz, gx) - cp) % TAU + TAU) % TAU; if (rel < Math.PI) return null; const t = gx * dx + gz * dz; const px = t * dx, pz = t * dz; return [px * cr - pz * sr, px * sr + pz * cr]; };
      };
      for (let k = 0; k < this.cheeseMeshes.length; k++) {
        const mesh = this.cheeseMeshes[k], ch = p.cheeses[k], R = p.D / 2, geo = mesh.geometry, pos = geo.attributes.position.array, col = geo.attributes.color.array, base = mesh.userData.base;
        const clip = clipFor(ch.rot);
        const topY = p.h * (1 + 0.28 * p.dome) + k * 0.0015; mesh.position.y = topY + 0.0008;
        const floorLocal = -mesh.position.y + 0.0006 + k * 0.0004;
        const sk = ch.skirt; const sc = 1 + 0.15 * ch.melt + 0.004 * k;
        const onTop = mix3(yellow, melted, ch.melt);
        const skirtCol = skirtColour(sk, onTop);
        for (let i = 0; i < pos.length; i += 3) {
          const x = base[i], z = base[i + 2]; const rr = Math.hypot(x, z);
          const over = Math.max(0, rr - R * 0.98);
          let y = base[i + 1] - over * (0.2 + 1.6 * ch.melt);
          const touching = y <= floorLocal;
          let spread = sc;
          if (touching) { y = floorLocal; spread = sc + (sk ? 0.18 * sk.melt : 0) + 0.1 * ch.melt * over / Math.max(rr, 1e-4); }
          pos[i] = x * spread; pos[i + 2] = z * spread; pos[i + 1] = y;
          if (clip) { const q = clip(pos[i], pos[i + 2]); if (q) { pos[i] = q[0]; pos[i + 2] = q[1]; } }
          const cc = touching || ch.submerged || ch.fried ? skirtCol : onTop;
          col[i] = cc[0]; col[i + 1] = cc[1]; col[i + 2] = cc[2];
        }
        geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true; geo.computeVertexNormals();
        mesh.material.roughness = clamp(0.6 - 0.45 * ch.melt + (sk ? 0.35 * sk.dry : 0), 0.05, 1);
        mesh.material.clearcoat = 0.3 * (1 - (sk ? sk.dry : 0));
      }
    }
  }

  // ------------------------------------------------------------ the viewport
  class Viewport {
    constructor(canvas) {
      this.canvas = canvas;
      this.renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = T.PCFSoftShadowMap;
      this.renderer.outputEncoding = T.sRGBEncoding; this.renderer.toneMapping = T.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 0.95;
      this.scene = new T.Scene(); this.scene.background = new T.Color(0x1a1714);
      this.scene.fog = new T.Fog(0x1a1714, 1.2, 3.5);
      this.camera = new T.PerspectiveCamera(42, 1, 0.005, 20);
      this.clock = 0; this.texBudget = 0;
      this.mode = 'board'; // 'board' | 'stove'
      this.cutaway = false;
      this._buildLights(); this._buildKitchen(); this._buildStove(); this._buildBoard(); this._buildParticles(); this._buildProbe();
      this._buildTextures();
      this.views = new Map(); this.selected = null; this.previewPatty = null;
      this.controls = new Orbit(this);
      this.resize();
      window.addEventListener('resize', () => this.resize());
      this.setMode('board');
    }
    resize() {
      const w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 600;
      this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      const px = (h / 2) / Math.tan((this.camera.fov * Math.PI) / 360) * this.renderer.getPixelRatio();
      this.steam.setScale(px); this.smoke.setScale(px);
    }
    // ---- static scenery
    _buildLights() {
      this.scene.add(new T.HemisphereLight(0xfff2e0, 0x2a2018, 0.4));
      const key = new T.SpotLight(0xfff0d8, 1.1, 4, Math.PI / 5, 0.5, 1);
      key.position.set(0.3, 1.3, 0.5); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; key.shadow.radius = 4;
      key.target.position.set(0, 0, 0); this.scene.add(key); this.scene.add(key.target);
      const fill = new T.DirectionalLight(0xc9d8ff, 0.35); fill.position.set(-0.8, 0.6, -0.4); this.scene.add(fill);
      this.flameLight = new T.PointLight(0xff8a2a, 0, 0.6, 2); this.flameLight.position.set(0, 0.022, 0); this.scene.add(this.flameLight);
      this.key = key;
    }
    _buildKitchen() {
      const wall = new T.Mesh(new T.PlaneGeometry(4, 2), new T.MeshStandardMaterial({ color: 0x3b332c, roughness: 0.95 }));
      wall.position.set(0, 0.8, -0.7); this.scene.add(wall);
      // tile splash-back
      const tiles = new T.Mesh(new T.PlaneGeometry(4, 0.7), new T.MeshStandardMaterial({ color: 0x5d5148, roughness: 0.6, metalness: 0.05 }));
      tiles.position.set(0, 0.35, -0.69); this.scene.add(tiles);
    }
    _buildStove() {
      const g = new T.Group(); this.stove = g;
      const top = new T.Mesh(new T.BoxGeometry(1.2, 0.03, 0.7), new T.MeshStandardMaterial({ color: 0x15130f, roughness: 0.3, metalness: 0.7 }));
      top.position.y = -0.015; top.receiveShadow = true; g.add(top);
      this.burnerGroup = null; this.flames = []; this.setStove('gas');
      // pan
      this.panGroup = new T.Group(); g.add(this.panGroup);
      this.panMat = new T.MeshStandardMaterial({ color: 0x2b2725, roughness: 0.55, metalness: 0.7 });
      this.oilMat = new T.MeshPhysicalMaterial({ color: 0xb07a20, transparent: true, opacity: 0.3, roughness: 0.04, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.03, depthWrite: false });
      this.oil = new T.Mesh(new T.CircleGeometry(1, 64), this.oilMat); this.oil.rotation.x = -Math.PI / 2; this.oil.position.y = 0.0007; this.oil.receiveShadow = true; this.panGroup.add(this.oil);
      // residue on the pan floor: a canvas texture of fond blotches, burnt specks, welded cheese
      // and meat bits, and a carbon haze, painted from the pan state (positions come from a fixed
      // random sequence so dirt accumulates in place rather than jumping around)
      this.dirtCv = document.createElement('canvas'); this.dirtCv.width = this.dirtCv.height = 512;
      this.dirtTex = new T.CanvasTexture(this.dirtCv);
      this.fondMat = new T.MeshStandardMaterial({ map: this.dirtTex, transparent: true, opacity: 1, roughness: 0.85, depthWrite: false });
      this.fond = new T.Mesh(new T.CircleGeometry(1, 64), this.fondMat); this.fond.rotation.x = -Math.PI / 2; this.fond.position.y = 0.0004; this.panGroup.add(this.fond);
      let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      this.dirtSpots = []; for (let i = 0; i < 1400; i++) { const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()); this.dirtSpots.push({ x: 256 + 236 * rr * Math.cos(a), y: 256 + 236 * rr * Math.sin(a), s: 0.5 + rnd(), e: 0.6 + rnd() * 0.8, rot: rnd() * 3 }); }
      this.dirtSig = ''; this.dirtClock = 0;
      // fat that overflowed the pan, spreading on the stovetop
      this.spillMat = new T.MeshPhysicalMaterial({ color: 0x8a5a16, transparent: true, opacity: 0.7, roughness: 0.05, clearcoat: 1, depthWrite: false });
      this.spill = new T.Mesh(new T.CircleGeometry(1, 64), this.spillMat); this.spill.rotation.x = -Math.PI / 2; this.spill.visible = false; g.add(this.spill);
      // grease-fire flames around the pan rim (any stove type), shown only while pan.flare > 0
      this.flareFlames = [];
      const flareGeo = new T.ConeGeometry(0.012, 1, 6); flareGeo.translate(0, 0.5, 0);
      const flareMat = new T.MeshBasicMaterial({ color: 0xff8a20, transparent: true, opacity: 0.5, blending: T.AdditiveBlending, depthWrite: false });
      for (let i = 0; i < 30; i++) { const f = new T.Mesh(flareGeo, flareMat.clone()); f.userData.a = (i / 30) * Math.PI * 2 + (Math.random() - 0.5) * 0.1; f.visible = false; g.add(f); this.flareFlames.push(f); }
      const plate = new T.Mesh(new T.CylinderGeometry(0.11, 0.09, 0.008, 48), new T.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.35 }));
      plate.position.set(0.42, 0.004, 0.12); plate.receiveShadow = true; plate.castShadow = true; g.add(plate); this.plate = plate;
      this.stainGroup = new T.Group(); g.add(this.stainGroup); this.stains = [];
      this.stainMat = new T.MeshStandardMaterial({ color: 0x6b4a1e, transparent: true, opacity: 0.6, roughness: 0.3, depthWrite: false });
      this.stainGeo = new T.CircleGeometry(1, 10);
      this.setPan('castiron');
      this.scene.add(g);
    }
    /** Build the burner for a stove type. Each has its own pan height: a gas pan sits on a grate
     *  above the flames, an electric pan rests on the coil in its drip bowl, an induction pan sits
     *  flush on the glass. */
    setStove(id) {
      this.stoveType = id;
      if (this.burnerGroup) this.stove.remove(this.burnerGroup);
      const g = new T.Group(); this.burnerGroup = g; this.stove.add(g);
      this.flames = []; this.coilMat = null; this.indLed = null;
      if (id === 'electric') {
        // chrome drip bowl with a spiral sheathed element; the pan sits on top of the coil
        const chrome = new T.MeshStandardMaterial({ color: 0xb4b4b4, metalness: 0.9, roughness: 0.35, side: T.DoubleSide });
        const bowl = new T.Mesh(new T.CylinderGeometry(0.118, 0.075, 0.013, 56, 1, true), chrome); bowl.position.y = 0.0065; bowl.receiveShadow = true; g.add(bowl);
        const floor = new T.Mesh(new T.CircleGeometry(0.075, 56), chrome); floor.rotation.x = -Math.PI / 2; floor.position.y = 0.0006; floor.receiveShadow = true; g.add(floor);
        const coilY = 0.0125, coilR = 0.0045;
        class Spiral extends T.Curve { getPoint(t, target) { const a = t * 4.5 * Math.PI * 2; const r = 0.028 + 0.068 * t; return (target || new T.Vector3()).set(r * Math.cos(a), coilY, r * Math.sin(a)); } }
        this.coilMat = new T.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.55, metalness: 0.4, emissive: new T.Color(0xff3a00), emissiveIntensity: 0 });
        const coil = new T.Mesh(new T.TubeGeometry(new Spiral(), 360, coilR, 8, false), this.coilMat); coil.castShadow = true; g.add(coil);
        const term = new T.Mesh(new T.BoxGeometry(0.03, 0.009, 0.014), new T.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.7 })); term.position.set(0.108, coilY, 0.0); term.rotation.y = 0.1; g.add(term);
        this.PAN_Y = coilY + coilR + 0.0005;
        this.stainY = 0.0012;
      } else if (id === 'induction') {
        // glass-ceramic hob: dark glossy slab with a printed zone ring and a power indicator
        const glass = new T.Mesh(new T.BoxGeometry(0.56, 0.004, 0.5), new T.MeshPhysicalMaterial({ color: 0x0b0b0e, roughness: 0.06, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.03 }));
        glass.position.y = -0.0005; glass.receiveShadow = true; g.add(glass);
        const mark = new T.MeshBasicMaterial({ color: 0x7a7570 });
        const ring = new T.Mesh(new T.RingGeometry(0.107, 0.110, 96), mark); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.00155; g.add(ring);
        const inner = new T.Mesh(new T.RingGeometry(0.052, 0.054, 64), mark); inner.rotation.x = -Math.PI / 2; inner.position.y = 0.00155; g.add(inner);
        for (let i = 0; i < 4; i++) { const t = new T.Mesh(new T.PlaneGeometry(0.02, 0.003), mark); const a = (i * Math.PI) / 2; t.rotation.x = -Math.PI / 2; t.rotation.z = -a; t.position.set(Math.cos(a) * 0.125, 0.00155, Math.sin(a) * 0.125); g.add(t); }
        this.indLed = new T.MeshBasicMaterial({ color: 0x2a0000 });
        const led = new T.Mesh(new T.CircleGeometry(0.0035, 12), this.indLed); led.rotation.x = -Math.PI / 2; led.position.set(0.17, 0.00155, 0.2); g.add(led);
        this.PAN_Y = 0.0015 + 0.0005;
        this.stainY = 0.0022;
      } else if (id === 'charcoal') {
        // a 22" kettle on the counter: enamelled bowl on three legs, a bed of lump charcoal, a
        // steel grate 2 cm below the rim, and a domed lid with a wooden handle that sits on when
        // the lid is on. The grate is the cooking surface: PAN_Y is its top.
        const enamel = new T.MeshPhysicalMaterial({ color: 0x0c0c0e, roughness: 0.25, metalness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.15 });
        const inside = new T.MeshStandardMaterial({ color: 0x1a1816, roughness: 0.75, metalness: 0.1, side: T.BackSide });
        const steel = new T.MeshStandardMaterial({ color: 0x3a3a3c, roughness: 0.5, metalness: 0.8 });
        const Rk = 0.285, bowlBottom = 0.06, bowlTop = 0.235;
        this.PAN_Y = bowlTop - 0.022; this.stainY = 0.0012;
        const bp = []; const nb = 16;
        for (let i = 0; i <= nb; i++) { const t = i / nb; const a = -Math.PI / 2 + (Math.PI / 2) * t; bp.push({ r: Math.max(0.0001, Rk * Math.cos(a) * (0.3 + 0.7 * t) + 0), y: bowlBottom + (bowlTop - bowlBottom) * (1 + Math.sin(a)), v: t }); }
        bp[0].r = 0.0001;
        const bowl = new T.Mesh(buildLathe(bp, 72, Math.PI * 2), enamel); bowl.castShadow = true; bowl.receiveShadow = true; g.add(bowl);
        const bowlIn = new T.Mesh(bowl.geometry, inside); bowlIn.receiveShadow = true; g.add(bowlIn);
        const rim = new T.Mesh(new T.TorusGeometry(Rk, 0.006, 8, 96), steel); rim.rotation.x = Math.PI / 2; rim.position.y = bowlTop; g.add(rim);
        for (let i = 0; i < 3; i++) { const a = Math.PI / 2 + (i * 2 * Math.PI) / 3; const leg = new T.Mesh(new T.CylinderGeometry(0.008, 0.008, bowlBottom + 0.09, 10), steel); leg.position.set(Math.cos(a) * 0.19, (bowlBottom + 0.09) / 2 - 0.0, Math.sin(a) * 0.19); leg.rotation.z = -Math.cos(a) * 0.35; leg.rotation.x = Math.sin(a) * 0.35; leg.castShadow = true; g.add(leg); }
        // ash pan and the coal bed: lumps of charcoal, glowing from inside as the bed heats
        const bedY = bowlBottom + 0.075;
        const ash = new T.Mesh(new T.CircleGeometry(0.2, 48), new T.MeshStandardMaterial({ color: 0x4d4944, roughness: 1 })); ash.rotation.x = -Math.PI / 2; ash.position.y = bedY - 0.012; g.add(ash);
        this.coalMat = new T.MeshStandardMaterial({ color: 0x0f0e0d, roughness: 0.95, emissive: new T.Color(0xff3a08), emissiveIntensity: 0 });
        const lumpGeo = new T.DodecahedronGeometry(0.019, 0);
        const lumps = new T.InstancedMesh(lumpGeo, this.coalMat, 160); lumps.castShadow = true; lumps.receiveShadow = true;
        let sd = 99; const rnd = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; };
        const dm = new T.Object3D();
        const lc = new T.Color();
        for (let i = 0; i < 160; i++) { const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 0.185; const sc = 0.6 + rnd() * 0.9; dm.position.set(Math.cos(a) * rr, bedY + (rnd() - 0.5) * 0.02 + 0.004 * sc, Math.sin(a) * rr); dm.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3); dm.scale.set(sc, sc * (0.6 + rnd() * 0.6), sc); dm.updateMatrix(); lumps.setMatrixAt(i, dm.matrix); const k = 0.35 + rnd() * 0.9; lumps.setColorAt(i, lc.setRGB(k, k * (0.85 + 0.15 * rnd()), k * 0.8)); }
        lumps.instanceColor.needsUpdate = true;
        g.add(lumps); this.coals = lumps; this.coalY = bedY;
        // the grate: a ring with rods across it
        const Rg = Rk * 0.93, rodR = 0.003, gy = this.PAN_Y - rodR;
        const ringG = new T.Mesh(new T.TorusGeometry(Rg, rodR * 1.2, 8, 96), steel); ringG.rotation.x = Math.PI / 2; ringG.position.y = gy; ringG.castShadow = true; g.add(ringG);
        for (let x = -Rg + 0.012; x < Rg; x += 0.024) { const L = 2 * Math.sqrt(Math.max(0, Rg * Rg - x * x)); if (L < 0.02) continue; const rod = new T.Mesh(new T.CylinderGeometry(rodR, rodR, L, 8), steel); rod.rotation.x = Math.PI / 2; rod.position.set(x, gy, 0); rod.castShadow = true; g.add(rod); }
        for (const z of [-0.14, 0.14]) { const brace = new T.Mesh(new T.CylinderGeometry(rodR, rodR, 2 * Math.sqrt(Rg * Rg - z * z), 8), steel); brace.rotation.z = Math.PI / 2; brace.position.set(0, gy - rodR, z); g.add(brace); }
        // the lid: a dome that sits on the rim, with a vent and a wooden handle
        const lid = new T.Group(); lid.position.y = bowlTop; lid.visible = false;
        const lp = []; const nl = 14; const lidH = 0.13;
        for (let i = 0; i <= nl; i++) { const t = i / nl; const a = (Math.PI / 2) * t; lp.push({ r: Math.max(0.0001, Rk * Math.cos(a)), y: lidH * Math.sin(a) * (0.6 + 0.4 * (1 - t)) + 0.003, v: t }); }
        lp[nl].r = 0.0001;
        const dome = new T.Mesh(buildLathe(lp, 72, Math.PI * 2), enamel); dome.castShadow = true; lid.add(dome);
        const lrim = new T.Mesh(new T.TorusGeometry(Rk, 0.005, 8, 96), steel); lrim.rotation.x = Math.PI / 2; lrim.position.y = 0.004; lid.add(lrim);
        const wood = new T.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.7 });
        const handle = new T.Mesh(new T.CylinderGeometry(0.012, 0.012, 0.11, 12), wood); handle.rotation.z = Math.PI / 2; handle.position.y = lidH + 0.035; lid.add(handle);
        for (const x of [-0.045, 0.045]) { const post = new T.Mesh(new T.CylinderGeometry(0.004, 0.004, 0.03, 8), steel); post.position.set(x, lidH + 0.018, 0); lid.add(post); }
        const vent = new T.Mesh(new T.CylinderGeometry(0.03, 0.03, 0.004, 24), steel); vent.position.set(0.12, lidH * 0.55, 0.05); vent.rotation.z = 0.5; lid.add(vent);
        g.add(lid); this.kettleLid = lid;
        this.flameBaseY = bedY + 0.01; this.flameMaxLen = this.PAN_Y - this.flameBaseY + 0.05;
      } else {
        // gas: cast-iron pan support (square frame, radial fingers, feet) holding the pan ~3.5 cm
        // above the stovetop, with the burner flames underneath in the gap.
        this.PAN_Y = 0.036;
        this.stainY = 0.0012;
        const grateTop = this.PAN_Y - 0.0005, barH = 0.010, barY = grateTop - barH / 2;
        const grateMat = new T.MeshStandardMaterial({ color: 0x141312, roughness: 0.9, metalness: 0.3 });
        const addBox = (w, h, d, x, y, z, ry) => { const m = new T.Mesh(new T.BoxGeometry(w, h, d), grateMat); m.position.set(x, y, z); m.rotation.y = ry || 0; m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
        const half = 0.175;
        addBox(2 * half + 0.012, barH, 0.012, 0, barY, half); addBox(2 * half + 0.012, barH, 0.012, 0, barY, -half);
        addBox(0.012, barH, 2 * half + 0.012, half, barY, 0); addBox(0.012, barH, 2 * half + 0.012, -half, barY, 0);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) addBox(0.014, grateTop, 0.014, sx * half, grateTop / 2, sz * half);
        for (let i = 0; i < 4; i++) {
          const a = Math.PI / 4 + (i * Math.PI) / 2; const r0 = 0.06, r1 = half * Math.SQRT2 - 0.004; const L = r1 - r0;
          addBox(L, barH, 0.012, Math.cos(a) * (r0 + L / 2), barY, Math.sin(a) * (r0 + L / 2), -a);
        }
        const ring = new T.Mesh(new T.TorusGeometry(0.06, 0.006, 8, 40), grateMat); ring.rotation.x = Math.PI / 2; ring.position.y = barY; ring.castShadow = true; g.add(ring);
        const base = new T.Mesh(new T.CylinderGeometry(0.052, 0.056, 0.008, 40), new T.MeshStandardMaterial({ color: 0x2a2724, roughness: 0.6, metalness: 0.5 })); base.position.y = 0.004; g.add(base);
        const cap = new T.Mesh(new T.CylinderGeometry(0.038, 0.048, 0.006, 40), new T.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.7 })); cap.position.y = 0.011; cap.castShadow = true; g.add(cap);
        this.flameBaseY = 0.009; this.flameMaxLen = this.PAN_Y - this.flameBaseY - 0.003;
        const fm = new T.MeshBasicMaterial({ color: 0x3f7cff, transparent: true, opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false });
        const coneGeo = new T.ConeGeometry(0.0055, 1, 6); coneGeo.translate(0, 0.5, 0); // unit-length cone, base at the origin
        for (let i = 0; i < 28; i++) {
          const f = new T.Mesh(coneGeo, fm.clone());
          const a = (i / 28) * Math.PI * 2; f.position.set(Math.cos(a) * 0.047, this.flameBaseY, Math.sin(a) * 0.047);
          f.rotation.order = 'YXZ'; f.rotation.y = -a; f.rotation.z = -0.55; // lean outward from the port
          g.add(f); this.flames.push(f);
        }
      }
      this.flameLight.position.y = id === 'charcoal' ? this.coalY + 0.03 : this.PAN_Y - 0.01;
      if (id !== 'charcoal') { this.coals = null; this.coalMat = null; this.kettleLid = null; }
      if (this.panSpec) this.setPan(this.panSpec.id);
      if (this.panGroup) this.panGroup.visible = id !== 'charcoal';
      if (id === 'charcoal') { this.panFloorY = this.PAN_Y; this.panR = 0.26; }
      if (this.controls && this.mode === 'stove') this.controls.reset('stove'); // the grate sits far higher than a pan
    }
    setPan(id) {
      const pan = P.PANS[id] || P.PANS.castiron; this.panSpec = pan;
      if (this.stoveType === 'charcoal') { this.panGroup.visible = false; this.panFloorY = this.PAN_Y; this.panR = 0.26; return; }
      this.panGroup.visible = true;
      if (this.panMesh) this.panGroup.remove(this.panMesh);
      const R = pan.diam / 2, wall = 0.045;
      const prof = [{ r: 0, y: 0, v: 0, hard: false }, { r: R * 0.97, y: 0, v: 0.3, hard: true }, { r: R * 1.02, y: wall * 0.5, v: 0.6, hard: false }, { r: R * 1.06, y: wall, v: 0.8, hard: true }, { r: R * 1.06, y: wall - 0.004, v: 0.85, hard: true }, { r: R * 1.0, y: wall - 0.004, v: 0.9, hard: true }, { r: R * 0.95, y: 0.004, v: 0.95, hard: true }, { r: 0, y: 0.004, v: 1, hard: false }];
      const geo = buildLathe(prof, 96, Math.PI * 2);
      const look = { castiron: [0x17140f, 0.55, 0.5], carbonsteel: [0x23201d, 0.4, 0.8], stainless: [0x9ea2a6, 0.25, 0.95], nonstick: [0x141416, 0.35, 0.3] }[id] || [0x17140f, 0.55, 0.5];
      this.panMat.color.setHex(look[0]); this.panMat.roughness = look[1]; this.panMat.metalness = look[2];
      const m = new T.Mesh(geo, this.panMat); m.castShadow = true; m.receiveShadow = true; m.position.y = this.PAN_Y;
      // handle: rooted in the wall just under the rim, rising outward; a boss covers the joint
      const rimR = R * 1.06, hy = wall - 0.009, tilt = 0.14, len = 0.23;
      const handle = new T.Mesh(new T.BoxGeometry(len, 0.012, 0.028), this.panMat);
      handle.position.set(-(rimR - 0.012) - (len / 2) * Math.cos(tilt), hy + (len / 2) * Math.sin(tilt), 0); handle.rotation.z = -tilt; handle.castShadow = true; m.add(handle);
      const boss = new T.Mesh(new T.BoxGeometry(0.03, 0.022, 0.04), this.panMat); boss.position.set(-rimR + 0.004, hy - 0.002, 0); boss.castShadow = true; m.add(boss);
      if (id === 'nonstick' || id === 'stainless') {
        const grip = new T.Mesh(new T.BoxGeometry(0.15, 0.02, 0.034), new T.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 }));
        const d = 0.04 + 0.075; grip.position.set(-(rimR - 0.012) - d * Math.cos(tilt), hy + d * Math.sin(tilt), 0); grip.rotation.z = -tilt; grip.castShadow = true; m.add(grip);
      }
      // helper handle opposite: a loop cast into the rim
      class Loop extends T.Curve { getPoint(t, target) { const a = -Math.PI / 2 + t * Math.PI; return (target || new T.Vector3()).set(rimR - 0.004 + 0.028 * Math.cos(a), hy, 0.03 * Math.sin(a)); } }
      const loop = new T.Mesh(new T.TubeGeometry(new Loop(), 24, 0.006, 8, false), this.panMat); loop.castShadow = true; m.add(loop);
      // lid: glass dome with a steel rim and knob, shown when the lid is on; fogs with steam
      if (this.lid) this.panGroup.remove(this.lid);
      const lid = new T.Group(); this.lid = lid; lid.position.y = this.PAN_Y + wall; lid.visible = false;
      this.lidGlass = new T.MeshPhysicalMaterial({ color: 0xd6e4ec, transparent: true, opacity: 0.2, roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, side: T.DoubleSide, depthWrite: false });
      const domeH = 0.075, nd = 14, lp = [];
      for (let i = 0; i <= nd; i++) { const t = i / nd; const a = (Math.PI / 2) * t; lp.push({ r: rimR * Math.cos(a) * (1 - 0.15 * t) + 0 * t, y: 0.004 + domeH * Math.sin(a), v: t }); }
      lp[nd].r = 0.0001;
      const dome = new T.Mesh(buildLathe(lp, 72, Math.PI * 2), this.lidGlass); lid.add(dome);
      const steel = new T.MeshStandardMaterial({ color: 0xc9ccd0, metalness: 0.9, roughness: 0.3 });
      const rim = new T.Mesh(new T.TorusGeometry(rimR, 0.004, 8, 72), steel); rim.rotation.x = Math.PI / 2; rim.position.y = 0.003; lid.add(rim);
      const knob = new T.Mesh(new T.CylinderGeometry(0.014, 0.01, 0.018, 24), new T.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 })); knob.position.y = 0.004 + domeH + 0.009; lid.add(knob);
      const stem = new T.Mesh(new T.CylinderGeometry(0.004, 0.004, 0.012, 12), steel); stem.position.y = 0.004 + domeH + 0.002; lid.add(stem);
      this.panGroup.add(lid); this.lidFog = 0;
      this.panMesh = m; this.panGroup.add(m);
      this.panFloorY = this.PAN_Y + 0.004; this.panR = R * 0.95;
      this.oil.position.y = this.panFloorY + 0.0007; this.fond.position.y = this.panFloorY + 0.0004;
    }
    _buildBoard() {
      const g = new T.Group(); this.board = g;
      const wood = new T.Mesh(new T.BoxGeometry(0.42, 0.025, 0.30), new T.MeshStandardMaterial({ color: 0xb8865a, roughness: 0.8 }));
      wood.position.y = -0.0125; wood.receiveShadow = true; wood.castShadow = true; g.add(wood);
      const counter = new T.Mesh(new T.BoxGeometry(1.2, 0.03, 0.7), new T.MeshStandardMaterial({ color: 0x4a4744, roughness: 0.5, metalness: 0.05 }));
      counter.position.y = -0.04; counter.receiveShadow = true; g.add(counter);
      // a ruler for scale
      const ruler = new T.Mesh(new T.BoxGeometry(0.15, 0.002, 0.02), new T.MeshStandardMaterial({ color: 0xe8e0c8, roughness: 0.6 })); ruler.position.set(0.09, 0.001, 0.1); ruler.rotation.y = Math.PI; g.add(ruler);
      const cv = document.createElement('canvas'); cv.width = 300; cv.height = 40; const c = cv.getContext('2d'); c.fillStyle = '#e8e0c8'; c.fillRect(0, 0, 300, 40); c.fillStyle = '#333'; c.font = '14px sans-serif';
      for (let i = 0; i <= 15; i++) { c.fillRect(i * 20, 0, 1, i % 5 === 0 ? 18 : 10); if (i % 5 === 0) c.fillText(i + 'cm', i * 20 + 2, 34); }
      ruler.material.map = new T.CanvasTexture(cv); ruler.material.needsUpdate = true;
      g.visible = false; this.scene.add(g);
    }
    _buildProbe() {
      const g = new T.Group(); this.probeGroup = g;
      const steel = new T.MeshStandardMaterial({ color: 0xcfd2d6, metalness: 0.9, roughness: 0.3 });
      const rod = new T.Mesh(new T.CylinderGeometry(0.0012, 0.0006, 0.10, 8), steel); rod.rotation.z = Math.PI / 2; rod.position.x = 0.05; g.add(rod);
      const body = new T.Mesh(new T.BoxGeometry(0.035, 0.016, 0.022), new T.MeshStandardMaterial({ color: 0xd8382e, roughness: 0.5 })); body.position.x = 0.117; g.add(body);
      const screen = new T.Mesh(new T.PlaneGeometry(0.02, 0.009), new T.MeshBasicMaterial({ color: 0xb9c7a8 })); screen.position.set(0.117, 0.0081, 0); screen.rotation.x = -Math.PI / 2; g.add(screen);
      g.visible = false; this.scene.add(g);
    }
    setProbe(inserted, depthFrac) {
      const g = this.probeGroup; const p = this.selected, pg = this.pattyGroup;
      if (!inserted || !p || !pg) { g.visible = false; return; }
      g.visible = true;
      const R = p.D / 2, y = pg.position.y + p.h * (1 - depthFrac);
      const az = -0.6; // comes in from the front-right, tip reaches the centre
      g.position.set(pg.position.x, y, pg.position.z);
      g.rotation.set(0, -az, 0.12);
      g.position.x += Math.cos(az) * 0; g.position.y += 0.006;
    }
    _buildParticles() {
      this.steam = new Puffs(this.scene, { max: 400, color: 0xf2f2f2, size: 0.03, grow: 3, rise: 0.12, spread: 0.02, turb: 0.15, accel: 0.02, life: 1.6, alpha: 0.22, additive: false });
      this.smoke = new Puffs(this.scene, { max: 400, color: 0x5a5a62, size: 0.07, grow: 5, rise: 0.11, spread: 0.03, turb: 0.12, accel: 0.01, life: 5, alpha: 0.3, additive: false });
      this.spatter = new Droplets(this.scene, 300, 0.0012, { color: 0xe0a44a, roughness: 0.1, clearcoat: 1, transparent: true, opacity: 0.9 });
      this.bubbles = new Droplets(this.scene, 300, 0.0009, { color: 0xfff4dc, roughness: 0.02, transparent: true, opacity: 0.35, clearcoat: 1, depthWrite: false });
      this.beads = new Droplets(this.scene, 200, 0.0017, { color: 0xc8626a, roughness: 0.05, clearcoat: 1, transparent: true, opacity: 0.85 });
      this.drips = new Droplets(this.scene, 120, 0.0013, { color: 0xf0c060, roughness: 0.05, clearcoat: 1, transparent: true, opacity: 0.9 });
    }
    /**
     * A blob mask filled with one flat colour at one size, built once and kept. The masks never
     * change and the colours are constants, so every repaint after the first is a plain blit.
     */
    tinted(mask, colour, w, h) {
      const cache = this._tinted || (this._tinted = new Map());
      const key = `${mask.__id || (mask.__id = ++tintedId)}|${colour[0]},${colour[1]},${colour[2]}|${w}x${h}`;
      let cv = cache.get(key);
      if (!cv) {
        cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const cx = cv.getContext('2d');
        cx.drawImage(mask, 0, 0, w, h);
        cx.globalCompositeOperation = 'source-in'; cx.fillStyle = rgb(colour); cx.fillRect(0, 0, w, h);
        cache.set(key, cv);
      }
      return cv;
    }
    _buildTextures() {
      this.noise = makeNoise(512, 5, true);
      this.noiseFine = makeNoise(512, 6, false);
      this.marble = makeBlobs(1024, 3200, 1.2, 5.5, 'rgba(255,255,255,1)');
      this.marbleCut = makeBlobs(512, 900, 1, 4, 'rgba(255,255,255,1)');
      this.spots = makeBlobs(1024, 1400, 2, 9, 'rgba(0,0,0,1)'); this.blotch = makeBlobs(1024, 40, 14, 50, 'rgba(0,0,0,1)');
    }

    // ---- patty mesh management
    /** Board preview: show this one patty (or nothing). */
    setPatty(p) { this.previewPatty = p || null; this.forceTex = true; }
    /** Keep one PattyView per patty in `list`. */
    syncViews(list) {
      const keep = new Set(list);
      for (const [p, v] of this.views) if (!keep.has(p)) { v.dispose(); this.views.delete(p); }
      for (const p of list) if (!this.views.has(p)) this.views.set(p, new PattyView(this, p));
    }
    viewOf(p) { return p ? this.views.get(p) : null; }
    get pattyGroup() { const v = this.viewOf(this.selected); return v ? v.group : null; }
    get patty() { return this.selected; }
    /** Slice the selected patty along the plane facing the camera; nothing moves, only the cut. */
    setCutaway(on) {
      this.cutaway = on;
      const phi = this.controls.goal.azimuth + Math.PI / 2;
      for (const [p, v] of this.views) { const want = on && p === this.selected; if (v.cutaway !== want || (want && on)) v.setCutaway(want, phi); }
    }
    pickPatty(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      const ndc = new T.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new T.Raycaster(); ray.setFromCamera(ndc, this.camera);
      const targets = []; for (const v of this.views.values()) { targets.push(v.mesh); if (v.cutMesh.visible) targets.push(v.cutMesh); }
      const hits = ray.intersectObjects(targets, false);
      return hits.length ? hits[0].object.userData.patty : null;
    }
    // ---- per-frame update from the physics state
    setMode(mode) {
      this.mode = mode;
      this.stove.visible = mode === 'stove'; this.board.visible = mode === 'board';
      this.scene.background.setHex(mode === 'stove' ? 0x1a1714 : 0x2a2622); this.scene.fog.color.copy(this.scene.background);
      this.controls.reset(mode);
    }
    /**
     * One patty's atlas may be repainted per frame. Three burgers on a ticket would otherwise all
     * come due on the same frame and paint three megapixel canvases back to back; staggered, each
     * still gets its ten repaints a second and no single frame carries more than one.
     */
    claimTexBudget() { if (this.texBudget <= 0) return false; this.texBudget--; return true; }
    update(state, dt) {
      this.clock += dt; this.texBudget = 1;
      const pan = state.pan, p = state.patty;
      // stove: gas flames, electric coil glow (follows delivered power, so it lags), induction LED
      const knob = state.stove.knob / 10, stv = state.stove;
      if (this.stoveType === 'gas') {
        for (let i = 0; i < this.flames.length; i++) {
          const f = this.flames[i]; const fl = 0.6 + 0.4 * Math.sin(this.clock * 37 + i * 1.7) * Math.random();
          // flame length grows with the knob but is capped so the tips never reach the pan underside
          const len = this.flameMaxLen * clamp((0.25 + 0.75 * knob) * (0.85 + 0.15 * fl), 0, 1);
          f.visible = knob > 0.02; f.scale.set(0.7 + 0.6 * knob, len, 0.7 + 0.6 * knob);
          f.rotation.z = -0.35 - 0.35 * knob; // higher gas: flames fan further outward
          f.material.color.setRGB(0.25 + knob * 0.3, 0.45, 1.0);
          f.material.opacity = 0.5 + 0.4 * knob;
        }
        this.flameLight.color.setHex(0xff8a2a);
        this.flameLight.intensity = knob * 0.8 * (0.85 + 0.15 * Math.sin(this.clock * 23));
      } else if (this.stoveType === 'charcoal' && this.coalMat) {
        const gr = state.grill || { Tfire: 20, ash: 0, flare: 0 };
        const glow = clamp((gr.Tfire - 350) / 400, 0, 1), ashF = clamp(gr.ash / 0.3, 0, 1);
        const flick = 0.85 + 0.15 * Math.sin(this.clock * 9.1) * Math.sin(this.clock * 4.3 + 1);
        this.coalMat.emissiveIntensity = 0.42 * glow * glow * flick;
        this.coalMat.emissive.setRGB(1, 0.14 + 0.12 * glow, 0.02);
        this.coalMat.color.setRGB(0.12 + 0.35 * ashF, 0.11 + 0.33 * ashF, 0.1 + 0.32 * ashF);
        this.flameLight.color.setHex(0xff6a1a);
        this.flameLight.intensity = 1.4 * glow * flick + 2.5 * clamp(gr.flare, 0, 1.5);
        if (this.kettleLid) this.kettleLid.visible = !!state.lid;
      } else if (this.stoveType === 'electric' && this.coilMat) {
        const glow = clamp((stv.pDelivered || 0) / (stv.pMax * stv.eff), 0, 1);
        this.coilMat.emissiveIntensity = 2.4 * glow * glow;
        this.coilMat.color.setRGB(0.11 + 0.25 * glow, 0.11, 0.11);
        this.flameLight.color.setHex(0xff4a14);
        this.flameLight.intensity = 1.1 * glow * glow;
      } else {
        if (this.indLed) this.indLed.color.setHex(knob > 0.02 ? 0xff2a1a : 0x2a0000);
        this.flameLight.intensity = 0;
      }
      // pan colour with temperature (very hot steel dulls / blues slightly, cast iron just dries)
      const hot = clamp((pan.T - 150) / 250, 0, 1);
      this.panMat.emissive = this.panMat.emissive || new T.Color(0); this.panMat.emissive.setRGB(0.06 * hot * hot, 0.01 * hot, 0);
      // oil: a spreading film until the floor is covered, then a level that rises up the wall
      const oilV = pan.oil / 920, depth = pan.oilDepth || 0;
      let r, oilY;
      if (depth < 0.0008) { r = Math.min(this.panR * 0.98, Math.sqrt(oilV / (Math.PI * 0.0006))); oilY = this.panFloorY + 0.0007; }
      else { r = this.panR * 0.99; oilY = this.panFloorY + depth; }
      this.oil.visible = r > 0.004 && this.stoveType !== 'charcoal'; this.oil.scale.set(r, r, 1); this.oil.position.y = oilY;
      const deep = clamp(depth / 0.02, 0, 1);
      this.oilMat.opacity = 0.2 + 0.2 * clamp(pan.oil / 0.01, 0, 1) + 0.3 * deep;
      // lid: on/off, and a light fogging that follows the steam trapped under it
      if (this.lid) {
        this.lid.visible = !!state.lid && this.stoveType !== 'charcoal';
        const target = state.lid ? clamp(0.35 * clamp((state.lidAirT - 50) / 50, 0, 1) + (state.diag.steam || 0) * 250, 0, 0.55) : 0;
        this.lidFog += (target - this.lidFog) * Math.min(1, dt / (target > this.lidFog ? 3 : 6));
        this.lidGlass.opacity = 0.2 + 0.4 * this.lidFog; this.lidGlass.roughness = 0.04 + 0.5 * this.lidFog;
        this.lidGlass.color.setRGB(0.84 + 0.1 * this.lidFog, 0.89 + 0.06 * this.lidFog, 0.93 + 0.02 * this.lidFog);
      }
      // spilled fat on the stovetop
      const spillR = Math.min(0.45, Math.sqrt((pan.overflow || 0) / 920 / (Math.PI * 0.0015)));
      this.spill.visible = spillR > 0.01; this.spill.scale.set(spillR * 1.15, spillR, 1); this.spill.position.y = (this.stainY || 0.0012) + 0.0003;
      // grease fire around a pan, or flare-ups coming up through the grate under the meat
      const grillFlare = this.stoveType === 'charcoal' && state.grill ? state.grill.flare : 0;
      const flare = this.stoveType === 'charcoal' ? (grillFlare > 0.04 ? grillFlare : 0) : (pan.flare || 0);
      const onGrate = this.stoveType === 'charcoal' ? (state.patties || []).filter((q) => q.where === 'pan') : [];
      for (let i = 0; i < this.flareFlames.length; i++) {
        const f = this.flareFlames[i];
        f.visible = flare > 0;
        if (flare <= 0) continue;
        const fl = 0.5 + 0.5 * Math.random();
        if (this.stoveType === 'charcoal') {
          // tongues of flame under and around whichever patties are dripping, licking up their sides
          const q = onGrate.length ? onGrate[i % onGrate.length] : null;
          const rr = q ? (q.D / 2) * (0.5 + 0.7 * ((i * 7919) % 100) / 100) : 0.12 * fl;
          const cx = q ? q.pos.x : 0, cz = q ? q.pos.y : 0;
          f.position.set(cx + Math.cos(f.userData.a) * rr, this.PAN_Y - 0.03, cz + Math.sin(f.userData.a) * rr);
          f.rotation.order = 'YXZ'; f.rotation.y = -f.userData.a; f.rotation.z = -0.12 * fl;
          const len = 0.02 + 0.15 * Math.min(1, flare) * fl;
          f.scale.set(0.5 + 0.7 * fl, len, 0.5 + 0.7 * fl);
          f.material.color.setRGB(1, 0.45 + 0.3 * Math.random(), 0.08);
          f.material.opacity = 0.18 + 0.3 * fl * Math.min(1, flare + 0.3);
        } else {
          const rr = this.panR * 1.08;
          f.position.set(Math.cos(f.userData.a) * rr, this.PAN_Y - 0.004, Math.sin(f.userData.a) * rr);
          f.rotation.order = 'YXZ'; f.rotation.y = -f.userData.a; f.rotation.z = -0.25;
          f.scale.set(0.5 + 0.6 * fl, 0.03 + 0.07 * fl * Math.min(1, flare / 2), 0.5 + 0.6 * fl);
          f.material.color.setRGB(1, 0.35 + 0.25 * Math.random(), 0.05);
          f.material.opacity = 0.35 + 0.25 * fl;
        }
      }
      if (flare > 0 && this.stoveType !== 'charcoal') { this.flameLight.color.setHex(0xff7a10); this.flameLight.intensity = 3 * (0.7 + 0.3 * Math.random()); }
      const fondT = clamp((pan.fond + pan.fondBurnt + (pan.carbon || 0)) / 0.003, 0, 1);
      this.oilMat.color.setRGB(lerp(0.85, 0.6, Math.max(deep, fondT * 0.5)), lerp(0.63, 0.34, Math.max(deep, fondT)), lerp(0.22, 0.07, deep));
      this._paintDirt(pan, dt);

      // ---- patties: one view each; the selected one gets the probe and the cutaway
      const list = state.patties && state.patties.length ? state.patties : (this.previewPatty ? [this.previewPatty] : []);
      this.syncViews(list);
      const sel = state.patties && state.patties.length ? state.patty : this.previewPatty;
      if (sel !== this.selected) { this.selected = sel; if (this.cutaway) this.setCutaway(true); }
      const stoveOn = this.mode === 'stove';
      const plateBase = stoveOn ? { x: 0.42, y: 0.009, z: 0.12 } : { x: 0, y: 0, z: 0 };
      const offPan = list.filter((q) => q.where !== 'pan' && q.where !== 'board');
      if (this.plate) { this.plate.scale.set(1 + 0.55 * Math.max(0, offPan.length - 1), 1, 1); }
      for (const q of list) {
        const v = this.views.get(q);
        const where = state.patties && state.patties.length ? q.where : 'board';
        let pos;
        if (where === 'pan') pos = { x: q.pos.x, y: 0, z: q.pos.y };
        else if (where === 'board') pos = { x: 0, y: 0, z: 0 };
        else { const i = offPan.indexOf(q); pos = { x: plateBase.x + (i - (offPan.length - 1) / 2) * 0.115, y: plateBase.y, z: plateBase.z }; }
        if (this.forceTex) v.forceTex = true;
        v.update(state, dt, where, pos, this.mode);
      }
      this.forceTex = false;

      this._updateParticles(state, dt, list, stoveOn);

      this.controls.update(dt);
      this.renderer.render(this.scene, this.camera);
    }
    /** Sizzle, steam, smoke, spatter, juice beads and fat drips around every patty on the pan. */
    _updateParticles(state, dt, list, stoveOn) {
      const d = state.diag;
      const onPan = list.filter((q) => q.where === 'pan');
      const gy = this.panFloorY, oilDepth = this.stoveType === 'charcoal' ? 0 : (state.pan.oilDepth || 0);
      const surfY = gy + Math.max(0.002, oilDepth);
      const pick = () => onPan[Math.floor(Math.random() * onPan.length)];
      const edge = () => { const q = pick(); const a = Math.random() * Math.PI * 2; const rr = (q.D / 2) * rand(0.9, 1.15); return [q.pos.x + Math.cos(a) * rr, surfY, q.pos.y + Math.sin(a) * rr]; };
      const anywhereTop = () => { const q = pick(); const a = Math.random() * Math.PI * 2; const rr = Math.sqrt(Math.random()) * (q.D / 2) * 0.9; return [q.pos.x + Math.cos(a) * rr, Math.max(surfY, gy + q.h + 0.003), q.pos.y + Math.sin(a) * rr]; };
      const panSpot = () => { const a = Math.random() * Math.PI * 2; const rr = Math.sqrt(Math.random()) * this.panR * 0.8; return [Math.cos(a) * rr, surfY, Math.sin(a) * rr]; };
      const any = onPan.length > 0;
      let evapTopAll = 0; for (const q of onPan) evapTopAll += q.evapTop || 0;
      const steamRate = stoveOn ? (any ? d.evapBottom * 6000 + evapTopAll * 3000 : 0) + d.evapPan * 5000 : 0;
      this.steam.update(dt, Math.min(steamRate, 160), () => (Math.random() < 0.7 && any ? edge() : any && Math.random() < 0.5 ? anywhereTop() : panSpot()), 0.01);
      this.smoke.update(dt, stoveOn ? clamp(d.smoke, 0, 2) * 45 : 0, () => (Math.random() < 0.6 && any ? edge() : panSpot()), 0.02);
      const bubbleRate = stoveOn ? (any ? d.evapBottom * 9000 : 0) + d.evapPan * 6000 + d.oilBubble * 40 : 0;
      this.bubbles.acc += Math.min(bubbleRate, 250) * dt;
      while (this.bubbles.acc >= 1) { this.bubbles.acc -= 1; const e = any && Math.random() < 0.8 ? edge() : panSpot(); this.bubbles.spawn({ x: e[0], y: e[1], z: e[2], age: 0, life: rand(0.08, 0.3), s: rand(0.4, 1.0) }); }
      this.bubbles.update(dt, (b, dt) => { b.age += dt; b.s *= 1 + dt * 2; return b.age < b.life; });
      this.spatter.acc += (stoveOn ? clamp(d.spatter, 0, 40) : 0) * dt;
      while (this.spatter.acc >= 1) { this.spatter.acc -= 1; const e = any && Math.random() < 0.85 ? edge() : panSpot(); const a = Math.random() * Math.PI * 2, v = rand(0.25, 0.9); this.spatter.spawn({ x: e[0], y: e[1], z: e[2], vx: Math.cos(a) * v * 0.6, vy: v, vz: Math.sin(a) * v * 0.6, age: 0, s: rand(0.5, 1.3) }); }
      this.spatter.update(dt, (b, dt) => {
        b.vy -= 9.81 * dt; b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
        const rr = Math.hypot(b.x, b.z);
        if (b.y < gy + 0.001 && rr < this.panR) { b.y = gy + 0.001; b.vy = 0; b.vx *= 0.5; b.vz *= 0.5; b.age += dt; return b.age < 0.6; }
        if (b.y < (this.stainY || 0.0012) + 0.0005 && rr > this.panR) { this._addStain(b.x, b.z, b.s); return false; }
        if (b.y < -0.05) return false; return true;
      });
      // juice beads on every top surface that is not under oil
      {
        const parts = this.beads.parts;
        for (const q of onPan) {
          if (oilDepth > q.h) { for (let i = parts.length - 1; i >= 0; i--) if (parts[i].q === q) parts.splice(i, 1); continue; }
          const want = clamp(Math.round(q.poolTop / 0.00001), 0, 120); let have = 0; for (const b of parts) if (b.q === q) have++;
          while (have < want) { const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * (q.D / 2) * 0.9; parts.push({ q, x: q.pos.x + Math.cos(a) * rr, y: 0, z: q.pos.y + Math.sin(a) * rr, s: rand(0.5, 1.5), sy: 0.6 }); have++; }
          for (let i = parts.length - 1; i >= 0 && have > want; i--) if (parts[i].q === q) { parts.splice(i, 1); have--; }
          const R = q.D / 2, topY = gy + q.h; for (const b of parts) if (b.q === q) { const rr = Math.hypot(b.x - q.pos.x, b.z - q.pos.y); b.y = topY + 0.28 * q.dome * q.h * (1 - (rr / R) ** 2) + 0.0005; }
        }
        for (let i = parts.length - 1; i >= 0; i--) if (!onPan.includes(parts[i].q)) parts.splice(i, 1);
        this.beads.update(dt, () => true);
      }
      this.drips.acc += (stoveOn && any ? clamp(d.fatDrip * 3000, 0, 12) : 0) * dt;
      while (this.drips.acc >= 1) { this.drips.acc -= 1; const q = pick(); const a = Math.random() * Math.PI * 2; this.drips.spawn({ q, x: q.pos.x + Math.cos(a) * (q.D / 2) * 1.01, y: gy + q.h * rand(0.3, 0.9), z: q.pos.y + Math.sin(a) * (q.D / 2) * 1.01, a, age: 0, s: rand(0.6, 1.2), sy: 1.8 }); }
      const dripFloor = this.stoveType === 'charcoal' ? this.coalY + 0.012 : gy + 0.001;
      this.drips.update(dt, (b, dt) => { const q = b.q; if (q.where !== 'pan') return false; const free = b.y < gy - 0.002; b.vy = free ? (b.vy || 0) + 9.81 * dt : 0; b.y -= (free ? b.vy : 0.008) * dt; if (!free) { b.x = q.pos.x + Math.cos(b.a) * (q.D / 2) * 1.02; b.z = q.pos.y + Math.sin(b.a) * (q.D / 2) * 1.02; } b.age += dt; return b.y > dripFloor && b.age < 6; });
    }
    _paintDirt(pan, dt) {
      this.dirtClock += dt;
      const n = (v, u) => Math.min(this.dirtSpots.length, Math.round(v / u));
      // the first four are blob counts, the fifth the depth of the carbon film; the signature is
      // built without allocating (this runs every frame, the repaint below almost never does)
      const counts = [n(pan.fond, 0.00002), n(pan.fondBurnt, 0.000015), n(pan.cheeseBits || 0, 0.00015), n(pan.meatBits || 0, 0.0001), Math.round(clamp((pan.carbon || 0) / 0.004, 0, 1) * 100) / 100];
      const sig = counts[0] + '|' + counts[1] + '|' + counts[2] + '|' + counts[3] + '|' + counts[4] + (pan.T > 180 ? 'h' : 'c');
      const any = counts[0] + counts[1] + counts[2] + counts[3] > 0 || counts[4] > 0.01;
      this.fond.visible = any; this.fond.scale.set(this.panR, this.panR, 1);
      if (!any || sig === this.dirtSig || this.dirtClock < 0.5) return;
      this.dirtSig = sig; this.dirtClock = 0;
      const c = this.dirtCv.getContext('2d'); c.clearRect(0, 0, 512, 512);
      const blob = (sp, r, fill) => { c.save(); c.translate(sp.x, sp.y); c.rotate(sp.rot); c.scale(1, sp.e); c.fillStyle = fill; c.beginPath(); c.arc(0, 0, r * sp.s, 0, Math.PI * 2); c.fill(); c.restore(); };
      // carbon: a smooth darkening plus fine black speckle
      if (counts[4] > 0.01) {
        c.fillStyle = `rgba(22,15,10,${0.4 * counts[4]})`; c.beginPath(); c.arc(256, 256, 250, 0, Math.PI * 2); c.fill();
        for (let i = 0; i < 700 * counts[4]; i++) blob(this.dirtSpots[(i * 7) % this.dirtSpots.length], 2.5, `rgba(8,6,4,${0.7 * counts[4]})`);
      }
      // fond: brown translucent blotches where juice boiled down
      for (let i = 0; i < counts[0]; i++) blob(this.dirtSpots[i], 4.5, 'rgba(92,50,14,0.5)');
      // burnt fond: small near-black specks
      for (let i = 0; i < counts[1]; i++) blob(this.dirtSpots[(i * 3 + 1) % this.dirtSpots.length], 2.8, 'rgba(20,12,7,0.85)');
      // welded cheese: yellow-brown patches that darken while the pan is hot
      const cheeseCol = pan.T > 180 ? 'rgba(140,85,25,0.85)' : 'rgba(200,150,55,0.85)';
      for (let i = 0; i < counts[2]; i++) blob(this.dirtSpots[(i * 5 + 2) % this.dirtSpots.length], 7, cheeseCol);
      // torn crust: dark red-brown flecks
      for (let i = 0; i < counts[3]; i++) blob(this.dirtSpots[(i * 11 + 3) % this.dirtSpots.length], 3.5, 'rgba(70,32,18,0.9)');
      // a little grain so nothing reads as a clean disc
      c.globalCompositeOperation = 'multiply'; c.globalAlpha = 0.25; c.drawImage(this.noiseFine, 0, 0, 512, 512); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
      this.dirtTex.needsUpdate = true;
    }
    _addStain(x, z, s) {
      if (this.stains.length > 150) { const old = this.stains.shift(); this.stainGroup.remove(old); }
      const m = new T.Mesh(this.stainGeo, this.stainMat); m.rotation.x = -Math.PI / 2; m.position.set(x, this.stainY || 0.0012, z); const sc = 0.002 * s * rand(0.8, 1.6); m.scale.set(sc, sc * rand(0.7, 1.3), 1); m.rotation.z = Math.random() * 3;
      this.stainGroup.add(m); this.stains.push(m);
    }
    clearStains() { for (const s of this.stains) this.stainGroup.remove(s); this.stains.length = 0; }
    pickPoint(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      const ndc = new T.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new T.Raycaster(); ray.setFromCamera(ndc, this.camera);
      const targets = []; for (const v of this.views.values()) { targets.push(v.mesh); if (v.cutMesh.visible) targets.push(v.cutMesh); } if (this.panMesh && this.stove.visible) targets.push(this.panMesh);
      this.stove.visible && targets.push(this.stove.children[0]); this.board.visible && targets.push(this.board.children[0]);
      const hits = ray.intersectObjects(targets, false);
      return hits.length ? hits[0].point : null;
    }
  }

  // ------------------------------------------------------------ orbit / mouse-look controls
  class Orbit {
    constructor(vp) {
      this.vp = vp; this.cam = vp.camera; this.el = vp.canvas;
      this.target = new T.Vector3(0, 0.02, 0); this.azimuth = -0.9; this.polar = 1.05; this.dist = 0.55;
      this.goal = { target: this.target.clone(), azimuth: this.azimuth, polar: this.polar, dist: this.dist };
      this.zoomStack = null; this.drag = null;
      this.el.addEventListener('contextmenu', (e) => e.preventDefault());
      this.el.addEventListener('pointerdown', (e) => this.onDown(e));
      window.addEventListener('pointermove', (e) => this.onMove(e));
      window.addEventListener('pointerup', (e) => this.onUp(e));
      this.el.addEventListener('wheel', (e) => { e.preventDefault(); this.dolly(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
      window.addEventListener('keydown', (e) => this.onKey(e));
      this.pinch = null;
      this.el.addEventListener('touchstart', (e) => { if (e.touches.length === 2) this.pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }, { passive: true });
      this.el.addEventListener('touchmove', (e) => { if (e.touches.length === 2 && this.pinch) { const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); this.dolly(this.pinch / d); this.pinch = d; } }, { passive: true });
      this.keys = {};
    }
    reset(mode) {
      this.zoomStack = null;
      if (mode === 'board') { this.goal = { target: new T.Vector3(0, 0.01, 0), azimuth: -0.7, polar: 0.95, dist: 0.36 }; }
      else if (this.vp.PAN_Y > 0.1) { this.goal = { target: new T.Vector3(0, this.vp.PAN_Y - 0.02, 0), azimuth: -1.0, polar: 0.85, dist: 0.95 }; }
      else { this.goal = { target: new T.Vector3(0, 0.045, 0), azimuth: -1.0, polar: 1.0, dist: 0.6 }; }
    }
    preset(name) {
      this.zoomStack = null;
      const pg = this.vp.pattyGroup && this.vp.patty ? this.vp.pattyGroup.position.clone().setY(this.vp.pattyGroup.position.y + (this.vp.patty.h || 0.02) / 2) : null;
      const t = pg || (this.vp.mode === 'stove' ? new T.Vector3(0, this.vp.PAN_Y + 0.01, 0) : new T.Vector3(0, 0.01, 0));
      if (name === 'top') this.goal = { target: t, azimuth: this.goal.azimuth, polar: 0.12, dist: 0.5 };
      if (name === 'side') this.goal = { target: t.clone().setY(t.y + 0.01), azimuth: -Math.PI / 2, polar: 1.45, dist: 0.32 };
      if (name === 'close') this.goal = { target: t.clone().setY(t.y + 0.01), azimuth: this.goal.azimuth, polar: 1.1, dist: 0.16 };
      if (name === 'serve') { const az = -0.9; this.goal = { target: t.clone().add(new T.Vector3(Math.sin(az) * 0.075, 0.03, -Math.cos(az) * 0.075)), azimuth: az, polar: 1.2, dist: 0.34 }; }
      if (name === 'default') this.reset(this.vp.mode);
    }
    dolly(f) { this.goal.dist = clamp(this.goal.dist * f, 0.06, 2.5); }
    onDown(e) {
      this.el.setPointerCapture && this.el.setPointerCapture(e.pointerId);
      this.drag = { b: e.button, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: 0, shift: e.shiftKey };
    }
    onMove(e) {
      const d = this.drag; if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y; d.x = e.clientX; d.y = e.clientY; d.moved += Math.abs(dx) + Math.abs(dy);
      if (d.b === 0 && !d.shift) { this.goal.azimuth -= dx * 0.006; this.goal.polar = clamp(this.goal.polar - dy * 0.006, 0.05, 1.52); }
      else if (d.b === 2) { this.dolly(Math.exp(dy * 0.006)); }
      else { // pan (middle, or shift+left)
        const right = new T.Vector3(); const up = new T.Vector3(0, 1, 0); this.cam.getWorldDirection(right); right.cross(up).normalize();
        const fwd = right.clone().cross(up).normalize();
        const k = this.goal.dist * 0.0015;
        this.goal.target.addScaledVector(right, -dx * k).addScaledVector(fwd, -dy * k);
      }
    }
    onUp(e) {
      const d = this.drag; if (!d) return; this.drag = null;
      if (d.b === 2 && d.moved < 6) this.zoomToPoint(e.clientX, e.clientY);
      if (d.b === 0 && d.moved < 6 && this.vp.onPick) { const p = this.vp.pickPatty(e.clientX, e.clientY); if (p) this.vp.onPick(p); }
    }
    zoomToPoint(x, y) {
      if (this.zoomStack) { this.goal = this.zoomStack; this.zoomStack = null; return; }
      const pt = this.vp.pickPoint(x, y); if (!pt) return;
      this.zoomStack = { target: this.goal.target.clone(), azimuth: this.goal.azimuth, polar: this.goal.polar, dist: this.goal.dist };
      this.goal = { target: pt.clone(), azimuth: this.goal.azimuth, polar: Math.min(this.goal.polar, 1.2), dist: Math.max(0.07, this.goal.dist * 0.28) };
    }
    onKey(e) {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
      const k = e.key.toLowerCase();
      if (k === 'r') this.reset(this.vp.mode);
      if (k === '1') this.preset('default'); if (k === '2') this.preset('top'); if (k === '3') this.preset('side'); if (k === '4') this.preset('close');
      if (k === 'arrowleft') this.goal.azimuth += 0.15; if (k === 'arrowright') this.goal.azimuth -= 0.15;
      if (k === 'arrowup') this.goal.polar = clamp(this.goal.polar - 0.1, 0.05, 1.52); if (k === 'arrowdown') this.goal.polar = clamp(this.goal.polar + 0.1, 0.05, 1.52);
      if (k === '+' || k === '=') this.dolly(0.8); if (k === '-') this.dolly(1.25);
    }
    update(dt) {
      const k = 1 - Math.exp(-dt * 9);
      this.azimuth = lerp(this.azimuth, this.goal.azimuth, k); this.polar = lerp(this.polar, this.goal.polar, k); this.dist = lerp(this.dist, this.goal.dist, k);
      this.target.lerp(this.goal.target, k);
      const sp = Math.sin(this.polar);
      this.cam.position.set(this.target.x + this.dist * sp * Math.cos(this.azimuth), this.target.y + this.dist * Math.cos(this.polar), this.target.z + this.dist * sp * Math.sin(this.azimuth));
      this.cam.lookAt(this.target);
    }
  }

  root.BurgerRender = { Viewport, PattyView, nodeColour, faceColour, COL };
})(window);
