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

  // ------------------------------------------------------------ colour model
  const COL = {
    frozen: [190, 120, 130], raw: [150, 32, 44], rawWarm: [176, 58, 66], pink: [205, 118, 118],
    cooked: [158, 112, 96], dry: [118, 82, 62],
    fat: [236, 226, 208], fatMelt: [238, 200, 140],
    brown: [[168, 122, 88], [190, 140, 92], [160, 100, 52], [122, 66, 30], [86, 42, 20], [56, 28, 14], [32, 18, 12], [22, 14, 10]],
    char: [14, 12, 11],
  };
  function nodeColour(p, i) {
    const Tn = p.T[i];
    let c;
    if (Tn < 0) c = mix3(COL.frozen, COL.raw, clamp((Tn + 8) / 8, 0, 1));
    else c = mix3(COL.raw, COL.rawWarm, clamp(Tn / 40, 0, 1));
    const g = p.dG[i], m = p.dM[i];
    c = mix3(c, COL.pink, clamp(m * 0.6 + g * 0.5, 0, 1));
    c = mix3(c, COL.cooked, clamp(g, 0, 1));
    const dryness = 1 - clamp(p.w[i] / p.w0, 0, 1);
    c = mix3(c, COL.dry, clamp((dryness - 0.35) / 0.6, 0, 1));
    return c;
  }
  function faceColour(face, baseCol) {
    const b = clamp(face.brown, 0, 7);
    const i = Math.floor(b), t = b - i;
    let c = mix3(COL.brown[i], COL.brown[Math.min(7, i + 1)], t);
    c = mix3(baseCol, c, clamp(b / 0.8, 0, 1));
    c = mix3(c, COL.char, clamp(face.char / 1.1, 0, 1));
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
      this.clock = 0; this.texClock = 0;
      this.mode = 'board'; // 'board' | 'stove'
      this.cutaway = false;
      this._buildLights(); this._buildKitchen(); this._buildStove(); this._buildBoard(); this._buildParticles(); this._buildProbe();
      this._buildTextures();
      this.patty = null;
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
      this.fondMat = new T.MeshStandardMaterial({ color: 0x4a2a12, transparent: true, opacity: 0, roughness: 0.9 });
      this.fond = new T.Mesh(new T.CircleGeometry(1, 48), this.fondMat); this.fond.rotation.x = -Math.PI / 2; this.fond.position.y = 0.0004; this.panGroup.add(this.fond);
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
      this.flameLight.position.y = this.PAN_Y - 0.01;
      if (this.panSpec) this.setPan(this.panSpec.id);
    }
    setPan(id) {
      const pan = P.PANS[id] || P.PANS.castiron; this.panSpec = pan;
      if (this.panMesh) this.panGroup.remove(this.panMesh);
      const R = pan.diam / 2, wall = 0.045;
      const prof = [{ r: 0, y: 0, v: 0, hard: false }, { r: R * 0.97, y: 0, v: 0.3, hard: true }, { r: R * 1.02, y: wall * 0.5, v: 0.6, hard: false }, { r: R * 1.06, y: wall, v: 0.8, hard: true }, { r: R * 1.06, y: wall - 0.004, v: 0.85, hard: true }, { r: R * 1.0, y: wall - 0.004, v: 0.9, hard: true }, { r: R * 0.95, y: 0.004, v: 0.95, hard: true }, { r: 0, y: 0.004, v: 1, hard: false }];
      const geo = buildLathe(prof, 96, Math.PI * 2);
      const look = { castiron: [0x17140f, 0.55, 0.5], carbonsteel: [0x23201d, 0.4, 0.8], stainless: [0x9ea2a6, 0.25, 0.95], nonstick: [0x141416, 0.35, 0.3] }[id] || [0x17140f, 0.55, 0.5];
      this.panMat.color.setHex(look[0]); this.panMat.roughness = look[1]; this.panMat.metalness = look[2];
      const m = new T.Mesh(geo, this.panMat); m.castShadow = true; m.receiveShadow = true; m.position.y = this.PAN_Y;
      const handle = new T.Mesh(new T.BoxGeometry(0.22, 0.014, 0.03), this.panMat); handle.position.set(-R - 0.14, 0.045, 0); handle.rotation.z = -0.15; handle.castShadow = true; m.add(handle);
      if (id === 'nonstick' || id === 'stainless') { const grip = new T.Mesh(new T.BoxGeometry(0.16, 0.02, 0.034), new T.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 })); grip.position.set(-R - 0.17, 0.045, 0); grip.rotation.z = -0.15; m.add(grip); }
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
      const g = this.probeGroup; const p = this.patty;
      if (!inserted || !p || !this.pattyGroup) { g.visible = false; return; }
      g.visible = true;
      const R = p.D / 2, y = this.pattyGroup.position.y + p.h * (1 - depthFrac);
      const az = -0.6; // comes in from the front-right, tip reaches the centre
      g.position.set(this.pattyGroup.position.x + Math.cos(az) * 0.0, y, this.pattyGroup.position.z + Math.sin(az) * 0.0);
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
    _buildTextures() {
      this.noise = makeNoise(512, 5, true);
      this.noiseFine = makeNoise(512, 6, false);
      this.marble = makeBlobs(1024, 3200, 1.2, 5.5, 'rgba(255,255,255,1)');
      this.marbleCut = makeBlobs(512, 900, 1, 4, 'rgba(255,255,255,1)');
      this.spots = makeBlobs(1024, 1400, 2, 9, 'rgba(0,0,0,1)'); this.blotch = makeBlobs(1024, 40, 14, 50, 'rgba(0,0,0,1)');
      this.atlas = document.createElement('canvas'); this.atlas.width = 1024; this.atlas.height = 1024;
      this.atlasTex = new T.CanvasTexture(this.atlas); this.atlasTex.anisotropy = 8;
      this.cut = document.createElement('canvas'); this.cut.width = 512; this.cut.height = 256;
      this.cutTex = new T.CanvasTexture(this.cut);
      this.roughCv = document.createElement('canvas'); this.roughCv.width = 1024; this.roughCv.height = 1024;
      this.roughTex = new T.CanvasTexture(this.roughCv);
    }

    // ---- patty mesh management
    setPatty(p) {
      if (this.pattyGroup) { this.scene.remove(this.pattyGroup); }
      this.patty = p; if (!p) return;
      const g = new T.Group(); this.pattyGroup = g;
      this.pattyMat = new T.MeshPhysicalMaterial({ map: this.atlasTex, roughnessMap: this.roughTex, roughness: 0.75, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.5 });
      this.cutMat = new T.MeshStandardMaterial({ map: this.cutTex, roughness: 0.6, side: T.DoubleSide });
      this.pattyMesh = new T.Mesh(new T.BufferGeometry(), this.pattyMat); this.pattyMesh.castShadow = true; this.pattyMesh.receiveShadow = true; g.add(this.pattyMesh);
      this.cutMesh = new T.Mesh(new T.BufferGeometry(), this.cutMat); this.cutMesh.visible = false; this.cutMesh.castShadow = true; g.add(this.cutMesh);
      this.cheeseMeshes = [];
      this.scene.add(g);
      this.lastGeo = null; this.forceTex = true;
      this._rebuildGeometry(true);
      this._paintTextures();
    }
    /** Slice the patty in half along the plane facing the camera. The patty itself never moves:
     *  the retained half is built from a start angle, and only the cut-face mesh is rotated. */
    setCutaway(on) {
      this.cutaway = on;
      if (on) this.cutPhi = this.controls.goal.azimuth + Math.PI / 2; // retained half sits away from the camera
      if (this.pattyGroup) this._rebuildGeometry(true);
    }
    _rebuildGeometry(force) {
      const p = this.patty; if (!p) return;
      const R = p.D / 2, h = p.h, dome = p.dome;
      const raw = 1 - clamp((p.dM.reduce((a, b) => a + b, 0) / p.N) * 1.2, 0, 1);
      const key = [R.toFixed(4), h.toFixed(4), dome.toFixed(2), raw.toFixed(2), this.cutaway].join('|');
      if (!force && key === this.lastGeo) return; this.lastGeo = key;
      const prof = pattyProfile(R, h, dome, p.dimple, raw);
      const phi = this.cutaway ? Math.PI : Math.PI * 2;
      this.pattyMesh.geometry.dispose(); this.pattyMesh.geometry = buildLathe(prof, 96, phi, this.cutaway ? this.cutPhi : 0);
      if (this.cutaway) {
        this.cutMesh.geometry.dispose(); this.cutMesh.geometry = new T.ShapeGeometry(crossSectionShape(prof), 4);
        this.cutMesh.rotation.y = -(this.cutPhi || 0); // the shape lives in the XY plane (phi = 0); turn it onto the cut plane
        this.cutMesh.visible = true;
        this.cutTex.repeat.set(1 / (2 * R * 1.06), 1 / (h * 1.02)); this.cutTex.offset.set(0.5, 0); this.cutTex.wrapS = this.cutTex.wrapT = T.ClampToEdgeWrapping;
      } else this.cutMesh.visible = false;
    }
    _paintTextures() {
      const p = this.patty; if (!p) return;
      const N = p.N, A = this.atlas, c = A.getContext('2d'), W = A.width, H = A.height;
      // regions in canvas pixels: caps are the two top quadrants, side strip is the lower half
      const bt = { y0: 0, y1: H / 2, x0: 0, x1: W / 2 }, bb = { y0: 0, y1: H / 2, x0: W / 2, x1: W }, bs = { y0: H * (1 - BANDS.side[1]), y1: H * (1 - BANDS.side[0]), x0: 0, x1: W };
      c.clearRect(0, 0, W, H);
      const topCol = p.faceUp.brown > 0.3 ? faceColour(p.faceUp, nodeColour(p, N - 1)) : nodeColour(p, N - 1);
      c.fillStyle = rgb(topCol); c.fillRect(bt.x0, bt.y0, bt.x1 - bt.x0, bt.y1 - bt.y0);
      const botCol = faceColour(p.faceDown, nodeColour(p, 0)); c.fillStyle = rgb(botCol); c.fillRect(bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0);
      // --- side: node stripes bottom→top
      for (let i = 0; i < N; i++) {
        const y1 = bs.y1 - ((i) / N) * (bs.y1 - bs.y0), y0 = bs.y1 - ((i + 1) / N) * (bs.y1 - bs.y0);
        let col = nodeColour(p, i);
        if (i === 0) col = mix3(col, botCol, 0.7); if (i === N - 1) col = mix3(col, topCol, 0.7);
        c.fillStyle = rgb(col); c.fillRect(0, y0 - 0.5, W, y1 - y0 + 1);
      }
      // grain
      c.globalCompositeOperation = 'multiply'; c.globalAlpha = 0.7; c.drawImage(this.noise, 0, 0, W, H); c.globalAlpha = 1;
      c.globalCompositeOperation = 'multiply'; c.globalAlpha = 0.35; c.drawImage(this.noiseFine, 0, 0, W, H); c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      // marbling: visible fat flecks fade as the fat renders
      const fatLeft = (i) => clamp((p.fs[i] + p.fl[i]) / (p.fat0 + 1e-12), 0, 1);
      const paintFat = (y0, y1, frac, melted) => {
        c.save(); c.beginPath(); c.rect(0, y0, W, y1 - y0); c.clip();
        c.globalAlpha = 0.85 * frac * p.fatFrac * 3.2; c.globalCompositeOperation = 'lighter';
        c.fillStyle = rgb(melted ? COL.fatMelt : COL.fat);
        c.drawImage(this.marble, 0, 0, W, H); c.restore();
      };
      // use the mask as an alpha source: draw tinted by compositing
      const tintMask = (mask, colour, alpha, rg) => {
        if (alpha <= 0.002) return;
        const off = this._off || (this._off = document.createElement('canvas')); off.width = W; off.height = H; const oc = off.getContext('2d');
        oc.clearRect(0, 0, W, H); oc.drawImage(mask, 0, 0, W, H); oc.globalCompositeOperation = 'source-in'; oc.fillStyle = rgb(colour); oc.fillRect(0, 0, W, H); oc.globalCompositeOperation = 'source-over';
        c.save(); c.beginPath(); c.rect(rg.x0, rg.y0, rg.x1 - rg.x0, rg.y1 - rg.y0); c.clip(); c.globalAlpha = alpha; c.drawImage(off, 0, 0); c.restore();
      };
      const rawTop = p.faceUp.brown < 0.3;
      if (rawTop) tintMask(this.marble, p.T[N - 1] > 40 ? COL.fatMelt : COL.fat, 0.9 * fatLeft(N - 1) * p.fatFrac * 3, bt);
      tintMask(this.marble, COL.fatMelt, 0.6 * (fatLeft(Math.floor(N / 2))) * p.fatFrac * 3, bs);
      // crust texture: darker mottled spots where the pan contact was best, black char blotches
      const crustSpots = (face, rg) => {
        tintMask(this.spots, [40, 20, 10], clamp(face.brown / 4, 0, 0.6), rg);
        tintMask(this.blotch, COL.char, clamp(face.char / 0.6, 0, 0.75), rg);
        tintMask(this.spots, COL.char, clamp(face.char / 0.4, 0, 0.9), rg);
        if (face.torn > 0) tintMask(this.marbleCut, [150, 60, 60], clamp(face.torn * 3, 0, 0.8), rg);
      };
      crustSpots(p.faceDown, bb); if (!rawTop) crustSpots(p.faceUp, bt);
      // doming: the centre of the down face lifts off the pan and browns less
      if (p.dome > 0.2) { const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2; const g = c.createRadialGradient(cx, cy, 0, cx, cy, W * 0.2); g.addColorStop(0, `rgba(150,110,95,${0.7 * p.dome})`); g.addColorStop(1, 'rgba(150,110,95,0)'); c.fillStyle = g; c.fillRect(bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0); }
      // juice sheen on top / frost when frozen
      if (p.poolTop > 1e-5) { c.fillStyle = `rgba(200,70,80,${clamp(p.poolTop / 0.002, 0, 0.5)})`; c.fillRect(bt.x0, bt.y0, bt.x1 - bt.x0, bt.y1 - bt.y0); }
      if (p.T[N - 1] < -2) { c.fillStyle = `rgba(235,240,255,${clamp(-p.T[N - 1] / 20, 0, 0.6)})`; c.fillRect(0, 0, W, H); }
      this.atlasTex.needsUpdate = true;
      // roughness map: wet (juicy/fatty) is shiny; dry crust is matte
      const rc = this.roughCv.getContext('2d');
      const wet = (i) => clamp(p.w[i] / p.w0, 0, 1);
      const rough = (v) => `rgb(${(v * 255) | 0},${(v * 255) | 0},${(v * 255) | 0})`;
      rc.fillStyle = rough(lerp(0.9, 0.35, clamp(wet(N - 1) * (rawTop ? 1 : 0.4) + clamp(p.poolTop / 0.002, 0, 0.6) + clamp(p.fatTop / 0.001, 0, 0.4), 0, 1))); rc.fillRect(bt.x0, bt.y0, bt.x1 - bt.x0, bt.y1 - bt.y0);
      rc.fillStyle = rough(lerp(0.95, 0.5, wet(0) * 0.3)); rc.fillRect(bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0);
      rc.fillStyle = rough(lerp(0.9, 0.3, wet(Math.floor(N / 2)))); rc.fillRect(bs.x0, bs.y0, bs.x1 - bs.x0, bs.y1 - bs.y0);
      this.roughTex.needsUpdate = true;

      // --- cross-section texture (only when cutaway is showing)
      if (this.cutaway) {
        const cc = this.cut.getContext('2d'), CW = this.cut.width, CH = this.cut.height;
        for (let i = 0; i < N; i++) {
          const y1 = CH - (i / N) * CH, y0 = CH - ((i + 1) / N) * CH;
          cc.fillStyle = rgb(nodeColour(p, i)); cc.fillRect(0, y0 - 0.5, CW, y1 - y0 + 1);
        }
        cc.globalCompositeOperation = 'multiply'; cc.globalAlpha = 0.45; cc.drawImage(this.noiseFine, 0, 0, CW, CH); cc.globalAlpha = 1; cc.globalCompositeOperation = 'source-over';
        // marbling flecks per node, fading as rendered; melted fat glistens
        for (let i = 0; i < N; i++) {
          const y1 = CH - (i / N) * CH, y0 = CH - ((i + 1) / N) * CH;
          const fl = fatLeft(i); const melted = p.T[i] > 42;
          if (fl > 0.02) {
            const off = this._off2 || (this._off2 = document.createElement('canvas')); off.width = CW; off.height = CH; const oc = off.getContext('2d');
            oc.clearRect(0, 0, CW, CH); oc.drawImage(this.marbleCut, 0, 0, CW, CH); oc.globalCompositeOperation = 'source-in'; oc.fillStyle = rgb(melted ? COL.fatMelt : COL.fat); oc.fillRect(0, 0, CW, CH); oc.globalCompositeOperation = 'source-over';
            cc.save(); cc.beginPath(); cc.rect(0, y0, CW, y1 - y0); cc.clip(); cc.globalAlpha = 0.9 * fl * p.fatFrac * 3; cc.drawImage(off, 0, 0); cc.restore();
          }
        }
        // crust bands
        const crustH = (f) => clamp(f.brown / 7, 0, 1) * 0.06 * CH + 2;
        cc.fillStyle = rgb(faceColour(p.faceDown, nodeColour(p, 0))); cc.fillRect(0, CH - crustH(p.faceDown), CW, crustH(p.faceDown));
        if (p.faceUp.brown > 0.3) { cc.fillStyle = rgb(faceColour(p.faceUp, nodeColour(p, N - 1))); cc.fillRect(0, 0, CW, crustH(p.faceUp)); }
        // free juice glistening between fibres near the faces
        for (let i = 0; i < N; i++) {
          const free = Math.max(0, p.w[i] - P.waterHolding(p, i) * p.w0) / p.w0;
          if (free > 0.005) { const y1 = CH - (i / N) * CH, y0 = CH - ((i + 1) / N) * CH; cc.fillStyle = `rgba(230,90,100,${clamp(free * 6, 0, 0.5)})`; cc.fillRect(0, y0, CW, y1 - y0); }
        }
        this.cutTex.needsUpdate = true;
      }
    }

    // ---- per-frame update from the physics state
    setMode(mode) {
      this.mode = mode;
      this.stove.visible = mode === 'stove'; this.board.visible = mode === 'board';
      this.scene.background.setHex(mode === 'stove' ? 0x1a1714 : 0x2a2622); this.scene.fog.color.copy(this.scene.background);
      this.controls.reset(mode);
    }
    update(state, dt) {
      this.clock += dt; this.texClock += dt;
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
      this.oil.visible = r > 0.004; this.oil.scale.set(r, r, 1); this.oil.position.y = oilY;
      const deep = clamp(depth / 0.02, 0, 1);
      this.oilMat.opacity = 0.2 + 0.2 * clamp(pan.oil / 0.01, 0, 1) + 0.3 * deep;
      // spilled fat on the stovetop
      const spillR = Math.min(0.45, Math.sqrt((pan.overflow || 0) / 920 / (Math.PI * 0.0015)));
      this.spill.visible = spillR > 0.01; this.spill.scale.set(spillR * 1.15, spillR, 1); this.spill.position.y = (this.stainY || 0.0012) + 0.0003;
      // grease fire
      const flare = pan.flare || 0;
      for (const f of this.flareFlames) {
        f.visible = flare > 0;
        if (flare > 0) {
          const fl = 0.5 + 0.5 * Math.random(); const rr = this.panR * 1.08;
          f.position.set(Math.cos(f.userData.a) * rr, this.PAN_Y - 0.004, Math.sin(f.userData.a) * rr);
          f.rotation.order = 'YXZ'; f.rotation.y = -f.userData.a; f.rotation.z = -0.25;
          f.scale.set(0.5 + 0.6 * fl, 0.03 + 0.07 * fl * Math.min(1, flare / 2), 0.5 + 0.6 * fl);
          f.material.color.setRGB(1, 0.35 + 0.25 * Math.random(), 0.05);
          f.material.opacity = 0.35 + 0.25 * fl;
        }
      }
      if (flare > 0) { this.flameLight.color.setHex(0xff7a10); this.flameLight.intensity = 3 * (0.7 + 0.3 * Math.random()); }
      const fondT = clamp(pan.fond / 0.02, 0, 1);
      this.oilMat.color.setRGB(lerp(0.85, 0.6, Math.max(deep, fondT * 0.5)), lerp(0.63, 0.34, Math.max(deep, fondT)), lerp(0.22, 0.07, deep));
      const fondA = clamp(pan.fond / 0.015, 0, 0.7) + clamp(pan.fondBurnt / 0.01, 0, 0.3);
      this.fond.visible = fondA > 0.02; this.fondMat.opacity = fondA; this.fond.scale.set(this.panR * 0.7, this.panR * 0.7, 1);
      this.fondMat.color.setRGB(0.3 - 0.25 * clamp(pan.fondBurnt / 0.01, 0, 1), 0.17 - 0.12 * clamp(pan.fondBurnt / 0.01, 0, 1), 0.07);

      // patty placement
      if (p && this.patty !== p) this.setPatty(p);
      if (!p && this.patty) this.setPatty(null);
      if (p) {
        const g = this.pattyGroup;
        if (state.where === 'pan') { g.position.set(0, this.panFloorY, 0); }
        else if (state.where === 'board') { g.position.set(0, 0, 0); }
        else { g.position.set(this.mode === 'stove' ? 0.42 : 0, this.mode === 'stove' ? 0.009 : 0, this.mode === 'stove' ? 0.12 : 0); }
        this._rebuildGeometry(false);
        if (this.texClock > 0.08 || this.forceTex) { this.texClock = 0; this.forceTex = false; this._paintTextures(); }
        // cheese stack: one draped, vertex-coloured mesh per slice
        this.cheeseMeshes = this.cheeseMeshes || [];
        while (this.cheeseMeshes.length > p.cheeses.length) g.remove(this.cheeseMeshes.pop());
        while (this.cheeseMeshes.length < p.cheeses.length) {
          const k = this.cheeseMeshes.length;
          const geo = new T.PlaneGeometry(0.095, 0.095, 14, 14); geo.rotateX(-Math.PI / 2);
          geo.setAttribute('color', new T.BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(1), 3));
          const m = new T.Mesh(geo, new T.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, clearcoat: 0.3, side: T.DoubleSide }));
          m.castShadow = true; m.userData.base = geo.attributes.position.array.slice(); m.rotation.y = p.cheeses[k].rot; g.add(m); this.cheeseMeshes.push(m);
        }
        const yellow = [0.95, 0.70, 0.24], melted = [0.99, 0.74, 0.20], golden = [0.72, 0.42, 0.10], dark = [0.28, 0.13, 0.05];
        for (let k = 0; k < this.cheeseMeshes.length; k++) {
          const mesh = this.cheeseMeshes[k], ch = p.cheeses[k], R = p.D / 2, geo = mesh.geometry, pos = geo.attributes.position.array, col = geo.attributes.color.array, base = mesh.userData.base;
          const topY = p.h * (1 + 0.28 * p.dome) + k * 0.0015; mesh.position.y = topY + 0.0008;
          const floorLocal = -mesh.position.y + 0.0006 + k * 0.0004; // pan / plate surface, in mesh coordinates
          const sk = ch.skirt; const sc = 1 + 0.15 * ch.melt + 0.004 * k;
          let onTop = mix3(yellow, melted, ch.melt);
          let skirtCol = onTop;
          if (sk) { skirtCol = mix3(onTop, golden, clamp(sk.brown / 2.5, 0, 1)); skirtCol = mix3(skirtCol, dark, clamp((sk.brown - 2.5) / 3, 0, 1)); skirtCol = mix3(skirtCol, [0.06, 0.05, 0.04], clamp(sk.char / 0.8, 0, 1)); }
          for (let i = 0; i < pos.length; i += 3) {
            const x = base[i], z = base[i + 2]; const rr = Math.hypot(x, z);
            const over = Math.max(0, rr - R * 0.98);
            let y = base[i + 1] - over * (0.2 + 1.6 * ch.melt);
            const touching = y <= floorLocal;
            let spread = sc;
            if (touching) { y = floorLocal; spread = sc + (sk ? 0.18 * sk.melt : 0) + 0.1 * ch.melt * over / Math.max(rr, 1e-4); }
            pos[i] = x * spread; pos[i + 2] = z * spread; pos[i + 1] = y;
            const c = touching || ch.submerged ? skirtCol : onTop;
            col[i] = c[0]; col[i + 1] = c[1]; col[i + 2] = c[2];
          }
          geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true; geo.computeVertexNormals();
          mesh.material.roughness = clamp(0.6 - 0.45 * ch.melt + (sk ? 0.35 * sk.dry : 0), 0.05, 1);
          mesh.material.clearcoat = 0.3 * (1 - (sk ? sk.dry : 0));
        }
      }

      // particles
      const d = state.diag, R = p ? p.D / 2 : 0.05;
      const onPan = p && state.where === 'pan';
      const gx = onPan ? 0 : 0, gz = 0, gy = this.panFloorY;
      const oilDepth = state.pan.oilDepth || 0, under = p && oilDepth > p.h;
      const surfY = gy + Math.max(0.002, oilDepth);
      const edge = () => { const a = Math.random() * Math.PI * 2; const rr = R * rand(0.9, 1.15); return [gx + Math.cos(a) * rr, surfY, gz + Math.sin(a) * rr]; };
      const anywhereTop = () => { const a = Math.random() * Math.PI * 2; const rr = Math.sqrt(Math.random()) * R * 0.9; return [gx + Math.cos(a) * rr, Math.max(surfY, gy + (p ? p.h : 0) + 0.003), gz + Math.sin(a) * rr]; };
      const panSpot = () => { const a = Math.random() * Math.PI * 2; const rr = Math.sqrt(Math.random()) * this.panR * 0.8; return [Math.cos(a) * rr, surfY, Math.sin(a) * rr]; };
      const stoveOn = this.mode === 'stove';
      const steamRate = stoveOn ? (onPan ? d.evapBottom * 6000 + (p ? p.evapTop * 3000 : 0) : 0) + d.evapPan * 5000 : 0;
      this.steam.update(dt, Math.min(steamRate, 160), () => (Math.random() < 0.7 && onPan ? edge() : onPan && Math.random() < 0.5 ? anywhereTop() : panSpot()), 0.01);
      this.smoke.update(dt, stoveOn ? clamp(d.smoke, 0, 2) * 45 : 0, () => (Math.random() < 0.6 && onPan ? edge() : panSpot()), 0.02);
      // sizzle bubbles in the fat around the patty rim
      const bubbleRate = stoveOn ? (onPan ? d.evapBottom * 9000 : 0) + d.evapPan * 6000 + d.oilBubble * 40 : 0;
      this.bubbles.acc += Math.min(bubbleRate, 250) * dt;
      while (this.bubbles.acc >= 1) { this.bubbles.acc -= 1; const e = onPan && Math.random() < 0.8 ? edge() : panSpot(); this.bubbles.spawn({ x: e[0], y: e[1], z: e[2], age: 0, life: rand(0.08, 0.3), s: rand(0.4, 1.0) }); }
      this.bubbles.update(dt, (b, dt) => { b.age += dt; b.s *= 1 + dt * 2; return b.age < b.life; });
      // spatter: droplets thrown out of the fat, landing on the stove
      this.spatter.acc += (stoveOn ? clamp(d.spatter, 0, 40) : 0) * dt;
      while (this.spatter.acc >= 1) { this.spatter.acc -= 1; const e = onPan && Math.random() < 0.85 ? edge() : panSpot(); const a = Math.random() * Math.PI * 2, v = rand(0.25, 0.9); this.spatter.spawn({ x: e[0], y: e[1], z: e[2], vx: Math.cos(a) * v * 0.6, vy: v, vz: Math.sin(a) * v * 0.6, age: 0, s: rand(0.5, 1.3) }); }
      this.spatter.update(dt, (b, dt) => {
        b.vy -= 9.81 * dt; b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
        const rr = Math.hypot(b.x, b.z);
        if (b.y < gy + 0.001 && rr < this.panR) { b.y = gy + 0.001; b.vy = 0; b.vx *= 0.5; b.vz *= 0.5; b.age += dt; return b.age < 0.6; }
        if (b.y < (this.stainY || 0.0012) + 0.0005 && rr > this.panR) { this._addStain(b.x, b.z, b.s); return false; }
        if (b.y < -0.05) return false; return true;
      });
      // juice beads on the top surface
      if (p && onPan && !under) {
        const want = clamp(Math.round(p.poolTop / 0.00001), 0, 120);
        while (this.beads.parts.length < want) { const e = anywhereTop(); this.beads.spawn({ x: e[0], y: e[1] - 0.0025, z: e[2], s: rand(0.5, 1.5), sy: 0.6 }); }
        while (this.beads.parts.length > want) this.beads.parts.pop();
        const topY = gy + p.h; for (const b of this.beads.parts) { const rr = Math.hypot(b.x, b.z); b.y = topY + 0.28 * p.dome * p.h * (1 - (rr / R) ** 2) + 0.0005 + (p.dimple ? 0 : 0); }
      } else this.beads.parts.length = 0;
      this.beads.update(dt, () => true);
      // rendered fat running down the sides
      this.drips.acc += (stoveOn && onPan ? clamp(d.fatDrip * 3000, 0, 12) : 0) * dt;
      while (this.drips.acc >= 1) { this.drips.acc -= 1; const a = Math.random() * Math.PI * 2; this.drips.spawn({ x: Math.cos(a) * R * 1.01, y: gy + p.h * rand(0.3, 0.9), z: Math.sin(a) * R * 1.01, a, age: 0, s: rand(0.6, 1.2), sy: 1.8 }); }
      this.drips.update(dt, (b, dt) => { b.y -= 0.008 * dt; b.x = Math.cos(b.a) * R * 1.02; b.z = Math.sin(b.a) * R * 1.02; b.age += dt; return b.y > gy + 0.001 && b.age < 6; });

      this.controls.update(dt);
      this.renderer.render(this.scene, this.camera);
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
      const targets = []; if (this.pattyMesh) targets.push(this.pattyMesh); if (this.cutMesh && this.cutMesh.visible) targets.push(this.cutMesh); if (this.panMesh && this.stove.visible) targets.push(this.panMesh);
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
      else { this.goal = { target: new T.Vector3(0, 0.045, 0), azimuth: -1.0, polar: 1.0, dist: 0.6 }; }
    }
    preset(name) {
      this.zoomStack = null;
      const pg = this.vp.pattyGroup && this.vp.patty ? this.vp.pattyGroup.position.clone().setY(this.vp.pattyGroup.position.y + (this.vp.patty.h || 0.02) / 2) : null;
      const t = pg || (this.vp.mode === 'stove' ? new T.Vector3(0, 0.03, 0) : new T.Vector3(0, 0.01, 0));
      if (name === 'top') this.goal = { target: t, azimuth: this.goal.azimuth, polar: 0.12, dist: 0.5 };
      if (name === 'side') this.goal = { target: t.clone().setY(t.y + 0.01), azimuth: -Math.PI / 2, polar: 1.45, dist: 0.32 };
      if (name === 'close') this.goal = { target: t.clone().setY(t.y + 0.01), azimuth: this.goal.azimuth, polar: 1.1, dist: 0.16 };
      if (name === 'serve') { const az = -0.9; this.goal = { target: t.clone().add(new T.Vector3(Math.sin(az) * 0.075, 0.01, -Math.cos(az) * 0.075)), azimuth: az, polar: 1.15, dist: 0.32 }; }
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

  root.BurgerRender = { Viewport, nodeColour, faceColour, COL };
})(window);
