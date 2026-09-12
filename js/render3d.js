/*
 * render3d.js — Three.js viewport: stove, pan, patty (custom lathe with cutaway),
 * canvas-generated meat textures driven by the physics state, particles for steam,
 * smoke, spatter, sizzle bubbles, juice beads and fat drips, and orbit/zoom controls.
 */
(function (root) {
  'use strict';
  const T = root.THREE;
  const P = root.BurgerPhysics;
  const VA = root.KitchenAssets;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  const rand = (a, b) => a + Math.random() * (b - a);
  let tintedId = 0; // identifies a mask canvas in the tinted-mask cache


  function bunProfile(R,half) {
    if(half==='top'){
      const p=[{r:0,y:0,v:0},{r:R*.96,y:0,v:.08},{r:R,y:.003,v:.18}];
      for(let i=0;i<=20;i++){const a=i/20*Math.PI/2;p.push({r:R*Math.cos(a),y:.004+.021*Math.sin(a),v:.18+.82*i/20});}
      return p;
    }
    return half === 'top'
        ? [{ r: 0, y: 0, v: 0 }, { r: R * 0.97, y: 0, v: 0.15 }, { r: R, y: 0.006, v: 0.3 }, { r: R * 0.93, y: 0.013, v: 0.5 }, { r: R * 0.72, y: 0.02, v: 0.7 }, { r: R * 0.4, y: 0.024, v: 0.85 }, { r: 0, y: 0.025, v: 1 }]
        : [{ r: 0, y: 0, v: 0 }, { r: R * 0.92, y: 0, v: 0.2 }, { r: R, y: 0.007, v: 0.4 }, { r: R * 0.98, y: 0.017, v: 0.6 }, { r: R * 0.85, y: 0.022, v: 0.8 }, { r: 0, y: 0.022, v: 1 }];
  }
  function crumbTexture(seed=41) {
    const cv=document.createElement('canvas');cv.width=cv.height=256;const c=cv.getContext('2d');
    c.fillStyle='#fff5df';c.fillRect(0,0,256,256);
    const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    for(let i=0;i<1600;i++) {
      const x=rnd()*256,y=rnd()*256,r=.4+Math.pow(rnd(),3)*3.4;
      c.fillStyle=`rgba(128,97,53,${.10+rnd()*.22})`;
      c.beginPath();c.ellipse(x,y,r,r*(.4+rnd()*.7),rnd()*3,0,Math.PI*2);c.fill();
      c.fillStyle='rgba(255,255,255,.4)';c.fillRect(x-r,y+r,r*1.5,.5);
    }
    const tex=new T.CanvasTexture(cv);tex.encoding=T.sRGBEncoding;return tex;
  }
  function lettuceGeometry(radius,phase) {
    const rings=9,segments=48,pos=[],col=[],idx=[];
    for(let j=0;j<=rings;j++)for(let i=0;i<=segments;i++) {
      const u=j/rings,a=i/segments*Math.PI*2;
      const lobes=1+.12*Math.sin(a*5+phase)+.045*Math.sin(a*13+phase);
      const r=radius*u*lobes;
      const fold=Math.sin(a*7+phase)*.0018*u*u+Math.sin(u*19+a*4)*.0008*u;
      pos.push(Math.cos(a)*r, .002*(1-u*u)+fold,Math.sin(a)*r*.77);
      const vein=Math.pow(Math.max(0,Math.cos(a*7+u*2)),20)*.19;
      col.push(.20+vein+.07*u,.39+vein+.09*u,.075+vein*.6);
      if(j<rings&&i<segments){const k=j*(segments+1)+i;idx.push(k,k+segments+1,k+1,k+1,k+segments+1,k+segments+2);}
    }
    const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pos,3));g.setAttribute('color',new T.Float32BufferAttribute(col,3));g.setIndex(idx);g.computeVertexNormals();return g;
  }
  function sauceGeometry(radius,height,phase) {
    const g=new T.CylinderGeometry(radius,radius*.96,height,64,2),a=g.attributes.position;
    for(let i=0;i<a.count;i++) {
      const x=a.getX(i),z=a.getZ(i),theta=Math.atan2(z,x),r=Math.hypot(x,z)/radius;
      const edge=1+.09*Math.sin(theta*3+phase)+.035*Math.cos(theta*7-phase);
      a.setXYZ(i,x*edge,a.getY(i)+(1-r)*height*.3,z*edge);
    }
    g.computeVertexNormals();return g;
  }

  // ------------------------------------------------------------ colour model
  const COL = {
    frozen: [190, 120, 130], raw: [177, 53, 61], rawWarm: [184, 65, 70], pink: [205, 118, 118],
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
  function minceFat(size,count){
    const cv=document.createElement('canvas');cv.width=cv.height=size;const c=cv.getContext('2d');
    let seed=8291;const rnd=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
    c.lineCap='round';
    for(let i=0;i<count;i++){
      const x=rnd()*size,y=rnd()*size,a=rnd()*6.28,len=(1+Math.pow(rnd(),2)*8)*size/512;
      c.strokeStyle=`rgba(255,255,255,${.25+rnd()*.65})`;c.lineWidth=(.5+rnd()*1.5)*size/512;
      c.beginPath();c.moveTo(x,y);c.quadraticCurveTo(x+Math.cos(a+.6)*len*.6,y+Math.sin(a+.6)*len*.6,x+Math.cos(a)*len,y+Math.sin(a)*len);c.stroke();
    }return cv;
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
    const nb = 10, ns = 16, nt = 12, bevel=Math.min(.0025,h*.18);
    const cup = dome * 0.12 * h; // bottom lifts at centre when the patty domes
    const capB = { ...BANDS.bottomCap, R: R * 1.06 }, capT = { ...BANDS.topCap, R: R * 1.06 };
    for (let i = 0; i <= nb; i++) { const t = i / nb; const r = (R-bevel) * t; const y = cup * (1 - t * t); pr.push({ r, y: y, cap: capB }); }
    for (let i = 0; i <= ns; i++) { const t = i / ns; const edge = bevel*(1-Math.pow(Math.sin(t*Math.PI),.35)); pr.push({ r: R-edge, y: t * h, v: lerp(BANDS.side[0], BANDS.side[1], t) }); }
    for (let i = 0; i <= nt; i++) {
      const t = i / nt; const r = (R-bevel) * (1 - t);
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

  // ------------------------------------------------------------ giving the GPU its memory back
  // Three keeps a geometry's buffers, a material's compiled program and every texture on the GPU
  // until something disposes them; removing a mesh from the scene frees nothing. One patty carries
  // a 1024² atlas, a 256² roughness map and a 512×256 cut face — about 6 MB of texture with mips —
  // so a form slider rebuilding its preview thirty times a second would otherwise leak ~180 MB a
  // second, and every ticket of a six-ticket shift would leave its patties and toppings behind.
  const MAPS = ['map', 'roughnessMap', 'metalnessMap', 'normalMap', 'bumpMap', 'alphaMap', 'emissiveMap', 'aoMap', 'lightMap', 'specularMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'displacementMap', 'envMap'];
  /**
   * Free every geometry, material and texture under `obj`. Anything in `keep` is shared with
   * something still on screen (the pan's material outlives the pan mesh it was built for) and is
   * left alone. Each unique resource is disposed once, so a geometry two meshes share — the
   * kettle's bowl, drawn again from the inside — is not double-freed.
   */
  function disposeTree(obj, keep) {
    if (!obj) return;
    const geos = new Set(), mats = new Set();
    obj.traverse((o) => {
      if (o.geometry) geos.add(o.geometry);
      if (o.material) { if (Array.isArray(o.material)) for (const m of o.material) mats.add(m); else mats.add(o.material); }
      if (o.isInstancedMesh && o.dispose) o.dispose(); // and the instance matrix / colour buffers
    });
    for (const g of geos) if (!(keep && keep.has(g))) g.dispose();
    for (const m of mats) {
      if (keep && keep.has(m)) continue;
      for (const k of MAPS) { const t = m[k]; if (t && t.isTexture && !VA?.shared.has(t) && !(keep && keep.has(t))) t.dispose(); }
      m.dispose();
    }
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
      this.vp = vp; this.p = p; this.lastFlips = p.flips; this.flipElapsed = null;
      this.group = new T.Group(); vp.scene.add(this.group);
      this.atlas = document.createElement('canvas'); this.atlas.width = 1024; this.atlas.height = 1024;
      this.atlasTex = new T.CanvasTexture(this.atlas); this.atlasTex.anisotropy = 8;
      this.atlasTex.encoding=T.sRGBEncoding;
      this.roughCv = document.createElement('canvas'); this.roughCv.width = 256; this.roughCv.height = 256;
      this.roughTex = new T.CanvasTexture(this.roughCv);
      this.cut = document.createElement('canvas'); this.cut.width = 512; this.cut.height = 256;
      this.cutTex = new T.CanvasTexture(this.cut);
      this.cutTex.encoding=T.sRGBEncoding;
      this.mat = new T.MeshPhysicalMaterial({ map: this.atlasTex, roughnessMap: this.roughTex, roughness: 0.75, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.5 });
      this.mat.bumpMap=VA.texture('mince').relief;this.mat.bumpScale=.00065;
      this.cutMat = new T.MeshStandardMaterial({ map: this.cutTex, roughness: 0.6, side: T.DoubleSide });
      this.mesh = new T.Mesh(new T.BufferGeometry(), this.mat); this.mesh.castShadow = true; this.mesh.receiveShadow = true; this.mesh.userData.patty = p; this.group.add(this.mesh);
      this.cutMesh = new T.Mesh(new T.BufferGeometry(), this.cutMat); this.cutMesh.visible = false; this.cutMesh.castShadow = true; this.cutMesh.userData.patty = p; this.group.add(this.cutMesh);
      this.cheeseMeshes = []; this.underMeshes = []; this.bunGroup = null; this.bunTop = null; this.served = false;
      this.cutaway = false; this.cutPhi = 0; this.lastGeo = null; this.forceTex = true; this.texClock = 0;
      this.rebuildGeometry(true); this.paintTextures();
    }
    /** Off the scene and off the GPU: the atlas, the roughness and cut textures, the lathe, the
     *  cut face, the cheese, the buns and their crumb textures all go back. */
    dispose() { this.vp.scene.remove(this.group); disposeTree(this.group); }
    setCutaway(on, phi) { this.cutaway = on; if (on) this.cutPhi = phi; this.rebuildGeometry(true); this.forceTex = true; }
    rebuildGeometry(force) {
      const p = this.p, R = p.D / 2, h = p.h, dome = p.dome;
      const raw = 1 - clamp(P.gridMean(p, p.dM) * 1.2, 0, 1);
      const key = [R.toFixed(4), h.toFixed(4), dome.toFixed(2), raw.toFixed(2), this.cutaway, this.served].join('|');
      if (!force && key === this.lastGeo) return; this.lastGeo = key;
      const prof = pattyProfile(R, h, dome, p.dimple, raw);
      const phi = this.cutaway ? Math.PI : Math.PI * 2;
      this.mesh.geometry.dispose(); this.mesh.geometry = buildLathe(prof, 96, phi, this.cutaway ? this.cutPhi : 0);
      // Hand-formed edges. Leave cut boundaries intact so the cross-section still seals.
      const vertices=this.mesh.geometry.attributes.position;
      for(let i=0;i<vertices.count;i++){
        const x=vertices.getX(i),z=vertices.getZ(i),r=Math.hypot(x,z),a=Math.atan2(z,x),edge=smoothstep(R*.7,R,r);
        const border=this.cutaway?Math.sin((i%97)/96*Math.PI):1;
        const f=1+edge*border*(.012*Math.sin(a*7+p.id)+.007*Math.sin(a*17+vertices.getY(i)*190));
        vertices.setXYZ(i,x*f,vertices.getY(i),z*f);
      }
      this.mesh.geometry.computeVertexNormals();
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
      if (this.bunGroup) { g.remove(this.bunGroup); disposeTree(this.bunGroup); } // the crumb textures are built fresh every time
      const bg = new T.Group(); this.bunGroup = bg; g.add(bg);
      const bf = p.bunFaces || {};
      this.bunBottomH = bf.bottom ? 0.022 : 0; this.bunTop = null;
      if (!bf.bottom && !bf.top) return;
      const Rb = Math.max(0.05, (p.D / 2) * 0.96);
      const crust = new T.MeshStandardMaterial({ color: 0xc98a45, roughness: 0.75 });
      const crumbTex = (soak, toast, cutAtTop) => {
        const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128; const c = cv.getContext('2d');
        c.fillStyle = '#f3e4c4'; c.fillRect(0, 0, 256, 128);
        c.globalCompositeOperation = 'multiply'; c.globalAlpha = 0.35; c.drawImage(vp.noiseFine, 0, 0, 256, 128); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
        for (let i = 0; i < 260; i++) { c.fillStyle = `rgba(200,170,120,${0.3 + Math.random() * 0.4})`; c.beginPath(); c.ellipse(Math.random() * 256, Math.random() * 128, 1 + Math.random() * 3, 1 + Math.random() * 2, Math.random() * 3, 0, Math.PI * 2); c.fill(); }
        if (soak > 0) { const gr = c.createLinearGradient(0, 0, 0, 128); gr.addColorStop(0, `rgba(120,50,40,${clamp(soak / 0.006, 0, 0.75)})`); gr.addColorStop(0.7, 'rgba(120,50,40,0)'); c.fillStyle = gr; c.fillRect(0, 0, 256, 128); }
        // the toasted cut face: a hard band of crust colour right at the cut, over a few
        // millimetres of crumb that dried out behind it
        if (toast && toast.brown > 0.15) {
          const col = itemFaceColour(toast, ICOL.crumb, 0.5), y0 = cutAtTop ? 0 : 128;
          const gr = c.createLinearGradient(0, y0, 0, cutAtTop ? 26 : 102);
          gr.addColorStop(0, rgb(col)); gr.addColorStop(0.45, `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},0.55)`); gr.addColorStop(1, `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},0)`);
          c.fillStyle = gr; c.fillRect(0, cutAtTop ? 0 : 102, 256, 26);
        }
        const t = new T.CanvasTexture(cv); t.wrapS = t.wrapT = T.ClampToEdgeWrapping; return t;
      };
      const phi = this.cutaway ? Math.PI : Math.PI * 2, phiStart = this.cutaway ? this.cutPhi : 0;
      const half = (prof, y0, soak, toast, cutAtTop) => {
        const hgrp = new T.Group(); hgrp.position.y = y0;
        const m = new T.Mesh(buildLathe(prof, 72, phi, phiStart), crust); m.castShadow = true; m.receiveShadow = true; hgrp.add(m);
        if (this.cutaway) {
          const hh = Math.max(...prof.map((q) => q.y)), rr = Math.max(...prof.map((q) => q.r));
          const tex = crumbTex(soak, toast, cutAtTop); tex.repeat.set(1 / (2 * rr), 1 / hh); tex.offset.set(0.5, 0);
          const face = new T.Mesh(new T.ShapeGeometry(crossSectionShape(prof), 3), new T.MeshStandardMaterial({ map: tex, roughness: 0.9, side: T.DoubleSide }));
          face.rotation.y = -phiStart; hgrp.add(face);
        }
        bg.add(hgrp); return hgrp;
      };
      const bottom = [{ r: 0, y: 0, v: 0 }, { r: Rb * 0.92, y: 0, v: 0.2 }, { r: Rb, y: 0.007, v: 0.4 }, { r: Rb * 0.98, y: 0.017, v: 0.6 }, { r: Rb * 0.85, y: 0.022, v: 0.8 }, { r: 0, y: 0.022, v: 1 }];
      const top = [{ r: 0, y: 0, v: 0 }, { r: Rb * 0.97, y: 0, v: 0.15 }, { r: Rb, y: 0.006, v: 0.3 }, { r: Rb * 0.93, y: 0.013, v: 0.5 }, { r: Rb * 0.72, y: 0.02, v: 0.7 }, { r: Rb * 0.4, y: 0.024, v: 0.85 }, { r: 0, y: 0.025, v: 1 }];
      // Only draw the halves that were actually included in the served build.
      if (bf.bottom) half(bottom, -this.bunBottomH, p.bunSoak || 0, bf.bottom, true);
      if (!bf.top) return;
      this.bunTop = half(top, 0, 0, bf.top, false);
      const seedGeo = new T.SphereGeometry(1, 6, 5); const seedMat = VA.material('bread',0xdcc59a);
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
      c.globalAlpha=.7;c.drawImage(VA.texture('mince').map.image,0,0,W,H);c.globalAlpha=1;
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
      };
      /**
       * The bars and the torn patches, which do not wait for the rest of the face. On a grate only
       * a tenth of the face touches metal, so the bar track runs far ahead of the area mean: at the
       * README's 45 s cadence a face goes up with marks at 0.5 and a mean browning of 0.10, and a
       * cook looking down at it sees the bars, not raw meat. Torn crust is the same: it is a hole
       * in the face, visible whether or not the rest of it has coloured.
       */
      const paintMarks = (face, rg) => {
        if (face.torn > 0) tintMask(vp.marbleCut, [150, 60, 60], clamp(face.torn * 3, 0, 0.8), rg);
        if (face.marks > 0.2) {
          const cx = (rg.x0 + rg.x1) / 2, cy = (rg.y0 + rg.y1) / 2;
          const mc = faceColour({ brown: face.marks, char: face.marksChar || 0 }, [90, 55, 30]);
          c.save(); c.beginPath(); c.arc(cx, cy, capR, 0, Math.PI * 2); c.clip(); c.translate(cx, cy); c.rotate(face.marksAngle || 0.6);
          // the bar is not a veil over the meat: the strip it pressed on really is at that browning
          // index, so the paint is close to opaque as soon as the mark has any colour in it. What is
          // left of the transparency is the soft shoulder either side of a 6 mm rod.
          c.fillStyle = rgb(mc); c.globalAlpha = clamp(face.marks / 0.7, 0, 0.92);
          for (let x = -capR; x < capR; x += capR * 0.28) c.fillRect(x - capR * 0.035, -capR, capR * 0.07, 2 * capR);
          c.restore();
        }
      };
      crustSpots(p.faceDown, bb); if (!rawTop) crustSpots(p.faceUp, bt);
      paintMarks(p.faceDown, bb); paintMarks(p.faceUp, bt);
      // the slit a peek leaves: a knife went all the way through, so the line shows on both caps,
      // dark where the wet inside of the patty is open to the air
      if (p.slits) {
        const inner = mix3(nodeColour(p, Math.floor(p.Nz / 2), 0), [40, 16, 16], 0.45);
        for (const rg of [bb, bt]) {
          const cx = (rg.x0 + rg.x1) / 2, cy = (rg.y0 + rg.y1) / 2;
          c.save(); c.beginPath(); c.arc(cx, cy, capR, 0, Math.PI * 2); c.clip(); c.translate(cx, cy); c.rotate(p.slitAngle || 0);
          for (let n = 0; n < Math.min(3, p.slits); n++) {
            c.fillStyle = rgb(inner); c.globalAlpha = 0.95;
            c.fillRect(-capR, -capR * 0.022 + n * capR * 0.14, 2 * capR, capR * 0.044); // a 2 mm gape across a 5 cm cap
            c.fillStyle = 'rgba(0,0,0,0.62)'; c.fillRect(-capR, -capR * 0.011 + n * capR * 0.14, 2 * capR, capR * 0.022); // and the shadow down inside it
          }
          c.globalAlpha = 1; c.restore();
        }
      }
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
      out[i++] = q(p.poolTop, 2e-6); out[i++] = q(p.fatTop, 2e-6); out[i++] = q(p.cheeses.length, 1); out[i++] = q(p.slits || 0, 1);
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
      this.group.scale.set(1,1,1);
      const p = this.p, g = this.group;
      if (p.flips !== this.lastFlips) {
        this.lastFlips = p.flips;
        if (where === 'pan') { this.flipElapsed = 0; this.forceTex = true; }
      }
      if (where !== 'pan') this.flipElapsed = null;
      this.texClock += dt;
      if (where === 'pan') g.position.set(position.x, this.vp.panFloorY + 0.0012 * p.cheeseUnder.length + (position.lift || 0), position.z);
      else if (where === 'board') g.position.set(position.x, 0, position.z);
      else {
        const served = where === 'cut' && !p.manualAssembly;
        if (served !== this.served) { this.served = served; if (served) this.buildBuns(); else if (this.bunGroup) { g.remove(this.bunGroup); disposeTree(this.bunGroup); this.bunGroup = null; } }
        g.position.set(position.x, position.y + (served ? this.bunBottomH : 0), position.z);
        if (this.bunTop) this.bunTop.position.y = p.h * (1 + 0.28 * p.dome) + p.cheeses.length * 0.0015 + (this.stackH || 0) + 0.001;
      }
      this.rebuildGeometry(false);
      // Repaint at most ten times a second, and only when the meat actually looks different:
      // resting, plated or paused, nothing moves and the atlas is left alone entirely.
      if (this.forceTex) { this.texClock = 0; this.forceTex = false; this.texDirty(); this.texCommit(); this.paintTextures(); }
      else if (this.texClock > 0.1 && this.texDirty() && this.vp.claimTexBudget()) { this.texClock = 0; this.texCommit(); this.paintTextures(); }
      this.updateCheese();
      // Physics swaps the faces immediately. Rotate the new pose back to the old face,
      // then arc it into its final pose around the patty's centre, not its bottom edge.
      g.rotation.z = 0;
      if (this.flipElapsed != null) {
        this.flipElapsed += dt;
        const u = clamp(this.flipElapsed / .65, 0, 1), ease = u*u*(3-2*u);
        const angle = -Math.PI * (1-ease), mid = p.h / 2;
        g.rotation.z = angle;
        g.position.x += Math.sin(angle) * mid;
        g.position.y += mid * (1-Math.cos(angle)) + .09 * Math.sin(Math.PI*u);
        if (u === 1) this.flipElapsed = null;
      }
    }
    updateCheese() {
      const p=this.p,g=this.group,CM=root.CheeseMesh;
      const plane=this.cheesePlane||(this.cheesePlane=new T.Plane());
      plane.normal.set(-Math.sin(this.cutPhi||0),0,Math.cos(this.cutPhi||0));plane.constant=-plane.normal.dot(g.position);
      const yellow=lin([243,183,61]),melted=lin([249,187,55]),gold=lin([184,107,26]),dark=lin([71,33,13]),char=lin([16,13,10]);
      for(const [slices,meshes,fried] of [[p.cheeses,this.cheeseMeshes,false],[p.cheeseUnder,this.underMeshes,true]]){
        while(meshes.length>slices.length){const mesh=meshes.pop();g.remove(mesh);disposeTree(mesh);}
        while(meshes.length<slices.length){
          const mesh=new T.Mesh(CM.create(),new T.MeshPhysicalMaterial({vertexColors:true,roughness:.5,clearcoat:.3,side:T.DoubleSide}));mesh.castShadow=mesh.receiveShadow=true;g.add(mesh);meshes.push(mesh);
        }
        slices.forEach((ch,k)=>{
          const mesh=meshes[k],sk=ch.skirt||{},mat=mesh.material;
          if(!!mat.clippingPlanes!==this.cutaway)mat.needsUpdate=true;mat.clippingPlanes=this.cutaway?[plane]:null;mat.clipShadows=this.cutaway;
          mesh.rotation.y=ch.rot||0;mesh.position.y=fried?-.0012*slices.length:0;
          const key=[ch.mass??.02,ch.melt||0,p.D,p.h,p.dome,k,fried].join('|');
          if(mesh.userData.shapeKey!==key){CM.update(mesh.geometry,ch,{radius:p.D/2,height:p.h,dome:p.dome,layer:k,fried});mesh.userData.shapeKey=key;}
          const onTop=mix3(yellow,melted,ch.melt||0);
          let skirt=mix3(onTop,gold,clamp((sk.brown||0)/2.5,0,1));skirt=mix3(skirt,dark,clamp(((sk.brown||0)-2.5)/3,0,1));skirt=mix3(skirt,char,clamp((sk.char||0)/.8,0,1));
          const pos=mesh.geometry.attributes.position,col=mesh.geometry.attributes.color;
          for(let i=0;i<pos.count;i++){
            const contact=fried||ch.submerged||ch.fried?1:1-smoothstep(.0015+k*.0011,.0045+k*.0011,pos.getY(i));
            for(let c=0;c<3;c++)col.array[i*3+c]=lerp(onTop[c],skirt[c],contact);
          }
          col.needsUpdate=true;mat.roughness=clamp(.55-.38*(ch.melt||0)+.35*(sk.dry||0),.12,.95);mat.clearcoat=.3*(1-(sk.dry||0));
        });
      }
    }
  }

  // ------------------------------------------------------------ pan items (the toppings)
  // Every colour here is read off the same state the physics scores: a bun's cut face follows its
  // browning index through the crust ramp and then to carbon, bacon runs from raw pink through
  // rendered gold to black while it shortens and curls by its own shrink and curl numbers, the
  // egg's white goes from translucent to opaque on its set index, and the onion heap darkens and
  // shrinks on caramelisation and water lost. Nothing here is on a timer.
  const ICOL = {
    crumb: [238, 222, 190], crust: [201, 138, 69],
    baconLean: [164, 64, 57], baconFat: [222, 199, 173], baconDone: [150, 74, 38], baconCrisp: [104, 48, 22],
    whiteRaw: [232, 236, 232], whiteSet: [252, 250, 245],
    yolkRaw: [232, 146, 28], yolkSet: [236, 188, 96],
    onionRaw: [238, 232, 216], onionGold: [206, 154, 78], onionBrown: [128, 72, 30], onionDark: [58, 34, 16],
    char: [16, 14, 12],
  };
  /**
   * The renderer writes sRGB out, but vertex and instance colours go into the shader as they are —
   * i.e. as linear values. A colour picked by eye in 0–255 sRGB has to be de-gamma'd on the way in
   * or it comes out washed out and pale (bacon the colour of ham).
   */
  function lin(c) { return [Math.pow(c[0] / 255, 2.2), Math.pow(c[1] / 255, 2.2), Math.pow(c[2] / 255, 2.2)]; }
  function setLin(mat, c) { const l = lin(c); mat.color.setRGB(l[0], l[1], l[2]); }
  /** Colour of a browning face: the crust ramp the meat uses, over whatever the raw colour was. */
  function itemFaceColour(face, base, charAt) {
    const b = clamp(face.brown, 0, 7), i = Math.floor(b), t = b - i;
    let c = mix3(COL.brown[i], COL.brown[Math.min(7, i + 1)], t);
    c = mix3(base, c, clamp(b / 0.8, 0, 1));
    return mix3(c, ICOL.char, clamp(face.char / (charAt || 0.6), 0, 1));
  }

  class ItemView {
    constructor(vp, it) {
      this.vp = vp; this.it = it;
      this.group = new T.Group(); vp.scene.add(this.group);
      this.group.userData.item = it;
      this.thickness = { bun: it.half==='top'?.025:.022, bacon: 0.006, egg: 0.013, onions: 0.009 }[it.kind] || 0.006;
      ({ bun: () => this.buildBun(), bacon: () => this.buildBacon(), egg: () => this.buildEgg(), onions: () => this.buildOnions() }[it.kind] || (() => {}))();
      this.group.traverse((o) => { o.userData.item = it; }); // so a click anywhere on it selects it
    }
    dispose() { this.vp.scene.remove(this.group); disposeTree(this.group); }
    /**
     * How tall this topping actually stands on the burger, so whatever goes on top of it rests on
     * it: every mesh in here is built with its underside at the group's origin. `thickness` is the
     * slab it occupies lying flat on the metal; this is the same number with the shape the thing
     * has taken — a set yolk stands ~22 mm proud of the pan while a runny one that has slumped
     * stands ~12, an onion heap cooks down to about half, and a curled rasher holds the layer above
     * it up: not by the 15 mm its free ends reach, but by about a third of that, because the egg
     * and the crown press them back down.
     */
    layerH() {
      const it = this.it;
      if (it.kind === 'egg') { const set = clamp(it.yolkSet, 0, 1); return 0.0035 + 0.004 * set + 0.021 * (0.42 + 0.28 * set) + 0.0005; } // yolk centre + its own half-height
      if (it.kind === 'bacon') return .004 + .010 * Math.abs(clamp(it.curl, -1, 1));
      if (it.kind === 'onions') return 0.0016 + 0.009 * (0.55 + 0.45 * clamp((it.bot.w + it.top.w) / it.w0, 0, 1));
      return this.thickness;
    }
    /**
     * In the cutaway the burger is sliced along the plane facing the camera; a topping sitting on
     * it has to be sliced the same way or it hides the cross-section it is supposed to sit on.
     * The patty does it by building half a lathe; these are cut with a real clipping plane.
     *
     * The plane moves with the camera, so each view keeps its own and the values are written into
     * it: only the on/off transitions reach setClip, which bumps every material's version and makes
     * three re-initialise its program on the next draw.
     */
    setClipAt(nx, nz, px, pz) {
      const pl = this.clipPlane || (this.clipPlane = new T.Plane(new T.Vector3(0, 1, 0), 0));
      pl.normal.set(nx, 0, nz); pl.constant = -(nx * px + nz * pz);
      if (this.clip !== pl) this.setClip(pl);
    }
    setClip(plane) {
      if (plane === this.clip) return; this.clip = plane;
      this.group.traverse((o) => { if (o.isMesh && o.material) { o.material.clippingPlanes = plane ? [plane] : null; o.material.clipShadows = !!plane; o.material.needsUpdate = true; } });
    }
    // ---- bun half: a domed crown over a flat cut face, and the cut face is the one that toasts
    buildBun() {
      const R = this.it.D / 2;
      const prof=bunProfile(R,this.it.half);
      this.crustMat = VA.material('bread',0xc98a45);
      const dome = new T.Mesh(buildLathe(prof, 80, Math.PI * 2), this.crustMat); dome.castShadow = true; dome.receiveShadow = true;
      this.group.add(dome);
      const crumb=crumbTexture(this.it.id+41);
      this.faceMat = new T.MeshStandardMaterial({ color: 0xeedebe, map:crumb,bumpMap:crumb,bumpScale:.00035,roughness: 0.85, side: T.DoubleSide });
      const face = new T.Mesh(new T.CircleGeometry(R * 0.985, 40), this.faceMat);
      face.rotation.x = Math.PI / 2; face.position.y = 0.0004; // the cut plane, facing down
      this.group.add(face); this.faceMesh = face;
      if (this.it.half === 'top') {
        const seedGeo = new T.SphereGeometry(1, 6, 5), seedMat = VA.material('bread',0xdcc59a);
        let sd = 13 + this.it.id; const rnd = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; };
        for (let i = 0; i < 40; i++) {
          const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * R * 0.85;
          const sm = new T.Mesh(seedGeo, seedMat);
          sm.position.set(Math.cos(a) * rr, .004+.021*Math.sqrt(1-(rr/R)**2)+.0005, Math.sin(a) * rr);
          sm.scale.set(0.0016, 0.0009, 0.0011); sm.rotation.y = rnd() * 3; this.group.add(sm);
        }
      }
    }
    // ---- a rasher: a ribbon that shortens and curls, striped lean and fat along its length
    buildBacon() {
      const NL = 48, NW = 18;
      const pos = new Float32Array(NL * NW * 6), col = new Float32Array(NL * NW * 6), nor = new Float32Array(NL * NW * 6);
      const idx = [];
      for (let i = 0; i < NL - 1; i++) for (let j = 0; j < NW - 1; j++) { const a = i * NW + j; idx.push(a, a + NW, a + 1, a + 1, a + NW, a + NW + 1); }
      const count=NL*NW, top=idx.slice();
      for(let n=0;n<top.length;n+=3)idx.push(top[n]+count,top[n+2]+count,top[n+1]+count);
      const edge=[];
      for(let i=0;i<NL;i++)edge.push(i*NW);
      for(let j=1;j<NW;j++)edge.push((NL-1)*NW+j);
      for(let i=NL-2;i>=0;i--)edge.push(i*NW+NW-1);
      for(let j=NW-2;j>0;j--)edge.push(j);
      for(let i=0;i<edge.length;i++){const a=edge[i],b=edge[(i+1)%edge.length];idx.push(a,b,a+count,b,b+count,a+count);}
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('color', new T.BufferAttribute(col, 3));
      g.setAttribute('normal', new T.BufferAttribute(nor, 3));
      g.setIndex(idx);
      this.baconGeo = g; this.NL = NL; this.NW = NW;
      const uv=new Float32Array(NL*NW*4);for(let side=0;side<2;side++)for(let i=0;i<NL;i++)for(let j=0;j<NW;j++){const k=(side*NL*NW+i*NW+j)*2;uv[k]=j/(NW-1);uv[k+1]=i/(NL-1);}
      g.setAttribute('uv',new T.BufferAttribute(uv,2));
      const m = new T.Mesh(g, new T.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.3, side: T.DoubleSide }));
      m.material.bumpMap=VA.texture('mince').relief;m.material.bumpScale=.00012;
      m.castShadow = true; m.frustumCulled = false; // its vertices move every frame; the bounding sphere would be a stale point at the origin
      this.baconMesh = m; this.group.add(m);
    }
    // ---- a fried egg: a lumpy sheet of white with a lace rim and a yolk dome
    buildEgg() {
      const R = this.it.D / 2, N = 48;
      const shape = [];
      let sd = 5 + this.it.id; const rnd = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; };
      // the white never runs out in a circle: a few low-frequency lobes where it ran, not a saw edge
      const p1 = rnd() * 6.3, p2 = rnd() * 6.3;
      for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; shape.push(0.90 + 0.07 * Math.sin(3 * a + p1) + 0.05 * Math.sin(5 * a + p2) + 0.02 * rnd()); }
      this.eggShape = shape;
      const pos = new Float32Array((N * 2 + 1) * 3), idx = [];
      for (let i = 0; i < N; i++) { const a = 1 + i * 2, b = a + 1, c = 1 + ((i+1)%N)*2, d = c+1; idx.push(0, a, c, a, b, d, a, d, c); }
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setIndex(idx);
      this.whiteGeo = g; this.eggN = N; this.eggR = R;
      this.whiteMat = new T.MeshPhysicalMaterial({ color: 0xf6f6f2, roughness: 0.35, clearcoat: 0.6, transparent: true, opacity: 0.75, side: T.DoubleSide });
      const w = new T.Mesh(g, this.whiteMat); w.castShadow = true; w.frustumCulled = false; // the white spreads as it sets, so its bounds move
      this.whiteMesh = w; this.group.add(w);
      // the lace is the last few millimetres of the white, so it follows exactly the same wobbly
      // outline: a ribbon laid on the rim, not a ring drawn around it
      this.laceMat = new T.MeshStandardMaterial({ color: 0xd9a066, roughness: 0.5, side: T.DoubleSide });
      const lpos = new Float32Array(N * 2 * 3), lidx = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2, w = shape[i], k = i * 6;
        lpos[k] = Math.cos(a) * R * w * 0.80; lpos[k + 1] = 0.0011; lpos[k + 2] = Math.sin(a) * R * w * 0.80;
        lpos[k + 3] = Math.cos(a) * R * w * 1.004; lpos[k + 4] = 0.0009; lpos[k + 5] = Math.sin(a) * R * w * 1.004;
        const j = ((i + 1) % N) * 2, v = i * 2;
        lidx.push(v, v + 1, j, j, v + 1, j + 1);
      }
      const lg = new T.BufferGeometry(); lg.setAttribute('position', new T.BufferAttribute(lpos, 3)); lg.setIndex(lidx); lg.computeVertexNormals();
      const lace = new T.Mesh(lg, this.laceMat);
      this.laceMesh = lace; this.group.add(lace);
      this.yolkMat = new T.MeshPhysicalMaterial({ color: 0xe8921c, roughness: 0.25, clearcoat: 0.8, clearcoatRoughness: 0.15 });
      const y = new T.Mesh(new T.SphereGeometry(.021,40,20,0,Math.PI*2,0,Math.PI/2), this.yolkMat);
      y.scale.set(1, 0.55, 1); y.castShadow = true; this.yolkMesh = y; this.group.add(y);
    }
    // ---- sliced onion: a heap of curved slivers that shrink, slump and darken. Each one is a
    // ribbon cut from a ring — which is what a slice of onion is — lying flat in the pile.
    buildOnions() {
      const N = 110, NA = 16;
      const pos = new Float32Array(NA * 2 * 3), idx = [];
      for (let i = 0; i < NA; i++) {
        const a = (i / (NA - 1) - 0.5) * 2.3, c = Math.cos(a), s = Math.sin(a);
        const k = i * 6, sag = 0.10 * (1 - ((i / (NA - 1) - 0.5) * 2) ** 2); // the sliver lifts a little in the middle
        pos[k] = c * 0.72; pos[k + 1] = sag * 0.5; pos[k + 2] = s * 0.72;
        pos[k + 3] = c; pos[k + 4] = sag; pos[k + 5] = s;
        if (i < NA - 1) { const v = i * 2; idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3); }
      }
      const geo = new T.BufferGeometry(),solid=new Float32Array(pos.length*2),count=pos.length/3;
      solid.set(pos);solid.set(pos,pos.length);
      for(let i=0;i<count;i++)solid[i*3+1]+=.045;
      const faces=idx.slice();for(let i=0;i<idx.length;i+=3)faces.push(idx[i]+count,idx[i+2]+count,idx[i+1]+count);
      const edge=[];for(let i=0;i<NA;i++)edge.push(i*2);for(let i=NA-1;i>=0;i--)edge.push(i*2+1);
      for(let i=0;i<edge.length;i++){const a=edge[i],b=edge[(i+1)%edge.length];faces.push(a,b,a+count,b,b+count,a+count);}
      geo.setAttribute('position', new T.BufferAttribute(solid, 3)); geo.setIndex(faces); geo.computeVertexNormals();
      this.onionMat = new T.MeshPhysicalMaterial({ color: 0xece5d4, roughness: 0.36, clearcoat: 0.65,clearcoatRoughness:.18, side: T.DoubleSide, transparent: true, opacity: 0.87 });
      const inst = new T.InstancedMesh(geo, this.onionMat, N);
      inst.castShadow = true; inst.receiveShadow = true;
      inst.instanceColor = new T.InstancedBufferAttribute(new Float32Array(N * 3).fill(1), 3);
      const dm = new T.Object3D(); const R = this.it.D / 2;
      let sd = 21 + this.it.id; const rnd = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; };
      this.onionSpec = [];
      for (let i = 0; i < N; i++) {
        const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * R * 0.8;
        const lvl = rnd(); // how high in the heap: the low ones are the layer against the metal
        this.onionSpec.push({ a, rr, lvl, len: 0.008 + rnd() * 0.016, rot: rnd() * 6.3, tilt: (rnd() - 0.5) * 0.5, low: lvl < 0.4 });
      }
      this.onionInst = inst; this.onionDummy = dm; this.group.add(inst);
    }
    /** Per-frame: where it is, and what it looks like now. */
    update(state, dt, where, pos, opts) {
      const it = this.it, g = this.group;
      g.scale.set(1,1,1);
      g.position.set(pos.x, pos.y, pos.z);
      g.visible = !(it.kind === 'bun' && where === 'cut'); // a served bun is drawn as part of the burger
      if (!g.visible) return;
      ({ bun: () => this.paintBun(where), bacon: () => this.paintBacon(where), egg: () => this.paintEgg(where), onions: () => this.paintOnions(where) }[it.kind] || (() => {}))();
    }
    paintBun(where) {
      const it = this.it, g = this.group;
      // cut side down while it is toasting; turned over, the crown is on the metal
      const cutDown = it.faceIsCut && where === 'pan';
      g.rotation.x = cutDown ? 0 : Math.PI;
      g.position.y += cutDown ? 0 : this.thickness;
      const f = it.cutFace;
      setLin(this.faceMat, itemFaceColour(f, ICOL.crumb, 0.5));
      this.faceMat.roughness = clamp(0.85 - 0.25 * f.crisp, 0.4, 1) - 0.2 * clamp(it.fatSoaked / 0.003, 0, 1);
      const soaked=clamp((it.absorbedWater||0)/.008,0,1);
      this.faceMat.color.multiplyScalar(1-.18*soaked);this.faceMat.roughness=Math.max(.25,this.faceMat.roughness-.3*soaked);
      // the crown scorches too if it is put face up on the metal, but it never browns: no sugars left
      const other = it.cutFace === it.faceDown ? it.faceUp : it.faceDown;
      setLin(this.crustMat, mix3(ICOL.crust, ICOL.char, clamp(other.char / 0.5, 0, 1)));
    }
    paintBacon(where) {
      const it = this.it, NL = this.NL, NW = this.NW;
      const pos = this.baconGeo.attributes.position.array, col = this.baconGeo.attributes.color.array;
      const L = 0.20 * (1 - it.shrink), W = 0.030 * (1 - 0.35 * it.shrink);
      const curl = clamp(it.curl, -1, 1);
      const fatLeft = clamp((it.fs + it.fl + it.fr) / it.fat0, 0, 1);
      const brown = Math.max(it.faceDown.brown, it.faceUp.brown); // both sides colour a rasher
      const lean = mix3(mix3(ICOL.baconLean, ICOL.baconDone, clamp(brown / 2.5, 0, 1)), ICOL.baconCrisp, clamp(it.crisp * 0.8, 0, 1));
      const fat = mix3(ICOL.baconFat, ICOL.baconDone, clamp((1 - fatLeft) * 0.75 + brown / 8, 0, 1));
      const charF = clamp((it.faceDown.char + it.faceUp.char) / 0.7, 0, 1);
      const palettes=it.regions?.map(r=>{
        const b=Math.max(r.faceDown.brown,r.faceUp.brown),f=clamp((r.fs+r.fl+r.fr)/r.fat0,0,1);
        return {lean:mix3(mix3(ICOL.baconLean,ICOL.baconDone,clamp(b/2.5,0,1)),ICOL.baconCrisp,clamp(r.crisp*.8,0,1)),fat:mix3(ICOL.baconFat,ICOL.baconDone,clamp((1-f)*.75+b/8,0,1)),charF:clamp((r.faceDown.char+r.faceUp.char)/.7,0,1)};
      });
      for(let i=0;i<NL;i++)for(let j=0;j<NW;j++) {
        const u=i/(NL-1),v=j/(NW-1),q=root.FoodShapes.baconPoint(u,v,it.shrink,curl,it.id);
        for(let side=0;side<2;side++) {
          const k=(side*NL*NW+i*NW+j)*3;
          pos[k]=q.x;pos[k+1]=q.y+(side?0:.0025*(1-.35*it.shrink));pos[k+2]=q.z;
          const mottling=.92+.08*Math.sin(u*71+v*19+it.id);
          const palette=palettes?.[Math.min(2,Math.floor(u*3))]||{fat,lean,charF};
          const c=lin(mix3(mix3(palette.fat,palette.lean,q.lean),ICOL.char,palette.charF*(.5+.5*q.lean)));
          col[k]=c[0]*mottling;col[k+1]=c[1]*mottling;col[k+2]=c[2]*mottling;
        }
      }
      this.baconGeo.attributes.position.needsUpdate = true;
      this.baconGeo.attributes.color.needsUpdate = true;
      this.baconGeo.computeVertexNormals();
      this.baconMesh.material.roughness = clamp(0.25 + 0.5 * it.crisp - 0.2 * fatLeft, 0.15, 0.9);
      this.baconMesh.material.clearcoat = clamp(0.8 * fatLeft + 0.3 * (1 - it.crisp), 0, 1); // wet with its own fat until it is crisp
      this.group.rotation.y = 0.5 + 0.2 * it.id;
    }
    paintEgg(where) {
      const it = this.it, N = this.eggN, R = this.eggR;
      this.group.rotation.x=it.flipped?Math.PI:0;
      if(it.flipped)this.group.position.y+=this.layerH();
      const pos = this.whiteGeo.attributes.position.array;
      const spread = it.spread, set = it.setTop;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2, w = this.eggShape[i];
        const rr = R * w * (0.62 + 0.38 * spread);
        const inner = (1 + i * 2) * 3, outer = inner + 3;
        pos[inner] = Math.cos(a) * rr * 0.55; pos[inner + 1] = 0.0028 * (1 - 0.3 * set); pos[inner + 2] = Math.sin(a) * rr * 0.55;
        pos[outer] = Math.cos(a) * rr; pos[outer + 1] = 0.0008; pos[outer + 2] = Math.sin(a) * rr;
      }
      pos[0] = 0; pos[1] = 0.0032 * (1 - 0.3 * set); pos[2] = 0;
      this.whiteGeo.attributes.position.needsUpdate = true;
      this.whiteGeo.computeVertexNormals();
      const wc = mix3(ICOL.whiteRaw, ICOL.whiteSet, set);
      const under = itemFaceColour(it.faceDown, wc, 0.5);
      setLin(this.whiteMat, mix3(wc, under, 0.35)); // some of the browned underside shows through at the edges
      this.whiteMat.opacity = lerp(0.6, 1, clamp(set * 1.4, 0, 1)); // raw white is translucent, set white is not
      this.whiteMat.roughness = clamp(0.5 - 0.25 * (1 - set), 0.1, 0.8);
      setLin(this.laceMat, itemFaceColour(it.lace, mix3(ICOL.whiteSet, ICOL.onionGold, 0.2), 0.5));
      this.laceMesh.visible = it.lace.brown > 0.05;
      this.laceMesh.scale.setScalar(0.62 + 0.38 * spread);
      setLin(this.yolkMat, mix3(ICOL.yolkRaw, ICOL.yolkSet, clamp(it.yolkSet, 0, 1)));
      this.yolkMat.roughness = lerp(0.18, 0.75, clamp(it.yolkSet, 0, 1)); // a raw yolk is wet and glossy, a set one is matte
      this.yolkMat.clearcoat = 0.9 * (1 - clamp(it.yolkSet, 0, 1));
      // a runny yolk sits proud; as it sets it stiffens and stops slumping
      this.yolkMesh.scale.set(1 + 0.08 * (1 - it.yolkSet), 0.42 + 0.28 * it.yolkSet, 1 + 0.08 * (1 - it.yolkSet));
      this.yolkMesh.position.y = 0.0035 + 0.004 * it.yolkSet;
      this.yolkMesh.visible = true;
    }
    paintOnions(where) {
      const it = this.it, inst = this.onionInst, dm = this.onionDummy;
      const wet = clamp((it.bot.w + it.top.w) / it.w0, 0, 1);
      const soft = it.soft || 0;
      const shrink = (0.55 + 0.45 * wet) * (1 - 0.18 * soft);           // they cook down to about half
      const colTop = mix3(mix3(mix3(ICOL.onionRaw, [216, 203, 166], soft * .65), ICOL.onionGold, clamp(it.carm / 0.9, 0, 1)), ICOL.onionBrown, clamp((it.carm - 0.9) / 1.3, 0, 1));
      const topC = mix3(colTop, ICOL.char, clamp(it.char / 0.35, 0, 1));
      const colBot = mix3(mix3(ICOL.onionRaw, ICOL.onionGold, clamp(it.carmBot / 0.9, 0, 1)), ICOL.onionDark, clamp((it.carmBot - 0.9) / 2, 0, 1));
      const botC = mix3(colBot, ICOL.char, clamp(it.charBot / 0.6, 0, 1));
      const localColours=it.regions?.map(r=>{
        const top=mix3(mix3(mix3(ICOL.onionRaw,[216,203,166],(r.soft||0)*.65),ICOL.onionGold,clamp(r.carm/.9,0,1)),ICOL.onionBrown,clamp((r.carm-.9)/1.3,0,1));
        const bot=mix3(mix3(ICOL.onionRaw,ICOL.onionGold,clamp(r.carmBot/.9,0,1)),ICOL.onionDark,clamp((r.carmBot-.9)/2,0,1));
        return {top:mix3(top,ICOL.char,clamp(r.char/.35,0,1)),bot:mix3(bot,ICOL.char,clamp(r.charBot/.6,0,1))};
      });
      const c = new T.Color();
      for (let i = 0; i < this.onionSpec.length; i++) {
        const o = this.onionSpec[i];
        const rr = o.rr * (0.72 + 0.28 * wet);
        // as they cook down the heap slumps: the slivers flatten out and lie closer together
        dm.position.set(Math.cos(o.a) * rr, 0.0006 + o.lvl * 0.009 * shrink, Math.sin(o.a) * rr);
        dm.rotation.set(o.tilt * (0.3 + 0.7 * wet) * (1 - .65 * soft), o.rot, o.tilt * 0.4 * wet);
        const len = o.len * shrink;
        dm.scale.set(len, len * (0.35 + 0.35 * wet), len);
        dm.updateMatrix(); inst.setMatrixAt(i, dm.matrix);
        const region=localColours?.[Math.floor(((o.a+Math.PI*2)%(Math.PI*2))/(Math.PI*2)*3)];
        const col = lin(o.low ? region?.bot||botC : region?.top||topC); // the pieces that were against the metal carry its colour
        inst.setColorAt(i, c.setRGB(col[0], col[1], col[2]));
      }
      inst.instanceMatrix.needsUpdate = true; if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      this.onionMat.roughness = clamp(0.25 + 0.5 * (1 - wet), 0.2, 0.85);
      this.onionMat.clearcoat = 0.6 * wet;
      this.onionMat.opacity = clamp(.94-.18*soft+.15*(1-wet),.76,1); // raw slices are glassy; cooked ones are not
    }
  }

  // ------------------------------------------------------------ the viewport
  class Viewport {
    constructor(canvas) {
      this.canvas = canvas;
      this.renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = T.PCFSoftShadowMap;
      this.renderer.localClippingEnabled = true; // the toppings on a served burger are cut with the same plane the patty is
      this.renderer.outputEncoding = T.sRGBEncoding; this.renderer.toneMapping = T.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 0.95;
      this.scene = new T.Scene(); this.scene.background = new T.Color(0xb7d4df);
      this.scene.fog = new T.Fog(0xe4dece, 5, 12);
      this.camera = new T.PerspectiveCamera(42, 1, 0.005, 20);
      this.clock = 0; this.texBudget = 0;
      this.mode = 'board'; // 'board' | 'stove'
      this.cutaway = false;
      this._buildLights(); this._buildKitchen(); this._buildReflections(); this._buildRoomSmoke(); this._buildStove(); this._buildBoard(); this._buildParticles(); this._buildProbe();
      this._buildTextures();
      this.views = new Map(); this.itemViews = new Map(); this.selected = null; this.selectedItem = null; this.previewPatty = null;
      this.peeks = new Map(); // patty → when the cut the cook made in it closes again (wall clock, ms)
      this.controls = new Orbit(this);
      this.resize();
      window.addEventListener('resize', () => this.resize());
      this.setMode('board');
    }
    resize() {
      const w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 600;
      this.renderer.setSize(w, h, false); this.camera.aspect = w / h;
      // Preserve horizontal framing on smaller desktop windows.
      this.camera.fov = 2 * Math.atan(Math.tan(42 * Math.PI / 360) * Math.max(1, 1.25 / this.camera.aspect)) * 180 / Math.PI;
      // No horizontal sidebar offset. Shallow prep/results trays only lift the framing
      // vertically, keeping the food visible above them without moving the orbit target.
      this.camera.clearViewOffset();
      const phase = document.body.dataset.phase;
      const tray = phase === 'form' ? document.getElementById('prep-tray')
        : phase === 'result' ? document.querySelector('#results .receipt') : null;
      if (tray) {
        const covered = clamp(h - tray.getBoundingClientRect().top, 0, h * .5);
        this.camera.setViewOffset(w, h, 0, covered / 2, w, h);
      }
      const px = (h / 2) / Math.tan((this.camera.fov * Math.PI) / 360) * this.renderer.getPixelRatio();
      this.steam.setScale(px); this.smoke.setScale(px);
    }
    // ---- static scenery
    _buildLights() {
      this.scene.add(new T.HemisphereLight(0xe9f2ff, 0x645446, 0.38));
      const key = new T.SpotLight(0xfff0d8, 1.05, 5, Math.PI / 4, 0.8, 1);
      key.position.set(0.3, 1.3, 0.5); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; key.shadow.radius = 4;
      key.target.position.set(0, 0, 0); this.scene.add(key); this.scene.add(key.target);
      const fill = new T.DirectionalLight(0xfff3db, 1.0); fill.position.set(-1.2, 3.0, 3.5);
      fill.castShadow=true;fill.shadow.mapSize.set(2048,2048);fill.shadow.camera.left=-3;fill.shadow.camera.right=3;fill.shadow.camera.top=3;fill.shadow.camera.bottom=-3;fill.shadow.camera.near=.1;fill.shadow.camera.far=10;fill.shadow.bias=-.00015;fill.shadow.normalBias=.008;
      this.scene.add(fill);
      this.flameLight = new T.PointLight(0xff8a2a, 0, 0.6, 2); this.flameLight.position.set(0, 0.022, 0); this.scene.add(this.flameLight);
      this.key = key;
    }
    _buildKitchen() {
      this.room = root.buildKitchenRoom(T, this.scene);
    }
    _buildRoomSmoke() {
      const cv=document.createElement('canvas');cv.width=cv.height=64;
      const c=cv.getContext('2d'),g=c.createRadialGradient(32,32,0,32,32,32);
      g.addColorStop(0,'rgba(210,212,204,.65)');g.addColorStop(.4,'rgba(195,199,190,.28)');g.addColorStop(1,'rgba(185,192,182,0)');c.fillStyle=g;c.fillRect(0,0,64,64);
      const tex=new T.CanvasTexture(cv);this.roomClouds=[];
      for(let i=0;i<48;i++) {
        const cloud=new T.Sprite(new T.SpriteMaterial({map:tex,color:0x8e938c,transparent:true,opacity:0,depthWrite:false}));
        cloud.userData={x:Math.sin(i*7.13)*2.25,z:Math.cos(i*4.71)*1.65,y:i<32?1.05+(i%5)*.13:.15+(i%4)*.19,phase:i*.618%1,upper:i<32};
        cloud.scale.set(1.35+(i%4)*.25,.65+(i%3)*.18,1);this.scene.add(cloud);this.roomClouds.push(cloud);
      }
      this.cleanFog=this.scene.fog;this.smokeFog=new T.FogExp2(0x8f9891,.02);
    }
    _updateRoomAir(state) {
      const air=state.room||{opening:0,upper:0,lower:0},time=state.t||0;
      for(const w of this.room.userData.windows)w.hinge.rotation.y=w.side*air.opening*1.05;
      const burden=air.lower*.7+air.upper*.3;
      this.scene.fog=burden>.01?this.smokeFog:this.cleanFog;
      this.smokeFog.density=.025+Math.min(.42,burden*.5);
      for(const cloud of this.roomClouds) {
        const q=cloud.userData,travel=air.opening*((time*.026+q.phase)%1);
        cloud.position.set(lerp(q.x,0,travel)+Math.sin(time*.04+q.phase*6)*.10,lerp(q.y,.95,travel),lerp(q.z,2.25,travel));
        cloud.material.opacity=Math.min(.28,(q.upper?air.upper:air.lower)*.12)*(1-travel);
        cloud.visible=cloud.material.opacity>.002;
      }
    }
    _buildReflections() {
      // Capture the actual windows and room once; food and particles never incur
      // six extra renders per frame. Rough materials use the filtered mip levels.
      const target=new T.WebGLCubeRenderTarget(256,{generateMipmaps:true,minFilter:T.LinearMipmapLinearFilter});
      const capture=new T.CubeCamera(.03,16,target); capture.position.set(0,.12,0);
      // The ceiling is omitted from camera geometry for overhead play. Include its
      // broad, softly lit reflection so polished metal reflects a room, not blue sky.
      const ceiling=new T.Mesh(new T.PlaneGeometry(5.5,5.5),new T.MeshBasicMaterial({color:0xf4ead9}));
      ceiling.rotation.x=Math.PI/2;ceiling.position.y=1.77;this.scene.add(ceiling);
      capture.update(this.renderer,this.scene);
      this.scene.remove(ceiling);ceiling.geometry.dispose();ceiling.material.dispose();
      const pmrem=new T.PMREMGenerator(this.renderer);
      this.roomReflection=pmrem.fromCubemap(target.texture);
      this.scene.environment=this.roomReflection.texture;
      target.dispose(); pmrem.dispose();
    }
    _buildOil() {
      const n=33;
      this.oilPixels=new Uint8Array(n*n*4);
      this.oilTexture=new T.DataTexture(this.oilPixels,n,n,T.RGBAFormat);
      this.oilTexture.minFilter=this.oilTexture.magFilter=T.LinearFilter;
      this.oilUniforms={filmMap:{value:this.oilTexture},filmRange:{value:.001},filmTime:{value:0},filmHeat:{value:0}};
      this.oilMat=new T.MeshPhysicalMaterial({color:0xb99751,transparent:true,opacity:.42,roughness:.075,metalness:0,clearcoat:1,clearcoatRoughness:.06,envMapIntensity:.65,depthWrite:false});
      this.oilMat.onBeforeCompile=shader=>{
        Object.assign(shader.uniforms,this.oilUniforms);
        shader.vertexShader='varying vec2 vFilmUv;\n'+shader.vertexShader;
        shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvFilmUv=vec2(uv.x,1.0-uv.y);');
        shader.fragmentShader='varying vec2 vFilmUv;\nuniform sampler2D filmMap;\nuniform float filmRange,filmTime,filmHeat;\n'+shader.fragmentShader;
        shader.fragmentShader=shader.fragmentShader.replace('#include <alphamap_fragment>',`#include <alphamap_fragment>
          float filmDepth=texture2D(filmMap,vFilmUv).r*filmRange;
          diffuseColor.a*=smoothstep(.000008,.00009,filmDepth);
          if(diffuseColor.a<.008) discard;`);
        shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
          float wave=sin(vFilmUv.x*49.+vFilmUv.y*31.+filmTime*.65)*sin(vFilmUv.y*63.-filmTime*.48);
          normal=normalize(normal+vec3(wave*.016*filmHeat,cos(vFilmUv.x*71.+filmTime*.53)*.012*filmHeat,0.));`);
      };
      this.oil=new T.Mesh(new T.PlaneGeometry(1,1,n-1,n-1),this.oilMat);
      this.oil.rotation.x=-Math.PI/2;this.oil.receiveShadow=true;this.oil.frustumCulled=false;this.panGroup.add(this.oil);
    }
    _updateOil(state) {
      const pan=state.pan,f=root.BurgerOilFilm.ensure(pan),n=f.n;
      this.oil.visible=pan.oil>1e-6 && this.stoveType!=='charcoal';
      if(!this.oil.visible)return;
      this.oil.position.y=this.panFloorY+.00018;
      const a=this.oil.geometry.attributes.position, scale=920*f.area;
      let max=.0002;
      for(let k=0;k<f.mass.length;k++) max=Math.max(max,f.mass[k]/scale);
      for(let j=0;j<n;j++)for(let i=0;i<n;i++) {
        const k=j*n+i,depth=f.mass[k]/scale;
        a.setXYZ(k,i*f.cell-f.r,f.r-j*f.cell,depth);
        this.oilPixels[k*4]=Math.round(255*depth/max);this.oilPixels[k*4+3]=255;
      }
      a.needsUpdate=true;this.oil.geometry.computeVertexNormals();this.oilTexture.needsUpdate=true;
      this.oilUniforms.filmRange.value=max;this.oilUniforms.filmTime.value=state.t;
      this.oilUniforms.filmHeat.value=clamp((pan.T-100)/130,0,1);
    }
    _buildStove() {
      const g = new T.Group(); this.stove = g;
      const top = new T.Mesh(VA.roundedBox(.43,.03,.40,.009), VA.material('steel',0x9ba7a5));
      top.position.y = -0.015; top.receiveShadow = true; g.add(top);
      this.burnerGroup = null; this.flames = []; this.setStove('gas');
      // pan
      this.panGroup = new T.Group(); g.add(this.panGroup);
      this.panMat = new T.MeshStandardMaterial({ color: 0x2b2725, roughness: 0.55, metalness: 0.7 });
      this.sharedRes = new Set([this.panMat]); // materials the viewport keeps across a pan or stove swap
      this._buildOil();
      // residue on the pan floor: a canvas texture of fond blotches, burnt specks, welded cheese
      // and meat bits, and a carbon haze, painted from the pan state (positions come from a fixed
      // random sequence so dirt accumulates in place rather than jumping around)
      this.dirtCv = document.createElement('canvas'); this.dirtCv.width = this.dirtCv.height = 512;
      this.dirtTex = new T.CanvasTexture(this.dirtCv);
      this.fondMat = new T.MeshStandardMaterial({ map: this.dirtTex, transparent: true, opacity: 1, roughness: 0.85, depthWrite: false });
      // it hangs off the stove group, not the pan: a kettle has no pan, and the residue baked onto
      // its bars is exactly what the wire brush is for
      this.fond = new T.Mesh(new T.CircleGeometry(1, 64), this.fondMat); this.fond.rotation.x = -Math.PI / 2; this.fond.position.y = 0.0004; g.add(this.fond);
      let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      this.dirtSpots = []; for (let i = 0; i < 1400; i++) { const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()); this.dirtSpots.push({ x: 256 + 236 * rr * Math.cos(a), y: 256 + 236 * rr * Math.sin(a), s: 0.5 + rnd(), e: 0.6 + rnd() * 0.8, rot: rnd() * 3 }); }
      this.dirtSig = ''; this.dirtClock = 0;
      // fat that overflowed the pan, spreading on the stovetop
      this.spillMat = new T.MeshPhysicalMaterial({ color: 0x8a5a16, transparent: true, opacity: 0.7, roughness: 0.05, clearcoat: 1, depthWrite: false });
      this.spill = new T.Mesh(this.puddleGeometry(96,2.1), this.spillMat); this.spill.rotation.x = -Math.PI / 2; this.spill.visible = false; g.add(this.spill);
      // grease-fire flames around the pan rim (any stove type), shown only while pan.flare > 0
      this.flareFlames = [];
      const flareGeo = new T.ConeGeometry(0.012, 1, 6); flareGeo.translate(0, 0.5, 0);
      const flareMat = new T.MeshBasicMaterial({ color: 0xff8a20, transparent: true, opacity: 0.5, blending: T.AdditiveBlending, depthWrite: false });
      for (let i = 0; i < 30; i++) { const f = new T.Mesh(flareGeo, flareMat.clone()); f.userData.a = (i / 30) * Math.PI * 2 + (Math.random() - 0.5) * 0.1; f.visible = false; g.add(f); this.flareFlames.push(f); }
      const plate = new T.Mesh(new T.CylinderGeometry(0.11, 0.09, 0.008, 48), new T.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.35 }));
      plate.position.set(0.42, 0.004, 0.12); plate.receiveShadow = true; plate.castShadow = true; g.add(plate); this.plate = plate;
      // where a dragged patty will land: a ring on the metal, green if it fits, red if it does not
      this.ghostMat = new T.MeshBasicMaterial({ color: 0x7fe08a, transparent: true, opacity: 0.65, depthWrite: false, side: T.DoubleSide });
      this.ghost = new T.Mesh(new T.RingGeometry(1.0, 1.2, 64), this.ghostMat); // just outside the footprint, so the patty being dragged never hides it
      this.ghost.rotation.x = -Math.PI / 2; this.ghost.visible = false; g.add(this.ghost);
      // the spatula: a thin offset blade on a handle, shown while a scrape is actually happening
      this.spatula = this._buildSpatula(); this.spatula.visible = false; g.add(this.spatula);
      // and a finger, for the press test
      this.finger = this._buildFinger(); this.finger.visible = false; g.add(this.finger);
      this.stainGroup = new T.Group(); g.add(this.stainGroup); this.stains = [];
      this.stainMat = new T.MeshStandardMaterial({ color: 0x6b4a1e, transparent: true, opacity: 0.6, roughness: 0.3, depthWrite: false });
      this.stainGeo = this.puddleGeometry(32,5.7);
      this.setPan('castiron');
      this.scene.add(g);
    }
    /** Build the burner for a stove type. Each has its own pan height: a gas pan sits on a grate
     *  above the flames, an electric pan rests on the coil in its drip bowl, an induction pan sits
     *  flush on the glass. */
    _buildHobControls(id,g) {
      this.hobDial=null;this.hobLevels=[];this.hobPower=null;
      if(id==='charcoal')return; // The kettle already has a state-driven damper wheel.
      const controls=new T.Group();controls.name=id+' hob controls';controls.position.set(0,.003,-.218);g.add(controls);
      const ink=new T.MeshBasicMaterial({color:id==='induction'?0xb4b7b1:0x3b4440});
      const stroke=(x,z,w,d,material=ink)=>{const m=new T.Mesh(new T.PlaneGeometry(w,d),material);m.rotation.x=-Math.PI/2;m.position.set(x,.002,z);controls.add(m);return m;};
      if(id==='induction'){
        controls.rotation.y=Math.PI; // Read from the cook's side of the island.
        // Printed touch controls on the glass, with a ten-step illuminated power strip.
        const power=new T.Mesh(new T.RingGeometry(.007,.0085,32,1,.3,Math.PI*2-.6),ink);power.rotation.set(-Math.PI/2,0,Math.PI/2);power.position.set(-.11,.002,0);controls.add(power);
        stroke(-.11,-.006,.0018,.010);stroke(-.068,0,.011,.0018);stroke(.112,0,.011,.0018);stroke(.112,0,.0018,.011);
        for(let i=0;i<10;i++){
          const material=new T.MeshBasicMaterial({color:0x34221b});this.hobLevels.push(stroke(-.04+i*.012,0,.007,.013,material));
        }
        return;
      }
      const panel=new T.Mesh(VA.roundedBox(.43,.023,.084,.006),VA.material('steel',0x9ba7a5));panel.position.y=-.013;panel.receiveShadow=true;controls.add(panel);
      const bezel=new T.Mesh(new T.CylinderGeometry(.023,.025,.004,48),VA.material('steel',0xc6c5bb));bezel.position.set(0,.003,0);controls.add(bezel);
      const dial=new T.Group();dial.position.y=.005;controls.add(dial);this.hobDial=dial;
      const grip=new T.Mesh(new T.CylinderGeometry(.017,.021,.018,48),VA.material('rubber',0x303b38));grip.position.y=.009;grip.castShadow=true;dial.add(grip);
      const pointer=new T.Mesh(VA.roundedBox(.002,.001,.009,.0002),new T.MeshBasicMaterial({color:0xf5e8ce}));pointer.position.set(0,.0185,-.010);dial.add(pointer);
      for(let i=0;i<=10;i++){
        const a=-Math.PI*.75+i*Math.PI*1.5/10;
        const tick=stroke(Math.sin(a)*.030,-Math.cos(a)*.030,.0012,i%5===0?.005:.0028);tick.rotation.z=-a;
      }
      // Separate power lamp and a small engraved burner symbol.
      const lamp=new T.Mesh(new T.CircleGeometry(.003,24),new T.MeshBasicMaterial({color:0x382519}));lamp.rotation.x=-Math.PI/2;lamp.position.set(.068,.002,0);controls.add(lamp);this.hobPower=lamp.material;
      const ring=new T.Mesh(new T.RingGeometry(.007,.008,32),ink);ring.rotation.x=-Math.PI/2;ring.position.set(-.068,.002,0);controls.add(ring);
      if(id==='electric'){
        const inner=new T.Mesh(new T.RingGeometry(.003,.004,24),ink);inner.rotation.x=-Math.PI/2;inner.position.set(-.068,.002,0);controls.add(inner);
      }else for(const dx of [-.011,.011])stroke(-.068+dx,0,.004,.001);
    }
    setStove(id) {
      this.stoveType = id;
      if (this.burnerGroup) { this.stove.remove(this.burnerGroup); disposeTree(this.burnerGroup); } // a swap is a whole new burner: give the old one's meshes back
      const g = new T.Group(); this.burnerGroup = g; this.stove.add(g);
      this.flames = []; this.coilMat = null; this.indLed = null;
      if (id === 'electric') {
        // chrome drip bowl with a spiral sheathed element; the pan sits on top of the coil
        const chrome = VA.material('steel',0xc4cbcd);chrome.side=T.DoubleSide;
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
        const enamel = VA.material('paint',0x263736);enamel.clearcoat=.85;enamel.clearcoatRoughness=.14;
        const inside = new T.MeshStandardMaterial({ color: 0x1a1816, roughness: 0.75, metalness: 0.1, side: T.BackSide });
        const steel = VA.material('steel',0xa4adae);steel.roughness=.36;
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
        // the ash that has fallen through the bed: a disc on the bowl floor that rises and goes pale
        // as it builds. Wood ash is ~250 kg/m³ loose, so a kilo of it over the 0.126 m² floor of a
        // 57 cm kettle is about 3 cm deep — which is when it starts burying the bottom vent.
        this.ashMat = new T.MeshStandardMaterial({ color: 0x4d4944, roughness: 1 });
        const ash = new T.Mesh(new T.CircleGeometry(0.2, 48), this.ashMat); ash.rotation.x = -Math.PI / 2; ash.position.y = bedY - 0.012; g.add(ash);
        this.ashDisc = ash; this.ashY0 = bedY - 0.012;
        this.coalMat = new T.MeshStandardMaterial({ color: 0x0f0e0d, roughness: 0.95, emissive: new T.Color(0xff3a08), emissiveIntensity: 0 });
        this.coalMat.bumpMap=VA.texture('iron').relief;this.coalMat.bumpScale=.0015;
        const lumpGeo = new T.DodecahedronGeometry(0.019, 0);
        const lumps = new T.InstancedMesh(lumpGeo, this.coalMat, 160); lumps.castShadow = true; lumps.receiveShadow = true;
        let sd = 99; const rnd = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; };
        const lc = new T.Color();
        this.coalSeeds = [];
        for (let i = 0; i < 160; i++) {
          const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 0.185, sc = 0.6 + rnd() * 0.9;
          this.coalSeeds.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, jy: (rnd() - 0.5) * 0.02, sc, sy: sc * (0.6 + rnd() * 0.6), rx: rnd() * 3, ry: rnd() * 3, rz: rnd() * 3 });
          const k = 0.35 + rnd() * 0.9; lumps.setColorAt(i, lc.setRGB(k, k * (0.85 + 0.15 * rnd()), k * 0.8));
        }
        lumps.instanceColor.needsUpdate = true;
        g.add(lumps); this.coals = lumps; this.coalY = bedY; this.coalBank = -1;
        this.setBank(0);
        // chunks of wood sitting on the coals: split hardwood, so a rough block rather than a lump.
        // Each one shrinks as it is consumed (side ∝ m^⅓) and goes from bark-brown through charcoal
        // black, glowing at its edges once it is hot enough to be smouldering.
        this.woodMats = []; this.woodMeshes = [];
        for (let i = 0; i < 6; i++) {
          const m=VA.material('wood',0x9e7342);m.roughness=.95;m.emissive.setHex(0xff3c08);m.emissiveIntensity=0;
          const box = new T.Mesh(VA.roundedBox(1,1,1,.05,2), m); // unit cube, scaled to the chunk's side
          const a = (i * 2.4) + 0.7, rr = 0.055 + 0.035 * (i % 3);
          box.userData.home = { x: Math.cos(a) * rr, z: Math.sin(a) * rr, ry: a * 1.7 };
          box.castShadow = true; box.visible = false;
          g.add(box); this.woodMeshes.push(box); this.woodMats.push(m);
        }
        // the grate: a ring with rods across it
        const Rg = Rk * 0.93, rodR = 0.003, gy = this.PAN_Y - rodR;
        this.grateBars = { x0: -Rg + 0.012, dx: 0.024, w: 2 * rodR }; // where the rods are, for the residue mask
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
        const wood = VA.material('wood',0x997047);
        const handle = new T.Mesh(new T.CylinderGeometry(0.012, 0.012, 0.11, 12), wood); handle.rotation.z = Math.PI / 2; handle.position.y = lidH + 0.035; lid.add(handle);
        for (const x of [-0.045, 0.045]) { const post = new T.Mesh(new T.CylinderGeometry(0.004, 0.004, 0.03, 8), steel); post.position.set(x, lidH + 0.018, 0); lid.add(post); }
        // The top vent, on the shoulder of the dome where a kettle's actually is (clear of the
        // handle, and where you can put a hand near it without reaching over the fire): a collar
        // with four openings in it and a damper wheel of four steel petals sitting over them. The
        // wheel turns 45° from shut (petals over the holes) to wide (petals over the metal between
        // them), which is the throw a kettle damper has, and it is the same 0..1 the physics reads.
        const holeR = 0.030, tilt = -0.62;                       // ~35° off vertical: the dome's own slope there
        const vg = new T.Group(); vg.position.set(0.16, 0.081, 0); vg.rotation.z = tilt; lid.add(vg);
        const collar = new T.Mesh(new T.CylinderGeometry(holeR, holeR + 0.003, 0.012, 24), steel); collar.position.y = -0.002; vg.add(collar);
        const dark = new T.MeshStandardMaterial({ color: 0x090909, roughness: 1 });
        const plate = new T.Mesh(new T.CircleGeometry(holeR * 0.96, 24), steel); plate.rotation.x = -Math.PI / 2; plate.position.y = 0.0045; vg.add(plate);
        for (let i = 0; i < 4; i++) { // four 45° openings, with 45° of metal between them
          const hole = new T.Mesh(new T.CircleGeometry(holeR * 0.93, 16, (i * Math.PI) / 2 - 0.39, 0.78), dark);
          hole.rotation.x = -Math.PI / 2; hole.position.y = 0.0052; vg.add(hole);
        }
        const wheel = new T.Group(); wheel.position.y = 0.0072; vg.add(wheel);
        for (let i = 0; i < 4; i++) {
          // four blades the size of the openings: over them at 0°, over the metal between them at 45°
          const petal = new T.Mesh(new T.CircleGeometry(holeR * 0.94, 16, (i * Math.PI) / 2 - 0.42, 0.84), steel);
          petal.rotation.x = -Math.PI / 2; wheel.add(petal);
        }
        const tab = new T.Mesh(new T.BoxGeometry(0.018, 0.004, 0.007), steel); tab.position.set(holeR * 0.85, 0.002, 0); wheel.add(tab); // the tab you push it round with
        const knobV = new T.Mesh(new T.CylinderGeometry(0.0045, 0.0045, 0.009, 10), steel); knobV.position.y = 0.004; wheel.add(knobV);
        this.ventWheel = wheel;
        // where the smoke comes out, in world coordinates: the mouth of the vent, a little way out
        // along its own axis
        this.ventPos = { x: 0.16 + 0.020 * -Math.sin(tilt), y: bowlTop + 0.081 + 0.020 * Math.cos(tilt), z: 0 };
        g.add(lid); this.kettleLid = lid;
        this.flameBaseY = bedY + 0.01; this.flameMaxLen = this.PAN_Y - this.flameBaseY + 0.05;
      } else {
        // gas: cast-iron pan support (square frame, radial fingers, feet) holding the pan ~3.5 cm
        // above the stovetop, with the burner flames underneath in the gap.
        this.PAN_Y = 0.036;
        this.stainY = 0.0012;
        const grateTop = this.PAN_Y - 0.0005, barH = 0.010, barY = grateTop - barH / 2;
        const grateMat = VA.material('iron',0x303332);
        const addBox = (w, h, d, x, y, z, ry) => { const m = new T.Mesh(VA.roundedBox(w,h,d,.0025,2), grateMat); m.position.set(x, y, z); m.rotation.y = ry || 0; m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
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
      this._buildHobControls(id,g);
      this.flameLight.position.y = id === 'charcoal' ? this.coalY + 0.03 : this.PAN_Y - 0.01;
      if (id !== 'charcoal') { this.coals = null; this.coalMat = null; this.kettleLid = null; this.coalSeeds = null; this.woodMeshes = null; this.ashDisc = null; this.ventWheel = null; this.ventPos = null; this.grateBars = null; }
      if (this.panSpec) this.setPan(this.panSpec.id);
      if (this.panGroup) this.panGroup.visible = id !== 'charcoal';
      if (id === 'charcoal') { this.panFloorY = this.PAN_Y; this.panR = 0.26; }
      if (this.fond) this.fond.position.y = this.panFloorY + 0.0004; // the pan floor, or the crowns of the bars
      if (this.controls && this.mode === 'stove') this.controls.reset('stove'); // the grate sits far higher than a pan
    }
    setPan(id) {
      const pan = P.PANS[id] || P.PANS.castiron; this.panSpec = pan;
      if (this.stoveType === 'charcoal') { this.panGroup.visible = false; this.panFloorY = this.PAN_Y; this.panR = 0.26; return; }
      this.panGroup.visible = true;
      if (this.panMesh) { this.sharedRes.delete(this.panMat);this.panGroup.remove(this.panMesh); disposeTree(this.panMesh, this.sharedRes); }
      const R=pan.diam/2,wall=id==='castiron'?.041:id==='carbonsteel'?.037:.043;
      const rimR=R*(id==='carbonsteel'?1.14:1.075),hy=wall-.010;
      const base=R*.95,thick=id==='castiron'?.004:.0025;
      const prof=[{r:0,y:0,v:0},{r:base-.006,y:0,v:.1},{r:base,y:.001,v:.12},
        {r:base+.004,y:.004,v:.16},{r:rimR-.002,y:wall-.005,v:.46},
        {r:rimR,y:wall-.002,v:.49},{r:rimR-.001,y:wall,v:.5},
        {r:rimR-thick,y:wall,v:.52},{r:rimR-thick-.001,y:wall-.003,v:.54},
        {r:base-.001,y:.009,v:.85},{r:base-.005,y:.005,v:.9},
        {r:base-.012,y:.004,cap:{R:base,cx:.5,cy:.5}},{r:0,y:.004,cap:{R:base,cx:.5,cy:.5}}];
      const look={castiron:['iron',0x333536],carbonsteel:['carbon',0x514e46],stainless:['steel',0xe2e6e8],nonstick:['iron',0x303536]}[id]||['iron',0x333536];
      this.panMat=VA.material(...look);if(id==='nonstick'){this.panMat.metalness=.05;this.panMat.roughness=.65;this.panMat.bumpScale=.000035;}
      this.sharedRes.add(this.panMat);
      const m=new T.Mesh(buildLathe(prof,128,Math.PI*2),this.panMat);m.castShadow=m.receiveShadow=true;m.position.y=this.PAN_Y;m.name=id+' skillet';
      const steel=VA.material('steel',0xb9c1c5),handleMat=id==='nonstick'?VA.material('rubber',0x292d2c):id==='stainless'?steel:this.panMat;
      // A forged handle with a rounded hanging slot, rather than a rectangular bar.
      const outline=new T.Shape();outline.moveTo(0,-.017);outline.quadraticCurveTo(.035,-.014,.075,-.012);
      outline.bezierCurveTo(.14,-.016,.19,-.024,.213,-.017);outline.quadraticCurveTo(.236,0,.213,.017);
      outline.bezierCurveTo(.19,.024,.14,.016,.075,.012);outline.quadraticCurveTo(.035,.014,0,.017);outline.closePath();
      const hole=new T.Path();hole.absellipse(.195,0,.016,.007,0,Math.PI*2,true);outline.holes.push(hole);
      const hg=new T.ExtrudeGeometry(outline,{depth:id==='nonstick'?.013:.007,bevelEnabled:true,bevelThickness:.002,bevelSize:.002,bevelSegments:3,steps:1,curveSegments:18});
      // Extrusion Z becomes thickness; length extends away from the rim, with a gentle rise.
      hg.rotateX(Math.PI/2);hg.rotateY(Math.PI);const handle=new T.Mesh(hg,handleMat);handle.position.set(-rimR+.012,hy+.006,0);handle.rotation.z=-.15;handle.castShadow=true;m.add(handle);
      const rootMesh=new T.Mesh(VA.roundedBox(.026,.011,.039,.004),id==='stainless'?steel:this.panMat);rootMesh.position.set(-rimR+.009,hy,0);rootMesh.rotation.z=-.15;rootMesh.castShadow=true;m.add(rootMesh);
      if(id!=='castiron')for(const z of [-.012,.012]){
        const rivet=new T.Mesh(new T.SphereGeometry(.004,16,10),steel);rivet.scale.x=.3;rivet.position.set(-rimR+thick+.003,hy,z);m.add(rivet);
      }
      if(id==='castiron'){
        const curve=new T.CatmullRomCurve3([new T.Vector3(rimR-.006,hy,-.030),new T.Vector3(rimR+.025,hy+.004,-.023),new T.Vector3(rimR+.032,hy+.004,0),new T.Vector3(rimR+.025,hy+.004,.023),new T.Vector3(rimR-.006,hy,.030)]);
        const loop=new T.Mesh(new T.TubeGeometry(curve,32,.0055,10,false),this.panMat);loop.castShadow=true;m.add(loop);
      }
      if(id==='stainless'||id==='nonstick'){
        const lip=new T.Mesh(new T.TorusGeometry(rimR-.001,.0013,8,128),steel);lip.rotation.x=Math.PI/2;lip.position.y=wall-.001;m.add(lip);
      }
      // lid: glass dome with a steel rim and knob, shown when the lid is on; fogs with steam
      if (this.lid) { this.panGroup.remove(this.lid); disposeTree(this.lid, this.sharedRes); }
      const lid = new T.Group(); this.lid = lid; lid.position.y = this.PAN_Y + wall; lid.visible = false;
      this.lidGlass = new T.MeshPhysicalMaterial({ color: 0xd6e4ec, transparent: true, opacity: 0.2, roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, side: T.DoubleSide, depthWrite: false });
      const domeH = 0.075, nd = 14, lp = [];
      for (let i = 0; i <= nd; i++) { const t = i / nd; const a = (Math.PI / 2) * t; lp.push({ r: rimR * Math.cos(a) * (1 - 0.15 * t) + 0 * t, y: 0.004 + domeH * Math.sin(a), v: t }); }
      lp[nd].r = 0.0001;
      const dome = new T.Mesh(buildLathe(lp, 72, Math.PI * 2), this.lidGlass); lid.add(dome);

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
      const wood = new T.Mesh(VA.roundedBox(.42,.025,.30,.009), VA.material('wood',0xc59964));
      wood.position.y = -0.0125; wood.receiveShadow = true; wood.castShadow = true; g.add(wood);
      // a ruler for scale
      const ruler = new T.Mesh(new T.BoxGeometry(0.15, 0.002, 0.02), new T.MeshStandardMaterial({ color: 0xe8e0c8, roughness: 0.6 })); ruler.position.set(0.09, 0.001, 0.1); ruler.rotation.y = Math.PI; g.add(ruler);
      const cv = document.createElement('canvas'); cv.width = 300; cv.height = 40; const c = cv.getContext('2d'); c.fillStyle = '#e8e0c8'; c.fillRect(0, 0, 300, 40); c.fillStyle = '#333'; c.font = '14px sans-serif';
      for (let i = 0; i <= 15; i++) { c.fillRect(i * 20, 0, 1, i % 5 === 0 ? 18 : 10); if (i % 5 === 0) c.fillText(i + 'cm', i * 20 + 2, 34); }
      ruler.material.map = new T.CanvasTexture(cv); ruler.material.needsUpdate = true;
      g.visible = false; this.scene.add(g);
    }
    _buildProbe() {
      const g = new T.Group(); this.probeGroup = g;
      const steel = VA.material('steel',0xcfd2d6);
      const rod = new T.Mesh(new T.CylinderGeometry(0.0012, 0.0006, 0.10, 8), steel); rod.rotation.z = Math.PI / 2; rod.position.x = 0.05; g.add(rod);
      const body = new T.Mesh(VA.roundedBox(.035,.016,.022,.003), new T.MeshStandardMaterial({ color: 0xd8382e, roughness: 0.5 })); body.position.x = 0.117; g.add(body);
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
      this.marble = minceFat(1024,3800);
      this.marbleCut = minceFat(512,1500);
      this.spots = makeBlobs(1024, 1400, 2, 9, 'rgba(0,0,0,1)'); this.blotch = makeBlobs(1024, 40, 14, 50, 'rgba(0,0,0,1)');
    }

    // ---- patty mesh management
    /** Board preview: show this one patty (or nothing). */
    setPatty(p) { this.previewPatty = p || null; this.forceTex = true; }
    /** Keep one PattyView per patty in `list`. */
    syncViews(list) {
      const keep = new Set(list);
      for (const [p, v] of this.views) if (!keep.has(p)) { v.dispose(); this.views.delete(p); this.peeks.delete(p); }
      for (const p of list) if (!this.views.has(p)) this.views.set(p, new PattyView(this, p));
    }
    /** A fingertip and the joint behind it, for the press test. It comes in from the cook's side. */
    _buildFinger() {
      const g = new T.Group();
      const skin = new T.MeshStandardMaterial({ roughness: 0.9 }); setLin(skin, [176, 118, 92]); // sRGB skin, converted like every other colour in here
      const geo=new T.SphereGeometry(1,32,32),pos=geo.attributes.position;
      // One continuous tapered surface from the fingertip to the first knuckle.
      for(let i=0;i<pos.count;i++){
        const t=(pos.getY(i)+1)/2,x=-.009+t*.052,r=.0092*(1+.10*Math.sin(t*Math.PI*3));
        pos.setXYZ(i,x,pos.getX(i)*r*.82+Math.max(0,x)*.60,-pos.getZ(i)*r);
      }
      geo.computeVertexNormals();const finger=new T.Mesh(geo,skin);finger.castShadow=true;g.add(finger);
      const nailMat = new T.MeshStandardMaterial({ roughness: 0.35 }); setLin(nailMat, [217, 182, 164]);
      const nail = new T.Mesh(new T.SphereGeometry(0.0062, 24, 16), nailMat);
      nail.position.set(0.003, 0.0062, 0); nail.scale.set(0.9, 0.45, 0.75); g.add(nail);
      return g;
    }
    /** A 10 cm offset spatula: a thin steel blade, a cranked neck and a wooden handle. */
    _buildSpatula() {
      const g = new T.Group();
      const steel = VA.material('steel',0xb9bcc0);
      const wood = VA.material('wood',0x996638);
      const blade = new T.Mesh(VA.roundedBox(.075,.0012,.095,.00025), steel); // 7.5 × 9.5 cm, 1.2 mm
      blade.position.set(0, 0.0006, -0.02); blade.castShadow = true; g.add(blade);
      const bevel = new T.Mesh(new T.BoxGeometry(0.075, 0.0006, 0.012), steel); bevel.position.set(0, 0.0003, -0.0715); g.add(bevel); // the thin leading edge
      const neck = new T.Mesh(new T.BoxGeometry(0.016, 0.0025, 0.05), steel); neck.position.set(0, 0.008, 0.045); neck.rotation.x = -0.5; g.add(neck);
      const handle = new T.Mesh(new T.CylinderGeometry(0.008, 0.009, 0.1, 12), wood);
      handle.rotation.x = Math.PI / 2 - 0.15; handle.position.set(0, 0.022, 0.115); handle.castShadow = true; g.add(handle);
      return g;
    }
    /**
     * Rake the coal bed. The lumps are the same lumps — banking moves charcoal, it does not make or
     * burn any — so each one keeps its identity and is pushed toward the hot half, with the ones
     * that came from the far side ending up on top of the pile: twice as deep over half the bed.
     */
    setBank(bank) {
      if (!this.coals || !this.coalSeeds) return;
      const b = clamp(bank || 0, 0, 1);
      if (Math.abs(b - this.coalBank) < 0.01) return;
      this.coalBank = b;
      const dm = new T.Object3D(), R = 0.185;
      for (let i = 0; i < this.coalSeeds.length; i++) {
        const c = this.coalSeeds[i];
        const x = lerp(c.x, c.x * 0.5 + R * 0.42, b);      // the whole bed squeezed into the +x half
        const z = lerp(c.z, c.z * 0.85, b);
        const layer = smoothstep(0.15, -0.15, c.x / R);     // lumps raked in from the far side ride on top
        const y = this.coalY + c.jy * (1 - 0.4 * b) + 0.004 * c.sc + b * layer * 0.024;
        dm.position.set(x, y, z); dm.rotation.set(c.rx, c.ry + b * 0.6, c.rz); dm.scale.set(c.sc, c.sy, c.sc);
        dm.updateMatrix(); this.coals.setMatrixAt(i, dm.matrix);
      }
      this.coals.instanceMatrix.needsUpdate = true;
    }
    // ---- dragging things around the pan
    /** Where a screen point lands on the pan floor (the plane the meat sits on). */
    floorPoint(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      const ndc = new T.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new T.Raycaster(); ray.setFromCamera(ndc, this.camera);
      const plane = new T.Plane(new T.Vector3(0, 1, 0), -this.panFloorY);
      const hit = new T.Vector3();
      return ray.ray.intersectPlane(plane, hit) ? hit : null;
    }
    /**
     * Start dragging whatever is under the cursor. Returns false if there is nothing draggable
     * there, which is how the orbit control knows this was a look-around and not a move.
     */
    startDrag(clientX, clientY) {
      if (this.mode !== 'stove' || !this.canDrag) return false;
      const o = this.pickPatty(clientX, clientY);
      if (!o || !this.canDrag(o)) return false;
      const pt = this.floorPoint(clientX, clientY); if (!pt) return false;
      this.dragging = { o, gx: pt.x - o.pos.x, gy: pt.z - o.pos.y, pos: { x: o.pos.x, y: o.pos.y }, land: { x: o.pos.x, y: o.pos.y }, ok: true, moved: 0 };
      this.moveDrag(clientX, clientY);
      return true;
    }
    moveDrag(clientX, clientY) {
      const d = this.dragging; if (!d) return;
      const pt = this.floorPoint(clientX, clientY); if (!pt) return;
      const want = { x: pt.x - d.gx, y: pt.z - d.gy };
      d.moved += Math.abs(want.x - d.pos.x) + Math.abs(want.y - d.pos.y);
      d.pos = want;
      const r = this.dropSpot ? this.dropSpot(d.o, want) : { pos: want, ok: true };
      d.land = r.pos; d.ok = r.ok;
      const rad = (d.o.D != null ? d.o.D : d.o.Dcov) / 2;
      this.ghost.visible = true;
      this.ghost.position.set(d.land.x, this.panFloorY + 0.0015, d.land.y);
      this.ghost.scale.set(rad, rad, 1);
      this.ghostMat.color.setHex(d.ok ? 0x7fe08a : 0xe06a5a);
    }
    /** Let go: the object lands on the legal spot, and the physics decides what that cost. */
    endDrag() {
      const d = this.dragging; this.dragging = null; this.ghost.visible = false;
      if (!d) return null;
      if (this.onDrop) this.onDrop(d.o, d.land, d.moved);
      return d;
    }
    /** Keep one ItemView per topping in `list`. */
    updateAssemblies(state, list, dt) {
      const A = root.BurgerAssembly;
      this.assemblyViews ||= new Map();
      for (const [p,g] of this.assemblyViews) if (!list.includes(p) || !p.assembly?.length) { this.scene.remove(g); disposeTree(g); this.assemblyViews.delete(p); }
      for (const p of list) {
        if (!p.manualAssembly || !p.assembly?.length || !['rest','cut'].includes(p.where)) continue;
        const pv = this.views.get(p), base = p._viewPos;
        if (!pv || !base) continue;
        let group = this.assemblyViews.get(p);
        const signature = p.assembly.map(l=>l.patty?'patty':l.item?'item'+l.item.id:l.cold).join('|');
        if (!group || group.userData.signature !== signature) {
          if (group) { this.scene.remove(group); disposeTree(group); }
          group = new T.Group(); group.userData.signature = signature; group.userData.layers = new Map(); group.userData.caps = new Map(); this.scene.add(group); this.assemblyViews.set(p,group);
          p.assembly.forEach((l,i) => {
            if (l.item?.kind === 'bun' || l.cold) {
              const R=l.item?l.item.D/2:Math.max(.048,p.D/2)*.94;
              const height=l.item?.half==='top'?.025:l.item?.kind==='bun'?.022:A.cold[l.cold].height;
              const profile=l.item ? bunProfile(R,l.item.half).map(pt=>({r:pt.r,y:l.item.half==='bottom'?height-pt.y:pt.y})) : [{r:0,y:0},{r:R,y:0},{r:R,y:height},{r:0,y:height}];
              const cap=new T.Mesh(new T.ShapeGeometry(crossSectionShape(profile)),new T.MeshStandardMaterial({color:l.item?0xf3e4c4:A.cold[l.cold].color,roughness:.85,side:T.DoubleSide}));
              if(l.item) {
                const tex=crumbTexture(l.item.id+73);tex.repeat.set(1/(2*R),1/height);tex.offset.set(.5,0);
                cap.material.map=tex;cap.material.bumpMap=tex;cap.material.bumpScale=.0003;
              }
              if(l.cold)cap.material.color.convertSRGBToLinear();
              cap.userData.cutCap=true; group.add(cap); group.userData.caps.set(i,cap);
            }
            if (!l.cold) return;
            const spec = A.cold[l.cold], layer = new T.Group(), R = Math.max(.048,p.D/2);
            const material = new T.MeshPhysicalMaterial({color:l.cold==='lettuce'?0xffffff:spec.color,vertexColors:l.cold==='lettuce',roughness:spec.sauce?.27:.48,clearcoat:spec.sauce?.65:.25,side:T.DoubleSide});
            if(l.cold!=='lettuce')material.color.convertSRGBToLinear();
            const count = l.cold==='pickles'?5:l.cold==='lettuce'?7:1;
            for(let j=0;j<count;j++) {
              const r = count>1 ? R*.40 : R*.94;
              const geometry=l.cold==='lettuce'?lettuceGeometry(r,j*1.7):spec.sauce?sauceGeometry(r,spec.height,i*2.4):new T.CylinderGeometry(r,r,spec.height,40);
              const mesh = new T.Mesh(geometry,material);
              mesh.position.set(count>1?Math.cos(j*2.4)*R*.57:0,spec.height/2,count>1?Math.sin(j*2.4)*R*.57:0);
              if(l.cold==='lettuce') { mesh.rotation.y=j*2.4; mesh.rotation.x=(j%2?1:-1)*.15; }
              mesh.castShadow=true; mesh.receiveShadow=true; layer.add(mesh);
              if(l.cold==='pickles'){
                const flesh=new T.MeshPhysicalMaterial({map:VA.texture('pickle').map,roughness:.3,clearcoat:.45});
                for(const side of [-1,1]){const cut=new T.Mesh(new T.CircleGeometry(r*.995,48),flesh);cut.rotation.x=-side*Math.PI/2;cut.position.y=side*(spec.height/2+.00002);mesh.add(cut);}
              }
              if(l.cold==='tomato') {
                const seedMat=new T.MeshStandardMaterial({color:0xcab15f,roughness:.45});seedMat.color.convertSRGBToLinear();
                const gelMat=new T.MeshPhysicalMaterial({color:0xa95a29,roughness:.21,clearcoat:.8});gelMat.color.convertSRGBToLinear();
                const skinMat=new T.MeshStandardMaterial({color:0x9f281b,roughness:.4});skinMat.color.convertSRGBToLinear();
                const skin=new T.Mesh(new T.RingGeometry(R*.86,R*.94,64),skinMat);skin.rotation.x=-Math.PI/2;skin.position.y=spec.height+.00008;layer.add(skin);
                for(let k=0;k<5;k++) {
                  const a=k*Math.PI*2/5,cx=Math.cos(a)*R*.53,cz=Math.sin(a)*R*.53;
                  const gel=new T.Mesh(new T.CircleGeometry(R*.23,20),gelMat);gel.rotation.x=-Math.PI/2;gel.rotation.z=-a;gel.scale.y=.68;gel.position.set(cx,spec.height+.00013,cz);layer.add(gel);
                  for(let n=0;n<3;n++) {const seed=new T.Mesh(new T.SphereGeometry(.0018,6,4),seedMat);seed.scale.set(1,.22,.55);seed.rotation.y=a;seed.position.set(cx+Math.cos(a+n*2.1)*R*.12,spec.height+.00035,cz+Math.sin(a+n*2.1)*R*.12);layer.add(seed);}
                }
              }
            }
            group.add(layer); group.userData.layers.set(i,layer);
          });
        }
        group.position.set(base.x,base.y,base.z);
        const clipping=this.cutaway&&(p===this.selected||p.assembly.some(l=>l.meat===this.selected));
        const phi=clipping?(this.views.get(this.selected)?.cutPhi||0):(pv.cutPhi||0);
        if(pv.cutaway!==clipping || (clipping&&pv.cutPhi!==phi))pv.setCutaway(clipping,phi);
        const heights=p.assembly.map(l=>{
          if(l.patty){const meat=l.meat||p;return meat.h*(1+.28*meat.dome)+meat.cheeses.length*.0015;}
          if(l.item)return this.itemViews.get(l.item)?.layerH()||0;
          const spec=A.cold[l.cold],spread=.72+.28*(1-Math.exp(-(l.age||0)/22));
          return spec.height*(spec.sauce?1/(spread*spread):l.cold==='lettuce'?1-.45*(l.wilt||0):1);
        });
        const layout=A.stackLayout(p,P,heights);
        pv.stackSettling ||= new WeakMap();
        let h=0;
        p.assembly.forEach((l,i) => {
          const support=layout[i],old=pv.stackSettling.get(l)??1;
          const scale=lerp(old,support.scale,1-Math.exp(-Math.max(0,dt)*12));
          pv.stackSettling.set(l,scale);
          const cap=group.userData.caps.get(i);
          if(cap) { cap.visible=clipping; cap.position.y=h; cap.rotation.y=-phi;cap.scale.set(1,scale,1); }
          if(l.patty) {
            const meat=l.meat||p,mv=this.views.get(meat);
            mv.group.position.set(base.x,base.y+h,base.z);
            mv.group.scale.y=scale;
            if(mv.cutaway!==clipping || (clipping&&mv.cutPhi!==phi))mv.setCutaway(clipping,phi);
          }
          else if(l.item) {
            const v=this.itemViews.get(l.item); if(!v)return;
            v.update(state,0,'rest',{x:base.x,y:base.y+h,z:base.z},this.mode);
            if(l.item.kind==='bun' && l.item.half==='top') { v.group.rotation.x=0; v.group.position.y=base.y+h; }
            v.group.position.y=base.y+h+(v.group.position.y-base.y-h)*scale;
            v.group.scale.y=scale;
            if(clipping) { const phi=pv.cutPhi||0; v.setClipAt(-Math.sin(phi),Math.cos(phi),base.x,base.z); } else v.setClip(null);
          } else {
            const v=group.userData.layers.get(i),spec=A.cold[l.cold]; v.position.y=h;
            v.scale.set(1,1,1);
            if(spec.sauce) { const spread=.72+.28*(1-Math.exp(-(l.age||0)/22));v.scale.set(spread,1/(spread*spread),spread); }
            if(l.cold==='lettuce') {v.scale.y=1-.45*(l.wilt||0);v.children.forEach(m=>m.material.color.setRGB(1-.18*(l.wilt||0),1-.12*(l.wilt||0),1));}
            v.scale.y*=scale;
            if(cap)cap.scale.set(v.scale.x,v.scale.y,1);
          }
          // Sparse toppings interleave; they do not support a solid plane at their tips.
          const overlap=support.overlap*(1-scale)/Math.max(1e-9,1-support.scale);
          h+=support.height*scale*(1-overlap);
        });
        if(!A.hasPatty(p)) {const at=this.passLayout.get('loose:'+p.id);if(at)pv.group.position.set(at.x,at.y,at.z);}
        group.userData.height=h;
        const plane=group.userData.plane||(group.userData.plane=new T.Plane());
        plane.normal.set(-Math.sin(phi),0,Math.cos(phi)); plane.constant=Math.sin(phi)*base.x-Math.cos(phi)*base.z;
        group.traverse(o=>{if(o.isMesh&&!o.userData.cutCap) { if(!!o.material.clippingPlanes!==clipping)o.material.needsUpdate=true; o.material.clippingPlanes=clipping?[plane]:null; }});
      }
    }
    syncItems(list) {
      const keep = new Set(list);
      for (const [it, v] of this.itemViews) if (!keep.has(it)) { v.dispose(); this.itemViews.delete(it); }
      for (const it of list) if (!this.itemViews.has(it)) this.itemViews.set(it, new ItemView(this, it));
    }
    viewOf(p) { return p ? this.views.get(p) : null; }
    isFlipping(p) { const v = this.viewOf(p); return !!v && (v.flipElapsed != null || p.flips !== v.lastFlips); }
    get pattyGroup() { const v = this.viewOf(this.selected); return v ? v.group : null; }
    get patty() { return this.selected; }
    /** Slice the selected patty along the plane facing the camera; nothing moves, only the cut. */
    setCutaway(on) {
      this.cutaway = on;
      const phi = this.controls.goal.azimuth + Math.PI / 2;
      for (const [p, v] of this.views) { const want = on && p === this.selected; if (v.cutaway !== want || (want && on)) v.setCutaway(want, phi); }
    }
    /**
     * A peek: the cook has just cut the patty open, so show the cut. The knife went in at some
     * angle nobody chose deliberately, so the slice is at a random azimuth — and it closes again
     * after a few seconds, back to whatever the cutaway button was set to.
     */
    peekCutaway(patty, seconds) {
      const v = this.viewOf(patty); if (!v) return;
      // wall-clock, not the frame's dt: this is how long the cook is looking at it, and it should
      // last the same few seconds whether the machine is drawing at 60 fps or at 4
      // one entry per patty, each on its own clock: cutting into a second burger must not leave the
      // first one lying open on the pan, and two peeks a second apart close a second apart
      this.peeks.set(patty, (root.performance ? performance.now() : Date.now()) + seconds * 1000);
      v.setCutaway(true, Math.random() * Math.PI * 2);
    }
    /** What is under the cursor: a patty, or one of the toppings sharing the pan. */
    pickPatty(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      const ndc = new T.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new T.Raycaster(); ray.setFromCamera(ndc, this.camera);
      const targets = []; for (const v of this.views.values()) { targets.push(v.mesh); if (v.cutMesh.visible) targets.push(v.cutMesh); }
      for (const v of this.itemViews.values()) if (v.group.visible) v.group.traverse((o) => { if (o.isMesh) targets.push(o); });
      if(this.mode==='stove'&&this.panGroup?.visible&&this.panMesh)targets.push(this.panMesh);
      const hits = ray.intersectObjects(targets, false);
      if(this.mode==='stove'&&this.stoveType==='charcoal') {
        const at=ray.ray.intersectPlane(new T.Plane(new T.Vector3(0,1,0),-this.PAN_Y),new T.Vector3());
        if(at&&Math.hypot(at.x,at.z)<=this.panR&&(!hits.length||ray.ray.origin.distanceTo(at)<hits[0].distance))return 'pan';
      }
      if (!hits.length) return null;
      if(hits[0].object===this.panMesh)return 'pan';
      const d = hits[0].object.userData;
      return d.patty || d.item || null;
    }
    // ---- per-frame update from the physics state
    setMode(mode) {
      this.mode = mode;
      this.stove.visible = mode === 'stove'; this.board.visible = mode === 'board';
      // Prep and cooking share the same daylight room.
      this.controls.reset(mode);
    }
    /**
     * One patty's atlas may be repainted per frame. Three burgers on a ticket would otherwise all
     * come due on the same frame and paint three megapixel canvases back to back; staggered, each
     * still gets its ten repaints a second and no single frame carries more than one.
     */
    claimTexBudget() { if (this.texBudget <= 0) return false; this.texBudget--; return true; }
    update(state, dt, cameraDt = dt) {
      this.clock += dt; this.texBudget = 1;
      const pan = state.pan, p = state.patty;
      this._updateRoomAir(state);
      if (this.peeks.size) {
        const now = root.performance ? performance.now() : Date.now();
        for (const [q, until] of this.peeks) {
          if (now < until) continue;
          const v = this.viewOf(q);
          if (v) v.setCutaway(this.cutaway && q === this.selected, this.controls.goal.azimuth + Math.PI / 2);
          this.peeks.delete(q);
        }
      }
      // stove: gas flames, electric coil glow (follows delivered power, so it lags), induction LED
      const knob = state.stove.knob / 10, stv = state.stove;
      if(this.hobDial)this.hobDial.rotation.y=Math.PI*.75-knob*Math.PI*1.5;
      if(this.hobPower)this.hobPower.color.setHex(knob>0?0xff823b:0x382519);
      this.hobLevels.forEach((m,i)=>m.material.color.setHex(i<Math.ceil(knob*10)?0xff823b:0x34221b));
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
        this.setBank(gr.bank || 0);
        // the ash on the bowl floor: loose wood/charcoal ash at ~250 kg/m³ over the 0.126 m² floor,
        // so it rises about 3 cm per kilogram, and it goes from dark grey to pale as it deepens
        if (this.ashDisc) {
          const m = (gr.ash || 0) + (gr.ashBowl || 0), depth = m / (250 * 0.126);
          this.ashDisc.position.y = this.ashY0 + depth;
          const pale = clamp(m / 0.15, 0, 1);
          this.ashMat.color.setRGB(0.30 + 0.32 * pale, 0.29 + 0.31 * pale, 0.26 + 0.29 * pale);
          this.ashDisc.scale.setScalar(1 + 0.15 * pale);
        }
        // the damper: 45° of throw from shut to wide, which is where the airflow number comes from
        if (this.ventWheel) this.ventWheel.rotation.y = (Math.PI / 4) * clamp(gr.topVent == null ? 1 : gr.topVent, 0, 1);
        // wood on the coals
        if (this.woodMeshes) {
          const woods = gr.woods || [];
          for (let i = 0; i < this.woodMeshes.length; i++) {
            const box = this.woodMeshes[i], wd = woods[woods.length - 1 - i]; // the newest chunk first
            if (!wd || wd.m <= 1e-6) { box.visible = false; continue; }
            box.visible = true;
            const side = Math.cbrt(wd.m / 700); // the chunk's own dimension, straight off its mass
            const h = box.userData.home;
            box.scale.set(side, side * 0.75, side * 0.9); // a split billet is wider than it is deep
            box.position.set(h.x, this.coalY + 0.020 + side * 0.375, h.z); // sitting proud on top of the lumps
            box.rotation.set(0.12, h.ry, 0.06);
            // bark brown → charcoal: the chunk chars from the outside in as it gives up its volatiles
            const burnt = clamp(1 - wd.m / wd.m0, 0, 1), hot = clamp((wd.T - 260) / 200, 0, 1);
            const mat = this.woodMats[i];
            mat.color.setRGB(lerp(0.62, 0.07, burnt), lerp(0.45, 0.06, burnt), lerp(0.26, 0.05, burnt));
            mat.emissiveIntensity = 0.5 * hot * hot * (0.8 + 0.2 * Math.sin(this.clock * 6 + i));
          }
        }
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
      this._updateOil(state);
      const depth=pan.oilDepth||0, deep=clamp(depth/.02,0,1);
      this.oilMat.opacity=.12+.38*deep;
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
      this.spill.visible = spillR > 0.01; this.spill.scale.set(spillR * 1.25, spillR*.85, 1);this.spill.position.x=this.panR*.4;this.spill.position.z=-this.panR*.35; this.spill.position.y = (this.stainY || 0.0012) + 0.0003;
      // grease fire around a pan, or flare-ups coming up through the grate under the meat
      const grill = this.stoveType === 'charcoal' && state.grill ? state.grill : null;
      const grillFlare = grill ? grill.flare : 0;
      const flare = this.stoveType === 'charcoal' ? (grillFlare > 0.04 ? grillFlare : 0) : (pan.flare || 0);
      // Fat burns where it lands, and it lands on the coals — so on a banked bed the bare half only
      // smokes (physics: BANK.flare = 0.15) and there are no flames over it. Meat dragged across to
      // finish leaves its flare behind it over the pile, which is the whole point of the two-zone
      // fire. `coalAt` is the same coal fraction the heat transfer uses, so the flames sit exactly
      // where the model says there is fuel.
      const floorR = (pan && pan.floorR) || this.panR;
      const coalFrac = (x) => (grill && grill.bank > 0.01 ? P.coalAt(grill, clamp(x / floorR, -1, 1)) : 1);
      const onGrate = grill ? (state.patties || []).filter((q) => q.where === 'pan' && coalFrac(q.pos.x) > 0.2) : [];
      // with nothing over the coals the flames burn on the pile itself, wherever it has been raked to
      const bedX = grill && grill.bank > 0.01 ? 0.45 * floorR : 0;
      for (let i = 0; i < this.flareFlames.length; i++) {
        const f = this.flareFlames[i];
        f.visible = flare > 0;
        if (flare <= 0) continue;
        const fl = 0.5 + 0.5 * Math.random();
        if (this.stoveType === 'charcoal') {
          // tongues of flame under and around whichever patties are dripping, licking up their sides
          const q = onGrate.length ? onGrate[i % onGrate.length] : null;
          const rr = q ? (q.D / 2) * (0.5 + 0.7 * ((i * 7919) % 100) / 100) : 0.12 * fl;
          const cx = q ? q.pos.x : bedX, cz = q ? q.pos.y : 0;
          const fx = cx + Math.cos(f.userData.a) * rr, fz = cz + Math.sin(f.userData.a) * rr;
          const cf = coalFrac(fx);
          if (cf < 0.15) { f.visible = false; continue; }  // ash under this tongue: nothing to burn
          f.position.set(fx, this.PAN_Y - 0.03, fz);
          f.rotation.order = 'YXZ'; f.rotation.y = -f.userData.a; f.rotation.z = -0.12 * fl;
          const len = (0.02 + 0.15 * Math.min(1, flare) * fl) * cf;
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
      setLin(this.oilMat,[lerp(235,173,Math.max(deep,fondT*.5)),lerp(205,119,Math.max(deep,fondT)),lerp(134,50,deep)]);
      this._paintDirt(pan, dt);

      // ---- patties: one view each; the selected one gets the probe and the cutaway
      const list = state.patties && state.patties.length ? state.patties : (this.previewPatty ? [this.previewPatty] : []);
      this.syncViews(list);
      const sel = state.patties && state.patties.length ? state.patty : this.previewPatty;
      if (sel !== this.selected) { this.selected = sel; if (this.cutaway) this.setCutaway(true); }
      const stoveOn = this.mode === 'stove';
      const plateBase = stoveOn ? { x: 0.42, y: 0.009, z: 0.12 } : { x: 0, y: 0, z: 0 };
      const offPan = list.filter((q) => q.where === 'rest' || q.where === 'cut');
      if (this.plate) this.plate.visible=false;
      // ---- the toppings: on the pan where they were put down, waiting on the pass once they are
      // off the heat, and stacked on the burger they were built onto once it is served
      const items = this.mode === 'stove' && state.items ? state.items : []; // toppings only exist once there is a stove under them
      this.syncItems(items);
      this.selectedItem = state.item || null;
      const waiting = items.filter(q => q.assembledTo==null && (q.where==='rest'||(q.where==='cut'&&q.burger==null)));
      const entries=offPan.filter(q=>q.assembledTo==null).map(q=>({key:q,r:Math.max(q.D/2,...(q.assembly||[]).map(l=>l.item?l.item.D/2:l.meat?l.meat.D/2:0))}));
      for(const q of offPan)if(q.assembly?.length&&!root.BurgerAssembly.hasPatty(q))entries.push({key:'loose:'+q.id,r:q.D/2});
      for(const it of waiting)entries.push({key:it,r:it.D/2});
      const layoutKey=entries.map(e=>(typeof e.key==='string'?e.key:(e.key.kind?'i':'p')+e.key.id)+':'+e.r.toFixed(3)).join('|');
      if(layoutKey!==this.passLayoutKey){this.passLayout=root.FoodShapes.passLayout(entries);this.passLayoutKey=layoutKey;}
      const pass=this.passLayout;
      const tiers=Math.max(0,...[...pass.values()].map(p=>p.tier));
      if(this.passTiers!==tiers) {
        if(this.passRack){this.scene.remove(this.passRack);disposeTree(this.passRack);}
        this.passRack=new T.Group();this.scene.add(this.passRack);this.passTiers=tiers;
        const mat=VA.material('steel',0xb3bab4);
        for(let i=1;i<=tiers;i++) {
          const tray=new T.Mesh(VA.roundedBox(.61,.008,.97,.0018),mat);tray.position.set(.555,i*.18-.003,0);tray.receiveShadow=tray.castShadow=true;this.passRack.add(tray);
          for(const x of [.262,.848])for(const z of [-.473,.473]){const leg=new T.Mesh(new T.CylinderGeometry(.004,.004,i*.18,8),mat);leg.position.set(x,i*.09,z);this.passRack.add(leg);}
        }
      }
      const stackOf = new Map();
      for (const q of list) {
        if (q.where !== 'cut') continue;
        let extra = 0;
        for (const it of items) {
          if (it.burger !== q.id || it.where !== 'cut' || it.kind === 'bun') continue;
          const v = this.itemViews.get(it); if (!v) continue;
          // every topping mesh is built with its underside at its own origin, so a layer starts
          // where the one under it ended: no air between the cheese and the bacon
          stackOf.set(it, extra);
          extra += v.layerH();
        }
        stackOf.set(q, extra);
      }
      const drag = this.dragging;
      let scraping = null;
      for (const q of list) {
        const v = this.views.get(q);
        const where = state.patties && state.patties.length ? q.where : 'board';
        let pos;
        if (where === 'pan') {
          // a patty being dragged follows the cursor; one on the blade is lifted off the metal
          const at = drag && drag.o === q ? drag.pos : q.pos;
          const u = q.scrapeT > 0 ? 1 - q.scrapeT : 0, lift = q.scrapeT > 0 ? 0.005 * Math.sin(Math.PI * u) : 0;
          if (q.scrapeT > 0) scraping = { p: q, at, u };
          pos = { x: at.x, y: 0, z: at.y, lift };
        }
        else if (where === 'oven') { const i = list.filter(q => q.where === 'oven').indexOf(q); pos = { x: .10 + (i % 2 ? .10 : -.10), y: -.48, z: -.34 + Math.floor(i / 2) * .20 }; }
        else if (where === 'board') pos = { x: 0, y: 0, z: 0 };
        else { pos=pass.get(q)||pass.get(list.find(p=>p.id===q.assembledTo))||plateBase; }
        if (this.forceTex) v.forceTex = true;
        v.stackH = stackOf.get(q) || 0;
        v.update(state, dt, where, pos, this.mode);
        q._viewPos = pos;
      }
      for (const it of items) {
        const v = this.itemViews.get(it); if (!v) continue;
        let pos;
        if (it.where === 'pan') { const at = drag && drag.o === it ? drag.pos : it.pos; pos = { x: at.x, y: this.panFloorY, z: at.y }; }
        else if (it.where === 'cut' && it.burger != null) {
          // on the burger: between the patty (and its cheese) and the top bun
          const host = list.find((q) => q.id === it.burger);
          const hv = host && this.views.get(host);
          if (hv) {
            const base = hv.group.position.y + host.h * (1 + 0.28 * host.dome) + host.cheeses.length * 0.0015;
            pos = { x: hv.group.position.x, y: base + (stackOf.get(it) || 0), z: hv.group.position.z };
            if (this.cutaway && host === this.selected) { const phi = hv.cutPhi || 0; v.setClipAt(-Math.sin(phi), Math.cos(phi), pos.x, pos.z); }
            else v.setClip(null);
          } else pos = { x: plateBase.x, y: plateBase.y, z: plateBase.z };
        } else {
          // waiting at the pass: a row along the front of the stovetop, in front of the plate
          pos = pass.get(it)||plateBase;
          v.setClip(null);
        }
        v.update(state, dt, it.where, pos, this.mode);
      }
      this.updateAssemblies(state, list, cameraDt);
      this.droppedEggViews ||= new Map();
      const dropped=state.grill?.droppedEggs||[];
      for(const [egg,v] of this.droppedEggViews)if(!dropped.includes(egg)){v.dispose();this.droppedEggViews.delete(egg);}
      for(const egg of dropped) {
        let v=this.droppedEggViews.get(egg);if(!v){v=new ItemView(this,egg);this.droppedEggViews.set(egg,v);}
        const fall=clamp(egg.dropAge/.45,0,1),char=clamp(egg.burned/Math.max(.0001,egg.dropMass*.20),0,1);
        this.eggDropRay ||= new T.Raycaster();
        this.eggDropRay.set(new T.Vector3(egg.pos.x,this.PAN_Y,egg.pos.y),new T.Vector3(0,-1,0));
        const landing=this.eggDropRay.intersectObjects([this.coals,this.ashDisc].filter(Boolean),false)[0]?.point.y??this.coalY;
        v.update(state,dt,'coals',{x:egg.pos.x,y:lerp(this.PAN_Y,landing+.002,fall*fall),z:egg.pos.y},this.mode);
        v.group.scale.set(1,.3+.7*(1-fall),1);
        v.group.scale.multiplyScalar(Math.max(.08,Math.sqrt(P.itemMass(egg)/egg.dropMass)));
        for(const mat of [v.whiteMat,v.yolkMat])mat.color.lerp(new T.Color(.012,.009,.007),char);
      }
      this.forceTex = false;
      // the spatula: it slides in under the patty and back out over the second the scrape takes,
      // from whichever side the camera is on, because that is the side the cook is standing
      if (this.spatula) {
        this.spatula.visible = !!scraping && stoveOn;
        if (scraping) {
          const R = scraping.p.D / 2, depth = Math.sin(Math.PI * scraping.u);
          const az = this.controls.azimuth, cx = scraping.at.x, cz = scraping.at.y;
          const out = R + 0.075 - depth * (R + 0.09);
          this.spatula.position.set(cx + Math.cos(az) * out, this.panFloorY + 0.0022, cz + Math.sin(az) * out);
          this.spatula.rotation.set(0, -az + Math.PI / 2, 0);
          this.spatula.rotation.x = 0; // set below, in the blade's own frame
          this.spatula.children[0].rotation.x = this.spatula.children[1].rotation.x = -0.06; // the blade rides tip-down under the crust
        }
      }
      // the finger, while a press test is running: down onto the middle of the patty from the
      // cook's side of the pan, and off again. Same second and a bit the physics charges for it.
      if (this.finger) {
        let pressing = null;
        for (const q of list) if (q.where === 'pan' && q.pressTestT > 0) { pressing = q; break; }
        this.finger.visible = !!pressing && stoveOn;
        if (pressing) {
          const u = clamp(1 - pressing.pressTestT / (P.TOUCH ? P.TOUCH.dwell : 1.2), 0, 1);
          const dip = Math.sin(Math.PI * u), az = this.controls.azimuth;
          const top = this.panFloorY + pressing.h * (1 + 0.28 * pressing.dome);
          this.finger.position.set(pressing.pos.x, top + 0.038 - 0.036 * dip, pressing.pos.y);
          this.finger.rotation.set(0, -az, 0);
        }
      }

      this._updateParticles(state, dt, list, stoveOn);

      this.controls.update(cameraDt);
      // Keep bounced light subtle; explicit wet-surface reflection strengths survive.
      this.scene.traverse(o=>{if(o.isMesh && o.material?.envMapIntensity===1)o.material.envMapIntensity=.22;});
      this.renderer.render(this.scene, this.camera);
    }
    /** Sizzle, steam, smoke, spatter, juice beads and fat drips around every patty on the pan. */
    _updateParticles(state, dt, list, stoveOn) {
      const d = state.diag;
      const patties=list.filter(q=>q.where==='pan');
      const onPan=patties.concat((state.items||[]).filter(q=>q.where==='pan'));
      const gy=this.panFloorY,oilDepth=this.stoveType==='charcoal'?0:(state.pan.oilDepth||0);
      const surfY=gy+Math.max(.0005,oilDepth);
      const weight=(q,kind)=>kind==='fat'?(q.fatRate || (q.lostFat>0?q.sc?.res?.fatDrip:0) || 0)
        :kind==='smoke'?(q.smoke || (q.faceDown?.charRate||0)*40):q.steamRate || q.steam || 0;
      const pick=(kind='steam')=>{
        let total=0;for(const q of onPan)total+=weight(q,kind);
        let choice=Math.random()*total;
        for(const q of onPan){choice-=weight(q,kind);if(choice<0)return q;}
        return null;
      };
      const panSpot=()=>{const a=Math.random()*Math.PI*2,rr=Math.sqrt(Math.random())*this.panR*.8;return[Math.cos(a)*rr,surfY,Math.sin(a)*rr];};
      const residueSpot=()=>{
        const count=Math.min(this.dirtSpots.length,Math.round(state.pan.fondBurnt/.000015));
        if(!count)return panSpot();
        const sp=this.dirtSpots[(Math.floor(Math.random()*count)*3+1)%this.dirtSpots.length];
        return[(sp.x-256)/256*this.panR,surfY,-(sp.y-256)/256*this.panR];
      };
      const oilSpot=()=>{
        const f=state.pan.film;if(!f?.total)return panSpot();let choice=Math.random()*f.total;
        for(let k=0;k<f.mass.length;k++){choice-=f.mass[k];if(choice<=0)return[(k%f.n)*f.cell-f.r,gy+f.mass[k]/(920*f.area),Math.floor(k/f.n)*f.cell-f.r];}
        return panSpot();
      };
      const smokeSpot=()=>{
        if(lidOn)return ventSpot();if(kettle)return panSpot();
        const choice=Math.random()*Math.max(.001,d.smoke),p=state.pan;
        if(choice<(p.smokeChar||0)+(p.smokeItems||0))return edge('smoke');
        return choice<(p.smokeChar||0)+(p.smokeItems||0)+(p.smokeFond||0)?residueSpot():oilSpot();
      };
      const edge=(kind='steam')=>{const q=pick(kind);if(!q)return panSpot();const a=Math.random()*Math.PI*2,rr=q.D*.51;return[q.pos.x+Math.cos(a)*rr,surfY,q.pos.y+Math.sin(a)*rr];};
      const anywhereTop=()=>{const q=pick();if(!q)return panSpot();const a=Math.random()*Math.PI*2,rr=Math.sqrt(Math.random())*q.D*.43;return[q.pos.x+Math.cos(a)*rr,gy+(q.h||this.itemViews.get(q)?.layerH()||.006)+.001,q.pos.y+Math.sin(a)*rr];};
      const any=onPan.length>0;
      const steamRate=stoveOn?d.steam*5000:0;
      const panSteamChance=d.steam>0?d.evapPan/d.steam:0;
      this.steam.update(dt,Math.min(steamRate,160),()=>Math.random()<panSteamChance?panSpot():Math.random()<.55?edge():anywhereTop(),.006);
      // Smoke: its colour and body are the fire's, not a constant. Thin blue smoke is volatiles
      // burning as they leave the wood; thick white smoke is volatiles that never found any air.
      // With the lid on, all of it leaves through the top vent, so that is where it is drawn from —
      // in a jet, because it is being pushed through a 6 cm hole rather than drifting off a bed.
      const kettle = this.stoveType === 'charcoal';
      const lidOn = kettle && !!state.lid && !!this.ventPos;
      if (kettle) {
        const kind = clamp(d.smokeKind || 0, 0, 1), dens = clamp(d.smokeDens || 0, 0, 3);
        this.smoke.mat.uniforms.color.value.setRGB(lerp(0.34, 0.87, kind), lerp(0.37, 0.86, kind), lerp(0.47, 0.83, kind));
        this.smoke.opts.alpha = 0.20 + 0.30 * kind + 0.18 * Math.min(1, dens);
        this.smoke.opts.size = 0.05 + 0.05 * kind + 0.04 * Math.min(1.5, dens);
        this.smoke.opts.rise = lidOn ? 0.34 : 0.11; // out of the vent under pressure, or drifting off the bed
        this.smoke.opts.spread = lidOn ? 0.012 : 0.03;
      } else { this.smoke.mat.uniforms.color.value.setHex(0x5a5a62); this.smoke.opts.alpha = 0.3; this.smoke.opts.size = 0.07; this.smoke.opts.rise = 0.11; this.smoke.opts.spread = 0.03; }
      const ventSpot = () => { const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * 0.022; return [this.ventPos.x + Math.cos(a) * rr, this.ventPos.y, this.ventPos.z + Math.sin(a) * rr]; };
      // a lid with the vent shut lets almost nothing out: the smoke stays in there, on the meat
      const smokeRate = stoveOn ? clamp(d.smoke, 0, 2) * 45 * (lidOn ? clamp(d.ventOut, 0, 1) : 1) : 0;
      this.smoke.update(dt, smokeRate, smokeSpot, lidOn ? 0.005 : 0.006);
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
        for (const q of patties) {
          if (oilDepth > q.h) { for (let i = parts.length - 1; i >= 0; i--) if (parts[i].q === q) parts.splice(i, 1); continue; }
          const want = clamp(Math.round(q.poolTop / 0.00001), 0, 120); let have = 0; for (const b of parts) if (b.q === q) have++;
          // a bead sits at a fixed place on the meat, not at a fixed place on the pan: keep its
          // offset from the patty's centre so it rides along when the spatula slides the patty
          while (have < want) { const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * (q.D / 2) * 0.9; parts.push({ q, dx: Math.cos(a) * rr, dz: Math.sin(a) * rr, x: q.pos.x + Math.cos(a) * rr, y: 0, z: q.pos.y + Math.sin(a) * rr, s: rand(0.5, 1.5), sy: 0.6 }); have++; }
          for (let i = parts.length - 1; i >= 0 && have > want; i--) if (parts[i].q === q) { parts.splice(i, 1); have--; }
          const R = q.D / 2, topY = gy + q.h;
          for (const b of parts) if (b.q === q) { const rr = Math.hypot(b.dx, b.dz); b.x = q.pos.x + b.dx; b.z = q.pos.y + b.dz; b.y = topY + 0.28 * q.dome * q.h * (1 - (rr / R) ** 2) + 0.0005; }
        }
        for (let i = parts.length - 1; i >= 0; i--) if (!onPan.includes(parts[i].q)) parts.splice(i, 1);
        this.beads.update(dt, () => true);
      }
      this.drips.acc += (stoveOn && any ? clamp(d.fatDrip * 3000, 0, 12) : 0) * dt;
      while (this.drips.acc >= 1) { this.drips.acc -= 1; const q = pick('fat'); if(!q)continue; const a = Math.random() * Math.PI * 2; this.drips.spawn({ q, x: q.pos.x + Math.cos(a) * (q.D / 2) * 1.01, y: gy + (q.h||this.itemViews.get(q)?.layerH()||.006) * rand(0.3, 0.9), z: q.pos.y + Math.sin(a) * (q.D / 2) * 1.01, a, age: 0, s: rand(0.6, 1.2), sy: 1.8 }); }
      const dripFloor = this.stoveType === 'charcoal' ? this.coalY + 0.012 : gy + 0.001;
      this.drips.update(dt, (b, dt) => { const q = b.q; if (q.where !== 'pan') return false; const free = b.y < gy - 0.002; b.vy = free ? (b.vy || 0) + 9.81 * dt : 0; b.y -= (free ? b.vy : 0.008) * dt; if (!free) { b.x = q.pos.x + Math.cos(b.a) * (q.D / 2) * 1.02; b.z = q.pos.y + Math.sin(b.a) * (q.D / 2) * 1.02; } b.age += dt; return b.y > dripFloor && b.age < 6; });
    }
    _paintDirt(pan, dt) {
      this.dirtClock += dt;
      const n = (v, u) => Math.min(this.dirtSpots.length, Math.round(v / u));
      // the first four are blob counts, the fifth the depth of the carbon film; the signature is
      // built without allocating (this runs every frame, the repaint below almost never does)
      const counts = [n(pan.fond, 0.00002), n(pan.fondBurnt, 0.000015), n(pan.cheeseBits || 0, 0.00015), n(pan.meatBits || 0, 0.0001), Math.round(clamp((pan.carbon || 0) / 0.004, 0, 1) * 100) / 100];
      const sig = counts[0] + '|' + counts[1] + '|' + counts[2] + '|' + counts[3] + '|' + counts[4] + (pan.T > 180 ? 'h' : 'c') + (this.stoveType === 'charcoal' ? 'g' : 'p');
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
      // On a grate there is no floor for residue to lie on: it is baked onto the bars. Mask the dirt
      // down to the rods' own footprints — 6 mm rods on 24 mm centres, the grate built in setStove —
      // so the gaps between the bars stay empty and the brush has something real to take off.
      if (this.stoveType === 'charcoal' && this.grateBars) {
        const px = 256 / this.panR, bars = this.grateBars; // canvas pixels per metre: the disc is panR in radius, 256 px
        // one path, one fill: destination-in keeps only what the source covers, so a rectangle at a
        // time would rub out every bar but the last
        c.globalCompositeOperation = 'destination-in'; c.fillStyle = '#000'; c.beginPath();
        for (let x = bars.x0; x < this.panR; x += bars.dx) c.rect(256 + (x - bars.w / 2) * px, 0, bars.w * px, 512);
        c.fill(); c.globalCompositeOperation = 'source-over';
      }
      this.dirtTex.needsUpdate = true;
    }
    puddleGeometry(n,seed) {
      const shape=new T.Shape();
      for(let i=0;i<=n;i++){const a=i/n*Math.PI*2,r=root.FoodShapes.puddleRadius(a,seed),x=Math.cos(a)*r,y=Math.sin(a)*r;i?shape.lineTo(x,y):shape.moveTo(x,y);}
      return new T.ShapeGeometry(shape);
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
      else { this.goal = { target: new T.Vector3(0, 0.045, 0), azimuth: -1.0, polar: 1.22, dist: 0.78 }; }
    }
    preset(name) {
      this.zoomStack = null;
      const pg = this.vp.pattyGroup && this.vp.patty ? this.vp.pattyGroup.position.clone().setY(this.vp.pattyGroup.position.y + (this.vp.patty.h || 0.02) / 2) : null;
      const itemView = this.vp.selectedItem && this.vp.itemViews.get(this.vp.selectedItem);
      const stack = this.vp.assemblyViews?.get(this.vp.selected);
      const t = itemView ? itemView.group.position.clone().add(new T.Vector3(0, .01, 0)) : stack ? stack.position.clone().add(new T.Vector3(0,(stack.userData.height||0)*.45,0)) : pg || (this.vp.mode === 'stove' ? new T.Vector3(0, this.vp.PAN_Y + 0.01, 0) : new T.Vector3(0, 0.01, 0));
      if (name === 'pan') { this.reset(this.vp.mode);this.goal.target.set(0,this.vp.panFloorY+.01,0);this.goal.dist=Math.max(.48,this.vp.panR*3.4); }
      if (name === 'oven') this.goal = { target: new T.Vector3(.10, -.35, -.29), azimuth: -Math.PI/2, polar: 1.38, dist: 1.15 };
      if (name === 'room') this.goal = { target: new T.Vector3(0, -.13, .12), azimuth: -1.05, polar: 1.07, dist: 2.5 };
      if (name === 'top') this.goal = { target: t, azimuth: this.goal.azimuth, polar: 0.12, dist: 0.5 };
      if (name === 'side') this.goal = { target: t.clone().setY(t.y + 0.01), azimuth: -Math.PI / 2, polar: 1.45, dist: 0.32 };
      if (name === 'close') this.goal = { target: t.clone().setY(t.y + 0.01), azimuth: this.goal.azimuth, polar: 1.1, dist: 0.16 };
      if (name === 'serve') { const az = -0.9; this.goal = { target: t.clone().add(new T.Vector3(0, 0.015, 0)), azimuth: az, polar: 1.2, dist: 0.34 }; }
      if (name === 'default') { this.reset(this.vp.mode); this.goal.target.copy(t); }
    }
    dolly(f) { this.goal.dist = clamp(this.goal.dist * f, 0.06, 2.5); }
    onDown(e) {
      this.el.setPointerCapture && this.el.setPointerCapture(e.pointerId);
      // a left-drag that starts on a patty or a topping moves it; anywhere else it orbits
      const moving = e.button === 0 && !e.shiftKey && this.vp.startDrag(e.clientX, e.clientY);
      this.drag = { b: e.button, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: 0, shift: e.shiftKey, moving };
    }
    onMove(e) {
      const d = this.drag; if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y; d.x = e.clientX; d.y = e.clientY; d.moved += Math.abs(dx) + Math.abs(dy);
      if (d.moving) { this.vp.moveDrag(e.clientX, e.clientY); return; }
      if (d.b === 0 && !d.shift) { this.goal.azimuth += dx * 0.006; this.goal.polar = clamp(this.goal.polar - dy * 0.006, 0.05, 1.52); }
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
      if (d.moving) {
        const drop = this.vp.endDrag();
        // a click that never went anywhere is a click: it selects, it does not move anything
        if (d.moved < 6 && drop && this.vp.onPick) this.vp.onPick(drop.o);
        return;
      }
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
      const dx = sp * Math.cos(this.azimuth), dy = Math.cos(this.polar), dz = sp * Math.sin(this.azimuth);
      // The room is enclosed: keep wide orbits inside its walls and window glass.
      let distance = this.dist;
      for (const [origin, direction, lo, hi] of [[this.target.x, dx, -2.60, 2.60], [this.target.z, dz, -2.60, 1.76]]) {
        if (Math.abs(direction) > 1e-6) distance = Math.min(distance, Math.max(.06, ((direction > 0 ? hi : lo) - origin) / direction));
      }
      this.cam.position.set(this.target.x + distance * dx, this.target.y + distance * dy, this.target.z + distance * dz);
      this.cam.lookAt(this.target);
    }
  }

  root.BurgerRender = { Viewport, PattyView, ItemView, nodeColour, faceColour, COL, ICOL };
})(window);
