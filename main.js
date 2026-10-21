"use strict";
const obsidian = require("obsidian");
const { Plugin, ItemView, Notice } = obsidian;

const VIEW_TYPE = "live-graph-view";
const EXCLUDE = /(^|\/)(Passwords|\.github|\.obsidian)(\/|$)/i;
const GROUP_HUES = { Companies: 205, Work: 285, Learning: 172, Scratch: 28, TaskNotes: 340, Templates: 255 };
const EVENT_TYPES = {
  ai: { hue: 190, intensity: 0.9 },
  search: { hue: 45, intensity: 0.6 },
  read: { hue: 130, intensity: 0.3 },
  write: { hue: 320, intensity: 0.25 },
};
const DEFAULT_PRESETS = {
  Galaxy: { yaw: 0.3, pitch: 1.0, zoom: 0.8, speed: 1, density: 1, spread: 1.4 },
  "Top-down": { yaw: 0, pitch: 1.55, zoom: 0.8, speed: 1.5, density: 1, spread: 1.4 },
  "Edge-on": { yaw: 0.4, pitch: 0.12, zoom: 0.85, speed: 0.8, density: 1, spread: 1.4 },
  "Close flyby": { yaw: 0.9, pitch: 0.65, zoom: 4, speed: 2.5, density: 1.3, spread: 1.4 },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

/* render-quality ladder (index = level): the auto mode steps down when frames get slow */
const LINK_KINDS = {
  local: { label: "Local", col: "#8fa4ff", a: 0.05, hue: null, dash: null },
  bridge: { label: "Bridges", col: "#7fe0ff", a: 0.1, hue: 190, dash: null },
  mutual: { label: "Mutual", col: "#ffd27f", a: 0.1, hue: 40, dash: null },
  index: { label: "Structure", col: "#a78bfa", a: 0.08, hue: 265, dash: [2, 5] },
  embed: { label: "Embeds", col: "#7dffb0", a: 0.12, hue: 145, dash: [1, 3] },
  prop: { label: "Properties", col: "#ff8fb8", a: 0.1, hue: 335, dash: [5, 3] },
};

const QUALITY = [
  { name: "Low", suns: 6, sys: 1, ships: 50, link: 0.2, stars: 60, gran: false, nebula: false, stride: 4, labels: 20, dpr: 1 },
  { name: "Medium", suns: 16, sys: 5, ships: 200, link: 0.5, stars: 140, gran: false, nebula: true, stride: 2, labels: 40, dpr: 1.25 },
  { name: "High", suns: 28, sys: 9, ships: 400, link: 0.8, stars: 220, gran: true, nebula: true, stride: 1, labels: 60, dpr: 1.5 },
  { name: "Ultra", suns: 40, sys: 14, ships: 600, link: 1, stars: 280, gran: true, nebula: true, stride: 1, labels: 80, dpr: 2 },
];

/* ---------- procedural planet textures (tileable in x) ---------- */
function hash2(x, y, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y, px, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px;
  return lerp(lerp(hash2(x0, yi, s), hash2(x1, yi, s), u), lerp(hash2(x0, yi + 1, s), hash2(x1, yi + 1, s), u), v);
}
function fbm(x, y, px, s, oct) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += amp * vnoise(x * f, y * f, px * f, s + o * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
function hsl2rgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

const PLANET_TYPES = ["gas", "rocky", "earth", "ice", "lava"];
const PLANET_SIZE = { gas: 1.55, rocky: 0.7, earth: 0.9, ice: 1.2, lava: 0.62 };
// Rough main-sequence luminosities (solar = 1) and typical orbital spacing ratios per spectral class.
// Orbits are handled in "scaled AU" u = AU / sqrt(L): frost line ~2.7, habitable zone ~0.95-1.5 for every star.
const STAR_RATIO = { O: 1.7, B: 1.7, A: 1.65, F: 1.6, G: 1.55, K: 1.45, M: 1.35 };
const FROST_U = 2.7, HZ_LO = 0.95, HZ_HI = 1.5;

/* Stellar colour: t=0 hot/young blue-white (O/B) ... t=1 cool/old red (M, red giants). */
const STAR_STOPS = [
  [0, [155, 176, 255]], [0.18, [185, 203, 255]], [0.34, [234, 239, 255]], [0.5, [255, 247, 232]],
  [0.64, [255, 228, 175]], [0.78, [255, 190, 115]], [0.9, [255, 145, 85]], [1, [255, 105, 65]],
];
function starColor(t) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < STAR_STOPS.length; i++) {
    if (t <= STAR_STOPS[i][0]) {
      const [t0, c0] = STAR_STOPS[i - 1], [t1, c1] = STAR_STOPS[i];
      return mix3(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return STAR_STOPS[STAR_STOPS.length - 1][1];
}
const starTempK = (t) => Math.round((2600 + Math.pow(1 - t, 1.8) * 27400) / 100) * 100;
function starClass(K) {
  return K >= 30000 ? "O" : K >= 10000 ? "B" : K >= 7500 ? "A" : K >= 6000 ? "F" : K >= 5200 ? "G" : K >= 3700 ? "K" : "M";
}
const rgba = (c, a) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

function makeGranulation() {
  const W = 128, H = 64;
  const c = document.createElement("canvas");
  c.width = W * 2;
  c.height = H;
  const g = c.getContext("2d");
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const n = fbm((x / W) * 8, (y / H) * 4, 8, 3, 4);
      const spot = fbm((x / W) * 3, (y / H) * 3, 3, 11, 3) > 0.66 ? 0.5 : 1;
      const v = clamp(128 + (n - 0.5) * 380, 0, 255) * spot;
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  g.drawImage(c, 0, 0, W, H, W, 0, W, H);
  return { c, W, H };
}

function makePlanetTexture(type, variant, hue) {
  const W = 256, H = 128, P = 4, seed = variant * 101 + 7;
  const c = document.createElement("canvas");
  c.width = W * 2;
  c.height = H;
  const g = c.getContext("2d");
  const img = g.createImageData(W, H);
  const gasLo = hsl2rgb(hue, 0.45, 0.28), gasHi = hsl2rgb(hue + 25, 0.5, 0.72), gasAlt = hsl2rgb(hue - 30, 0.4, 0.5);
  for (let y = 0; y < H; y++) {
    const lat = y / H;
    for (let x = 0; x < W; x++) {
      const u = (x / W) * P, v = lat * 2;
      let col;
      if (type === "gas") {
        const warp = fbm(u * 0.8, v * 3, P * 0.8, seed, 4);
        const band = 0.5 + 0.5 * Math.sin(lat * (14 + variant * 3) + warp * 6);
        col = mix3(mix3(gasLo, gasHi, band), gasAlt, fbm(u * 2, v * 8, P * 2, seed + 3, 3) * 0.45);
      } else if (type === "rocky") {
        const n = fbm(u, v, P, seed, 6);
        const crater = Math.pow(fbm(u * 3, v * 3, P * 3, seed + 9, 3), 3) * 2.2;
        col = mix3([62, 46, 40], [206, 168, 128], clamp(n * 1.2 - crater * 0.3, 0, 1));
        if (variant % 2) col = mix3(col, [190, 90, 55], 0.35);
      } else if (type === "earth") {
        const n = fbm(u, v, P, seed, 6);
        const pole = Math.abs(lat - 0.5) * 2;
        if (n < 0.5) col = mix3([8, 28, 90], [30, 90, 175], n * 2);
        else if (n < 0.6) col = [214, 196, 140];
        else col = mix3([40, 110, 50], [120, 100, 70], clamp((n - 0.6) * 3.5, 0, 1));
        if (pole > 0.86 + (n - 0.5) * 0.1) col = [238, 244, 250];
      } else if (type === "ice") {
        const n = fbm(u, v, P, seed, 5);
        col = mix3([206, 230, 248], [110, 160, 215], n);
        if (Math.abs(fbm(u * 2, v * 2, P * 2, seed + 5, 3) - 0.5) < 0.025) col = [60, 100, 160];
      } else {
        const n = fbm(u, v, P, seed, 5);
        col = [28, 10, 10];
        const crack = Math.abs(n - 0.5);
        if (crack < 0.07) col = mix3([255, 210, 60], [220, 60, 10], crack / 0.07);
        else col = mix3(col, [70, 25, 15], fbm(u * 3, v * 3, P * 3, seed + 2, 3));
      }
      const i = (y * W + x) * 4;
      img.data[i] = col[0];
      img.data[i + 1] = col[1];
      img.data[i + 2] = col[2];
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  g.drawImage(c, 0, 0, W, H, W, 0, W, H);

  let clouds = null;
  if (type === "earth") {
    clouds = document.createElement("canvas");
    clouds.width = W * 2;
    clouds.height = H;
    const cg = clouds.getContext("2d");
    const ci = cg.createImageData(W, H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const n = fbm((x / W) * P, (y / H) * 2 * 1.5, P, seed + 40, 5);
        const i = (y * W + x) * 4;
        ci.data[i] = ci.data[i + 1] = ci.data[i + 2] = 255;
        ci.data[i + 3] = clamp((n - 0.52) * 520, 0, 210);
      }
    cg.putImageData(ci, 0, 0);
    cg.drawImage(clouds, 0, 0, W, H, W, 0, W, H);
  }
  return { c, clouds, W, H };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r) {
  return Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(6.283185 * r());
}

function groupOf(path) {
  const i = path.indexOf("/");
  return i < 0 ? "(root)" : path.slice(0, i);
}

/* ------------------------------------------------------------------ */
/* Galaxy engine: data, layout, animation and rendering (no DOM deps)  */
/* ------------------------------------------------------------------ */
class Galaxy {
  constructor() {
    this.R = 900;
    this.w = 800;
    this.h = 600;
    this.dpr = 1;
    this.s0 = 0.3;
    this.cam = { yaw: 0.3, pitch: 1.0, zoom: 0.8, speed: 1, density: 1, spread: 1.4, pspeed: 1, orbit: 1, winding: 0.4, bhSize: 1.6 };
    this.camTween = null;
    this.opts = { links: true, labels: true, nebula: true, orphans: false, style: "pulse" };
    this.kinds = { local: true, bridge: true, mutual: true, index: true, embed: true, prop: true };
    this.tl = { on: false, t: 1, playing: false };
    this.edgesByKind = {};
    this.rnd = rng(20261020);
    this.lvl = 3;
    this.qMode = "auto";
    this.workMs = 6;
    this.perfT = 0;
    this.upT = 0;
    this.qChanged = false;
    this.paused = false;
    this.reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.nodes = [];
    this.byPath = new Map();
    this.edges = [];
    this.edgeKeys = new Set();
    this.first = true;
    this.spin = 0;
    this.target = { x: 0, y: 0, z: 0 };
    this.follow = null;
    this.hover = null;
    this.mouse = null;
    this.sprites = new Map();
    this.linkP = [];
    this.stream = [];
    this.clouds = [];
    this.log = [];
    this.rate = 0;
    this.bh = { energy: 0, flash: 0, x: 0, y: 0, r: 30, disk: [] };
    const r = rng(7);
    for (let i = 0; i < 140; i++)
      this.bh.disk.push({ ang: r() * 6.283, rad: 1.35 + r() * 2.1, hue: 18 + r() * 40, sz: 1 + r() * 1.6, ph: r() * 6 });
    // jet plasma: each particle drifts outwards along the polar axis, widening and kinking as it goes
    this.bh.jp = [];
    for (let i = 0; i < 240; i++) this.bh.jp.push({ u: r(), sp: 0.00035 + r() * 0.0005, off: r() * 2 - 1, ph: r() * 6.283, sz: 0.6 + r() * 0.8, side: i % 2 ? 1 : -1, knot: r() < 0.14 });
    this.bgStars = [];
    for (let i = 0; i < 280; i++) this.bgStars.push({ x: r(), y: r(), a: 0.15 + r() * 0.5, l: 0.2 + r() * 0.8, ph: r() * 6, tw: 0.5 + r() * 1.6, ta: 0.15 + r() * 0.4 });
    this.resize(800, 600, 1);
  }

  get Q() {
    return QUALITY[this.lvl];
  }

  setQuality(mode) {
    this.qMode = mode;
    if (mode !== "auto") this.lvl = clamp(+mode, 0, 3);
    this.qChanged = true;
  }

  /* called once per frame with the time step()+draw() took; adapts quality in auto mode */
  perf(work, now) {
    this.workMs += (work - this.workMs) * 0.05;
    if (this.qMode !== "auto" || now - this.perfT < 1500) return;
    if (this.workMs > 13 && this.lvl > 0) {
      this.lvl--;
      this.perfT = now;
      this.upT = now;
      this.qChanged = true;
    } else if (this.workMs < 6 && this.lvl < 3 && now - this.upT > 10000) {
      this.lvl++;
      this.perfT = now;
      this.upT = now;
      this.qChanged = true;
    }
  }

  resize(w, h, dpr) {
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.bgCache = null;
    this.s0 = (Math.min(w * 0.8, h) * 0.46) / this.R;
    this.cx = w * 0.45;
    this.cy = h * 0.5;
    this.bh.x = this.cx;
    this.bh.y = this.cy;
  }

  /* ---------- data ---------- */

  setGraph(files, resolved, headings, extra) {
    const present = new Set(files.map((f) => f.path));
    const keys = new Set();
    const mutual = new Set();
    const list = [];
    for (const src of Object.keys(resolved)) {
      if (!present.has(src)) continue;
      for (const dst of Object.keys(resolved[src])) {
        if (dst === src || !present.has(dst)) continue;
        const key = src < dst ? src + "|" + dst : dst + "|" + src;
        if (resolved[dst] && resolved[dst][src]) mutual.add(key);
        if (keys.has(key)) continue;
        keys.add(key);
        list.push([src, dst, key]);
      }
    }
    for (const p of [...this.byPath.keys()]) if (!present.has(p)) this.byPath.delete(p);
    for (const f of files) {
      if (this.byPath.has(f.path)) continue;
      const seed = hashStr(f.path);
      const group = groupOf(f.path);
      const i = f.path.lastIndexOf("/");
      this.byPath.set(f.path, {
        path: f.path, name: f.basename, group, folder: i < 0 ? "" : f.path.slice(0, i),
        seed, deg: 0, nbrs: [], r: 2,
        rad: 0, th: 0, z: 0, tr: 0, tth: 0, tz: 0, hue: 0, base: 0,
        scale: this.first ? 1 : 0, heat: this.first ? 0 : 1, phase: (seed % 628) / 100,
        sx: 0, sy: 0, p: 1, dep: 0, wx: 0, wy: 0, wz: 0, mtime: 0, temp: 0.5, sf: 1, rgb: [255, 240, 220], planets: null,
      });
    }
    for (const f of files) {
      const n = this.byPath.get(f.path);
      if (n) {
        n.mtime = (f.stat && f.stat.mtime) || 0;
        n.ctime = (f.stat && (f.stat.ctime || f.stat.mtime)) || 0;
        n.heads = (headings && headings.get(f.path)) || [];
        n.usage = (this.usage && this.usage.get(f.path)) || 0;
      }
    }
    this.nodes = [...this.byPath.values()];
    for (const n of this.nodes) {
      n.deg = 0;
      n.nbrs = [];
      n.planets = null;
    }
    const edges = [];
    for (const [s, d, key] of list) {
      const a = this.byPath.get(s);
      const b = this.byPath.get(d);
      if (!a || !b) continue;
      a.deg++;
      b.deg++;
      a.nbrs.push(b);
      b.nbrs.push(a);
      const isIndex = (n) => n.name.startsWith("_");
      const kind = extra && extra.embed && extra.embed.has(key) ? "embed"
        : extra && extra.prop && extra.prop.has(key) ? "prop"
        : isIndex(a) || isIndex(b) ? "index"
        : mutual.has(key) ? "mutual"
        : a.group !== b.group ? "bridge" : "local";
      edges.push({ a, b, key, kind, bend: (hashStr(String(key)) % 2 ? 1 : -1) * (0.07 + (hashStr(String(key)) % 9) / 100) });
    }
    this.edges = edges;
    this.edgesByKind = {};
    for (const e of edges) (this.edgesByKind[e.kind] = this.edgesByKind[e.kind] || []).push(e);
    let tMin = Infinity, tMax = 0;
    for (const n of this.nodes) if (n.ctime) { tMin = Math.min(tMin, n.ctime); tMax = Math.max(tMax, n.ctime); }
    this.tlMin = isFinite(tMin) ? tMin : 0;
    this.tlMax = Math.max(tMax, this.tlMin + 1);
    this.edgeKeys = keys;
    for (const n of this.nodes) n.r = 1.3 + Math.sqrt(n.deg) * 1.1;
    this.layout();
    this.reseedLinkParticles();
    this.first = false;
  }

  windOff(rotR) {
    return (this.wind || 0) * 2.7 * Math.log(1 + rotR / (0.14 * this.R));
  }

  layout() {
    const ns = this.nodes;
    const N = ns.length;
    if (!N) return;
    const R = this.R;
    const ARMS = 4;
    const byTime = [...ns].sort((a, b) => a.mtime - b.mtime);
    byTime.forEach((n, i) => (n.age01 = 1 - i / Math.max(1, N - 1)));

    // clusters = sub-folders with enough notes; the rest become scattered field stars
    const sub = (n) => {
      const parts = n.path.split("/");
      return parts.length > 2 ? parts[0] + "/" + parts[1] : n.group;
    };
    const MIN = 5;
    const tally = (keyOf) => {
      const m = new Map();
      for (const n of ns) m.set(keyOf(n), (m.get(keyOf(n)) || 0) + 1);
      return m;
    };
    const subCount = tally(sub);
    const grpCount = tally((n) => n.group);
    const clusterOf = (n) => {
      const s = sub(n);
      if (subCount.get(s) >= MIN) return s;
      return grpCount.get(n.group) >= MIN * 3 ? n.group : null;
    };
    const clusters = new Map();
    const field = [];
    for (const n of ns) {
      const key = clusterOf(n);
      n.cluster = key;
      if (key === null) field.push(n);
      else {
        if (!clusters.has(key)) clusters.set(key, { key, notes: [], busy: 0, age: 0 });
        clusters.get(key).notes.push(n);
      }
    }
    const busyOf = (n) => n.deg + 4 * (n.usage || 0);
    for (const c of clusters.values()) {
      c.busy = c.notes.reduce((s, n) => s + busyOf(n), 0) / Math.sqrt(c.notes.length) + 0.2 * c.notes.length;
      c.age = c.notes.reduce((s, n) => s + n.age01, 0) / c.notes.length;
    }
    // busy / well-connected clusters sit at the centre, old ones slightly more so
    const list = [...clusters.values()];
    const bp = new Map(), ap = new Map();
    [...list].sort((a, b) => a.busy - b.busy).forEach((c, i) => bp.set(c, i / Math.max(1, list.length - 1)));
    [...list].sort((a, b) => a.age - b.age).forEach((c, i) => ap.set(c, i / Math.max(1, list.length - 1)));
    list.forEach((c) => (c.score = 0.75 * bp.get(c) + 0.25 * ap.get(c)));
    list.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));

    list.forEach((c, i) => {
      const rnk = list.length > 1 ? i / (list.length - 1) : 0;
      const hr = rng(hashStr(c.key));
      c.rad = R * (0.3 + 0.67 * Math.pow(rnk, 0.9)) * (1 + gauss(hr) * 0.05);
      const arm = i % ARMS;
      const twist = 0;
      c.th = arm * (6.283185 / ARMS) + twist + gauss(hr) * 0.22;
      c.sigma = clamp(9 + 5.5 * Math.sqrt(c.notes.length), 14, R * 0.15);
      const g = c.notes[0].group;
      c.hue = ((g in GROUP_HUES ? GROUP_HUES[g] : hashStr(g) % 360) + ((hashStr(c.key) % 50) - 25) + 360) % 360;
      c.cx = c.rad * Math.cos(c.th);
      c.cy = c.rad * Math.sin(c.th);
    });

    this.clusterList = list;
    const place = (n, x, y, z, rotR) => {
      n.tr = Math.max(4, Math.hypot(x, y));
      n.tth = Math.atan2(y, x);
      n.tz = z;
      n.craft = null;
      n.rotR = rotR;
      if (this.first || n.scale === 0) {
        n.rad = n.tr;
        n.th = n.tth;
        n.z = n.tz;
      }
    };
    for (const c of list) {
      for (const n of c.notes) {
        const rnd = rng(n.seed);
        // old notes sit tight in the nebula core, young ones form its halo; hubs sink to the core
        const spreadK = (0.6 + 0.9 * (1 - n.age01)) / (1 + 0.03 * n.deg);
        const dx = gauss(rnd) * c.sigma * spreadK, dy = gauss(rnd) * c.sigma * spreadK;
        const rot = c.th;
        const ox = dx * Math.cos(rot) - dy * Math.sin(rot) * 0.7;
        const oy = dx * Math.sin(rot) + dy * Math.cos(rot) * 0.7;
        // thin disk, with a spherical bulge around the centre
        const bulge = Math.exp(-Math.pow(c.rad / (0.28 * R), 2));
        const zs = R * 0.006 + c.sigma * 0.05 + bulge * R * 0.07;
        place(n, c.cx + ox, c.cy + oy, gauss(rnd) * zs, c.rad);
        n.hue = (c.hue + ((n.seed % 30) - 15) + 360) % 360;
        n.base = c.hue;
      }
    }
    field.sort((a, b) => busyOf(b) - busyOf(a) || a.seed - b.seed);
    field.forEach((n, i) => {
      const rnd = rng(n.seed);
      const rnk = field.length > 1 ? i / (field.length - 1) : 0;
      if (rnd() < 0.04) {
        // thin central bulge ring, kept clear of the black hole
        const bs = R * 0.09;
        const a = rnd() * 6.283185, rr = R * 0.12 + Math.abs(gauss(rnd)) * bs;
        place(n, rr * Math.cos(a), rr * Math.sin(a), gauss(rnd) * bs * 0.7, R * 0.12);
      } else {
        const rad = R * (0.3 + 0.7 * Math.pow(rnd(), 0.85)) * (1 + gauss(rnd) * 0.03);
        const th = rnd() < 0.65 ? Math.floor(rnd() * ARMS) * (6.283185 / ARMS) + gauss(rnd) * 0.35 : rnd() * 6.283185;
        place(n, rad * Math.cos(th), rad * Math.sin(th), gauss(rnd) * (R * 0.012 + rad * 0.02), rad);
      }
      void rnk;
      const g = n.group;
      n.base = g in GROUP_HUES ? GROUP_HUES[g] : hashStr(g) % 360;
      n.hue = (n.base + ((n.seed % 40) - 20) + 360) % 360;
    });

    // star temperature: age, and a redder core population
    for (const n of ns) {
      const r01 = clamp(n.tr / R, 0, 1);
      const tRaw = 0.18 + 0.5 * n.age01 + 0.3 * (1 - r01) + gauss(rng(n.seed + 77)) * 0.1;
      n.temp = 1 - Math.pow(1 - clamp(tRaw, 0, 1), 1.35);
      n.rgb = starColor(n.temp);
      n.dotCol = rgba(n.rgb, 1);
      n.K = starTempK(n.temp);
      n.cls = starClass(n.K);
      const giant = n.temp > 0.8 && n.deg >= 8;
      n.sf = (1.3 - 0.6 * n.temp) * (giant ? 1.6 : 1);
    }

    // nebula clouds per cluster, tinted by the cluster hue, rotating rigidly with it
    const cr = rng(99);
    this.clouds = [];
    for (const c of list) {
      const count = clamp(2 + Math.floor(c.notes.length / 25), 2, 9);
      for (let i = 0; i < count; i++) {
        const dx = gauss(cr) * c.sigma * 0.7, dy = gauss(cr) * c.sigma * 0.7;
        const x = c.cx + dx, y = c.cy + dy;
        this.clouds.push({
          rad: Math.hypot(x, y), th: Math.atan2(y, x), z: gauss(cr) * c.sigma * 0.1, rotR: c.rad,
          size: c.sigma * (3 + cr() * 2.5), hue: (c.hue + (cr() - 0.5) * 50 + 360) % 360,
          alpha: 0.05 + 0.07 * cr() + 0.05 * c.score, v: Math.floor(cr() * 3),
        });
      }
    }
    for (let i = 0; i < 9; i++)
      this.clouds.push({ rad: cr() * R * 0.2, th: cr() * 6.28, z: 0, rotR: R * 0.1, size: 220 + cr() * 180, hue: 30 + cr() * 25, alpha: 0.04, v: i % 3 });
    // spiral arms: faint gas lanes and dust along the 4 arms, wound by the same Arm winding control as the clusters
    // (they share rotR, so at 0 winding the arms are straight spokes and they curl up as the slider rises)
    for (let i = 0; i < 56; i++) {
      const rr = R * (0.15 + 0.85 * Math.pow(cr(), 0.8));
      this.clouds.push({
        rad: rr, th: (i % ARMS) * (6.283185 / ARMS) + gauss(cr) * 0.05, z: gauss(cr) * R * 0.004, rotR: rr,
        size: R * (0.1 + 0.08 * cr()), hue: 215 - 175 * Math.exp(-rr / (0.35 * R)) + (cr() - 0.5) * 20, alpha: 0.035 + 0.03 * cr(), v: Math.floor(cr() * 3),
      });
    }
    this.armDust = [];
    for (let i = 0; i < 700; i++) {
      const rr = R * (0.1 + 0.9 * Math.pow(cr(), 0.85));
      const arm = i % ARMS;
      this.armDust.push({
        rad: rr, th: arm * (6.283185 / ARMS) + gauss(cr) * (0.05 + 0.12 * rr / R), z: gauss(cr) * R * 0.008, rotR: rr,
        hue: 215 - 175 * Math.exp(-rr / (0.35 * R)) + (cr() - 0.5) * 30, s: 1 + cr() * 1.8, a: 0.25 + 0.5 * cr(),
      });
    }
    this.clusterInfo = list.map((c) => ({ key: c.key, n: c.notes.length }));
  }

  reseedLinkParticles() {
    const E = this.edges.length;
    const want = E ? Math.floor(clamp(E * 0.5, 0, 1200) * this.cam.density * 4) : 0;
    while (this.linkP.length < want)
      this.linkP.push({ e: null, t: this.rnd(), sp: 0.1 + this.rnd() * 0.25, dir: this.rnd() < 0.5 ? 1 : -1, sz: 0.8 + this.rnd() * 0.9 });
    this.linkP.length = want;
    for (const p of this.linkP) p.e = this.edges[Math.floor(this.rnd() * E)];
  }

  /* ---------- usage events ---------- */

  resolve(ev) {
    const out = [];
    const seen = new Set();
    const add = (n) => {
      if (n && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    };
    for (let p of ev.paths || []) {
      p = String(p).replace(/\\/g, "/");
      add(this.byPath.get(p) || this.byPath.get(p + ".md"));
    }
    if (!out.length && ev.query) {
      const toks = String(ev.query).toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
      if (toks.length) {
        const scored = [];
        for (const n of this.nodes) {
          const lp = n.path.toLowerCase();
          let s = 0;
          for (const t of toks) if (lp.includes(t)) s++;
          if (s) scored.push([s, n]);
        }
        scored.sort((a, b) => b[0] - a[0]);
        scored.slice(0, 40).forEach(([, n]) => add(n));
      }
    }
    return out;
  }

  ingest(ev) {
    const type = EVENT_TYPES[ev.type] ? ev.type : "search";
    const cfg = EVENT_TYPES[type];
    const intensity = clamp(Number(ev.intensity) || cfg.intensity, 0.05, 1.5);
    let nodes = this.resolve(ev);
    const fallback = !nodes.length;
    if (!nodes.length && this.nodes.length) {
      const outer = this.nodes.filter((n) => n.tr > this.R * 0.6);
      const pool = outer.length ? outer : this.nodes;
      for (let i = 0; i < 4; i++) nodes.push(pool[Math.floor(Math.random() * pool.length)]);
    }
    if (!nodes.length) return 0;
    const total = Math.min(180, Math.round((6 + 5 * Math.sqrt(nodes.length)) * intensity * 1.5));
    const per = clamp(Math.ceil(total / nodes.length), 1, 12);
    nodes.forEach((n, i) => {
      n.heat = 1;
      if (!fallback && ev.source !== "demo") {
        this.usage = this.usage || new Map();
        n.usage = (n.usage || 0) + intensity * (type === "read" ? 0.3 : 1);
        this.usage.set(n.path, n.usage);
        this.layoutDirty = true;
        this.usageDirty = true;
      }
      for (let k = 0; k < per; k++) {
        this.stream.push({
          kind: "out", n, t: -(Math.random() * 1.1 + i * 0.03), sp: (0.28 + 0.5 * intensity) * (0.8 + Math.random() * 0.4),
          sz: (0.9 + intensity * 1.6) * (0.7 + Math.random() * 0.6), hue: cfg.hue + (Math.random() - 0.5) * 24,
          sign: Math.random() < 0.5 ? -1 : 1, px: NaN, py: NaN,
        });
      }
      for (const nb of n.nbrs.slice(0, 6))
        for (let k = 0; k < 2; k++)
          this.stream.push({ kind: "burst", n, to: nb, t: -Math.random() * 0.5, sp: 0.8 + Math.random() * 0.8 * intensity, sz: 1.2 + intensity, hue: cfg.hue, px: NaN, py: NaN });
    });
    if (this.stream.length > 4000) this.stream.splice(0, this.stream.length - 4000);
    this.bh.flash = Math.min(1.5, this.bh.flash + intensity * 0.6);
    const label = ev.query || (ev.paths && ev.paths[0]) || "";
    this.log.push({ text: `${type.toUpperCase()} · ${String(label).slice(0, 48)} · ${nodes.length} notes`, hue: cfg.hue, t: performance.now() });
    if (this.log.length > 6) this.log.shift();
    this.rate = Math.min(1.5, this.rate + intensity * 0.4);
    return nodes.length;
  }

  /* ---------- camera state / presets ---------- */

  getState() {
    const c = this.cam;
    return { yaw: +c.yaw.toFixed(3), pitch: +c.pitch.toFixed(3), zoom: +c.zoom.toFixed(3), speed: +c.speed.toFixed(2), density: +c.density.toFixed(2), spread: +c.spread.toFixed(2), pspeed: +c.pspeed.toFixed(2), orbit: +c.orbit.toFixed(2), winding: +c.winding.toFixed(2), bhSize: +(c.bhSize || 1.6).toFixed(2) };
  }

  applyState(s, instant) {
    if (instant) Object.assign(this.cam, s);
    else this.camTween = Object.assign({}, this.cam, s);
    this.follow = null;
    if (instant) this.target = { x: 0, y: 0, z: 0 };
    else this.homing = true;
  }

  home() {
    this.applyState(this.homeState || DEFAULT_PRESETS.Galaxy);
  }

  /* world-space vectors of the screen plane, for panning */
  planeVectors() {
    const cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw), cp = Math.cos(this.cam.pitch), sp = Math.sin(this.cam.pitch);
    return { r: [cy, -sy, 0], u: [-sp * sy, -sp * cy, cp] };
  }

  panBy(dxPx, dyPx) {
    const { r, u } = this.planeVectors();
    const f = 1 / (this.s0 * this.cam.zoom);
    const sxw = -dxPx * f, syw = dyPx * f;
    this.target.x += r[0] * sxw + u[0] * syw;
    this.target.y += r[1] * sxw + u[1] * syw;
    this.target.z += r[2] * sxw + u[2] * syw;
    this.follow = null;
    this.homing = false;
  }

  zoomAt(factor, mx, my) {
    const c = this.cam;
    const nz = clamp(c.zoom * factor, 0.15, 40);
    if (!this.follow) {
      // keep the point under the cursor fixed while zooming
      const f0 = 1 / (this.s0 * c.zoom), f1 = 1 / (this.s0 * nz);
      const { r, u } = this.planeVectors();
      const ox = mx - this.cx, oy = my - this.cy;
      const a = ox * (f0 - f1), b = -oy * (f0 - f1);
      this.target.x += r[0] * a + u[0] * b;
      this.target.y += r[1] * a + u[1] * b;
      this.target.z += r[2] * a + u[2] * b;
      this.homing = false;
    }
    c.zoom = nz;
  }

  loadUsage(obj) {
    this.usage = new Map(Object.entries(obj || {}));
  }

  exportUsage() {
    const out = {};
    const top = [...(this.usage || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 3000);
    for (const [k, v] of top) out[k] = +v.toFixed(2);
    return out;
  }

  /* ---------- animation ---------- */

  step(dt) {
    const c = this.cam;
    const tl = this.tl;
    if (tl.playing) {
      tl.t = Math.min(1, tl.t + dt / 1000 / 25);
      if (tl.t >= 1) tl.playing = false;
    }
    const cutoff = this.tlMin + tl.t * (this.tlMax - this.tlMin);
    for (const n of this.nodes) {
      const hid = tl.on && n.ctime > cutoff;
      if (n.hid && !hid) n.heat = Math.max(n.heat, 0.9);
      n.hid = hid;
    }
    if (this.camTween) {
      const t = this.camTween;
      let done = true;
      for (const k of ["yaw", "pitch", "zoom", "speed", "density", "spread", "pspeed"]) {
        c[k] += (t[k] - c[k]) * 0.08;
        if (Math.abs(t[k] - c[k]) > 0.002 * Math.max(1, Math.abs(t[k]))) done = false;
      }
      if (done) {
        Object.assign(c, t);
        this.camTween = null;
      }
    }
    this.spin += this.paused ? 0 : (dt / 1000) * 0.08 * c.speed * (this.reduced ? 0.2 : 1);
    // arm winding is its own control; direction follows the rotation sign
    const windT = c.winding * (c.speed < 0 ? 1 : -1);
    this.wind = (this.wind ?? windT) + (windT - (this.wind ?? windT)) * 0.04;
    if (this.homing) {
      const t = this.target;
      t.x *= 0.92; t.y *= 0.92; t.z *= 0.92;
      if (Math.hypot(t.x, t.y, t.z) < 0.5) {
        this.target = { x: 0, y: 0, z: 0 };
        this.homing = false;
      }
    }
    if (this.layoutDirty && performance.now() - (this.lastLayout || 0) > 20000) {
      this.layoutDirty = false;
      this.lastLayout = performance.now();
      this.layout();
    }
    const R = this.R;
    const S = c.spread;
    for (const n of this.nodes) {
      n.rad += (n.tr - n.rad) * 0.06;
      n.th += Math.atan2(Math.sin(n.tth - n.th), Math.cos(n.tth - n.th)) * 0.06;
      n.z += (n.tz - n.z) * 0.06;
      n.scale += (1 - n.scale) * 0.1;
      if (n.heat > 0) n.heat = Math.max(0, n.heat - dt / 2600);
      const th = n.th + this.spin * (0.35 / (0.15 + n.rotR / R)) + this.windOff(n.rotR);
      n.wx = n.rad * S * Math.cos(th);
      n.wy = n.rad * S * Math.sin(th);
      n.wz = n.z * S;
    }
    if (this.follow) {
      const f = this.follow;
      this.target.x += (f.wx - this.target.x) * 0.06;
      this.target.y += (f.wy - this.target.y) * 0.06;
      this.target.z += (f.wz - this.target.z) * 0.06;
    }
    const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    const D = 2.2 * R, k = this.s0 * c.zoom;
    for (const n of this.nodes) {
      const x = n.wx - this.target.x, y = n.wy - this.target.y, z = n.wz - this.target.z;
      const x1 = x * cy - y * sy;
      const y1 = x * sy + y * cy;
      const Y = z * cp - y1 * sp;
      const dep = y1 * cp + z * sp;
      n.p = D / Math.max(60, D + dep);
      n.sx = this.cx + x1 * n.p * k;
      n.sy = this.cy - Y * n.p * k;
      n.dep = dep;
    }
    this.cosy = cy; this.siny = sy; this.cosp = cp; this.sinp = sp;

    const bh = this.bh;
    // the black hole sits at the galaxy centre (world origin) and follows pan/zoom/rotation
    {
      const x = -this.target.x, y = -this.target.y, z = -this.target.z;
      const y1 = x * sy + y * cy;
      const dep = y1 * cp + z * sp;
      const p = D / Math.max(60, D + dep);
      bh.x = this.cx + (x * cy - y * sy) * p * k;
      bh.y = this.cy - (z * cp - y1 * sp) * p * k;
      bh.p = p;
      bh.r = Math.max(5, Math.min(this.w, this.h) * 0.018) * clamp(Math.sqrt(c.zoom), 0.8, 2.2) * clamp(c.bhSize || 1.6, 0.3, 4);
    }
    // jets: only while data is being swallowed
    bh.jet = (bh.jet || 0) + (clamp(bh.energy / 0.5, 0, 1) * 0.85 + clamp(bh.flash, 0, 1) * 0.3 - (bh.jet || 0)) * (1 - Math.exp(-dt / (bh.jet > 0 ? 500 : 250)));
    bh.energy *= Math.exp(-dt / 2200);
    bh.flash *= Math.exp(-dt / 700);
    this.rate *= Math.exp(-dt / 2500);
    for (const q of bh.jp) {
      q.u += dt * q.sp * (0.6 + bh.jet);
      if (q.u > 1) q.u -= 1;
    }
    for (const d of bh.disk) d.ang += (dt / 1000) * (0.9 / Math.pow(d.rad, 1.5)) * (1 + bh.energy * 2 + bh.flash);

    // ambient particles between linked notes; more of them the closer you zoom
    const zf = clamp(Math.pow(c.zoom / 0.8, 0.9), 1, 4);
    this.linkAct = Math.min(this.linkP.length, Math.floor((this.linkP.length / 4) * zf * this.Q.link * (this.reduced ? 0.3 : 1)));
    const onScr = (e) => e && e.a.sx > -60 && e.a.sx < this.w + 60 && e.a.sy > -60 && e.a.sy < this.h + 60;
    for (let i = 0; i < this.linkAct; i++) {
      const p = this.linkP[i];
      if (!p.e) continue;
      const hot = Math.max(p.e.a.heat, p.e.b.heat);
      p.t += (dt / 1000) * p.sp * (1 + hot * 4) * c.pspeed;
      if (p.t >= 1) {
        p.t = 0;
        let e = this.edges[Math.floor(this.rnd() * this.edges.length)];
        if (c.zoom > 1.5) for (let tr = 0; tr < 8 && !onScr(e); tr++) e = this.edges[Math.floor(this.rnd() * this.edges.length)];
        p.e = e;
        p.dir = this.rnd() < 0.5 ? 1 : -1;
      }
    }

    // usage particles
    for (let i = this.stream.length - 1; i >= 0; i--) {
      const p = this.stream[i];
      p.t += (dt / 1000) * p.sp * c.pspeed;
      if (p.t >= 1) {
        if (p.kind === "out") bh.energy = Math.min(3, bh.energy + 0.015 * p.sz);
        else if (p.to) p.to.heat = Math.max(p.to.heat, 0.55);
        this.stream.splice(i, 1);
      }
    }
  }

  /* ---------- tiny alien craft: design comes from the source note ---------- */

  shipSprite(tier, variant, hue) {
    const key = `ship${tier}-${variant}-${hue}`;
    let c = this.sprites.get(key);
    if (c) return c;
    // building a ship sprite is costly: cap per frame, callers fall back to a dot until it exists
    if (this.shipGen <= 0) return null;
    this.shipGen--;
    const S = 128;
    c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d");
    const r = rng(hashStr(key));
    g.scale(2, 2);
    g.translate(32, 32);
    g.lineJoin = "round";
    g.lineCap = "round";
    const fam = variant % 6;
    const acc = `hsl(${hue},70%,58%)`;
    const rim = `hsla(${hue},25%,70%,0.45)`;
    // chrome-like banded metal: bright top edge, black core, soft bounce light below
    const metal = (y0, y1, lit) => {
      const b = g.createLinearGradient(0, y0, 0, y1);
      b.addColorStop(0, `hsl(${hue},16%,${lit ? 52 : 17}%)`);
      b.addColorStop(0.22, `hsl(${hue},14%,13%)`);
      b.addColorStop(0.62, `hsl(${hue},16%,3%)`);
      b.addColorStop(0.9, `hsl(${hue},20%,12%)`);
      b.addColorStop(1, `hsl(${hue},16%,6%)`);
      return b;
    };
    const part = (path, y0, y1, lw, lit) => {
      g.beginPath();
      path();
      g.closePath();
      g.fillStyle = metal(y0, y1, lit);
      g.fill();
      g.strokeStyle = rim;
      g.lineWidth = lw || 0.6;
      g.stroke();
    };
    const glow = (path, w, a) => {
      g.save();
      g.shadowColor = acc;
      g.shadowBlur = 1.5;
      g.strokeStyle = acc;
      g.globalAlpha = (a || 1) * 0.6;
      g.lineWidth = w || 0.7;
      g.beginPath();
      path();
      g.stroke();
      g.restore();
    };
    const lines = (xs, h, col) => {
      g.strokeStyle = col || "rgba(0,0,0,0.75)";
      g.lineWidth = 0.5;
      for (const x of xs) {
        g.beginPath();
        g.moveTo(x, -h);
        g.lineTo(x - 1.2, h);
        g.stroke();
      }
    };
    const lamps = (n, x0, x1, y) => {
      g.fillStyle = `hsl(${hue},100%,80%)`;
      for (let i = 0; i < n; i++) for (const s of [-1, 1]) g.fillRect(x0 + ((x1 - x0) * i) / Math.max(1, n - 1), s * y - 0.3, 0.8, 0.6);
    };
    const canopy = (x, w, h) => {
      const cg = g.createLinearGradient(0, -h, 0, h);
      cg.addColorStop(0, "rgba(120,150,170,0.85)");
      cg.addColorStop(0.5, `hsla(${hue},40%,18%,0.95)`);
      cg.addColorStop(1, "rgba(0,0,0,0.95)");
      g.fillStyle = cg;
      g.beginPath();
      g.ellipse(x, 0, w, h, 0, 0, 6.283);
      g.fill();
      g.fillStyle = "rgba(255,255,255,0.35)";
      g.beginPath();
      g.ellipse(x + w * 0.3, -h * 0.4, w * 0.35, h * 0.2, 0, 0, 6.283);
      g.fill();
    };
    const wing = (pts, s) => {
      part(() => {
        g.moveTo(pts[0][0], s * pts[0][1]);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], s * pts[i][1]);
      }, 0, s * 18, 0.6);
    };
    let ex = -20, slits = [0];
    const T = tier;
    if (fam === 0) {
      // black delta: swept blades, long needle nose
      for (const s of [-1, 1]) {
        wing([[10, 2.5], [-8, 11 + T * 2], [-20, 15 + T * 2.5], [-14, 6], [-12, 3]], s);
        if (T >= 2) wing([[22, 1.5], [13, 6.5], [8, 5.5], [14, 1.5]], s);
        glow(() => {
          g.moveTo(10, s * 2.8);
          g.lineTo(-8, s * (11 + T * 2));
        }, 0.6, T ? 0.9 : 0.4);
      }
      part(() => {
        g.moveTo(31, 0);
        g.bezierCurveTo(20, -3.5, 6, -6, -8, -5);
        g.lineTo(-20, -3);
        g.lineTo(-20, 3);
        g.lineTo(-8, 5);
        g.bezierCurveTo(6, 6, 20, 3.5, 31, 0);
      }, -6, 6, 0.8, true);
      lines([8, 0, -8, -14].slice(0, 2 + T), 4.2);
      canopy(9, 5, 1.9);
      glow(() => {
        g.moveTo(2, 0);
        g.lineTo(-17, 0);
      }, 0.8);
      lamps(T + 1, 2, -14, 3);
      ex = -20;
      slits = T >= 2 ? [-2, 2] : [0];
    } else if (fam === 1) {
      // bio-organic crescent: ribbed tendrils and glowing veins
      const n = 2 + T;
      for (let i = 0; i < n; i++) {
        const reach = 7 + i * 3.2 + r() * 2;
        for (const s of [-1, 1]) {
          part(() => {
            g.moveTo(10 - i * 3, s * 2.6);
            g.quadraticCurveTo(-4 - i * 2, s * reach, -22 - i * 2, s * (reach + 3));
            g.quadraticCurveTo(-8 - i * 2, s * (reach * 0.5), -2 - i * 3, s * 1.6);
          }, 0, s * 16, 0.5);
        }
      }
      part(() => {
        g.moveTo(26, 0);
        g.bezierCurveTo(16, -9, 0, -10, -9, -6);
        g.bezierCurveTo(-18, -9, -24, -4, -19, 0);
        g.bezierCurveTo(-24, 4, -18, 9, -9, 6);
        g.bezierCurveTo(0, 10, 16, 9, 26, 0);
      }, -9, 9, 0.8, true);
      for (let i = 0; i < 3 + T; i++) {
        const x = 16 - i * 5;
        glow(() => {
          g.moveTo(x, 0);
          g.quadraticCurveTo(x - 3, -4, x - 6, -5.5 + i * 0.6);
          g.moveTo(x, 0);
          g.quadraticCurveTo(x - 3, 4, x - 6, 5.5 - i * 0.6);
        }, 0.6, 0.85);
      }
      glow(() => {
        g.moveTo(20, 0);
        g.lineTo(-14, 0);
      }, 0.8);
      ex = -21;
      slits = [-2.5, 2.5];
    } else if (fam === 2) {
      // chrome gunship: long plated hull with ribs and a dorsal spine
      part(() => {
        g.moveTo(32, 0);
        g.bezierCurveTo(24, -4.5, 10, -6.5, -6, -6.5);
        g.lineTo(-22, -5);
        g.quadraticCurveTo(-26, 0, -22, 5);
        g.lineTo(-6, 6.5);
        g.bezierCurveTo(10, 6.5, 24, 4.5, 32, 0);
      }, -7, 7, 0.8, true);
      lines([18, 11, 4, -3, -10, -16].slice(0, 3 + T), 5.8);
      part(() => {
        g.moveTo(26, -0.5);
        g.bezierCurveTo(14, -3, 4, -3.5, -14, -3);
        g.lineTo(-14, 3);
        g.bezierCurveTo(4, 3.5, 14, 3, 26, 0.5);
      }, -4, 4, 0.5, true);
      glow(() => {
        g.moveTo(24, -4.2);
        g.bezierCurveTo(10, -6, -6, -6.2, -20, -4.6);
        g.moveTo(24, 4.2);
        g.bezierCurveTo(10, 6, -6, 6.2, -20, 4.6);
      }, 0.7, 0.75);
      canopy(14, 4, 1.6);
      lamps(3 + T, 20, -16, 5);
      for (const s of [-1, 1]) part(() => {
        g.moveTo(-8, s * 6);
        g.lineTo(-18, s * (9 + T));
        g.lineTo(-24, s * (9 + T));
        g.lineTo(-20, s * 5);
      }, 0, s * 12, 0.5);
      ex = -24;
      slits = T >= 2 ? [-3, 0, 3] : [-2, 2];
    } else if (fam === 3) {
      // living leaf-ship: veined shell with glowing cells
      part(() => {
        g.moveTo(30, 0);
        g.bezierCurveTo(18, -11, -4, -12, -20, -2);
        g.quadraticCurveTo(-23, 0, -20, 2);
        g.bezierCurveTo(-4, 12, 18, 11, 30, 0);
      }, -11, 11, 0.8, true);
      g.strokeStyle = "rgba(0,0,0,0.7)";
      g.lineWidth = 0.5;
      g.beginPath();
      g.moveTo(28, 0);
      g.lineTo(-19, 0);
      for (let i = 0; i < 4 + T; i++) {
        const x = 22 - i * 8;
        g.moveTo(x, 0);
        g.quadraticCurveTo(x - 4, -5, x - 12, -8 + i);
        g.moveTo(x, 0);
        g.quadraticCurveTo(x - 4, 5, x - 12, 8 - i);
      }
      g.stroke();
      for (let i = 0; i < 6 + T * 3; i++) {
        const x = 22 - r() * 38, y = (r() - 0.5) * 11 * (1 - Math.abs(x - 3) / 28);
        const gr = g.createRadialGradient(x, y, 0, x, y, 2.4);
        gr.addColorStop(0, `hsla(${hue},100%,78%,0.95)`);
        gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr;
        g.fillRect(x - 2.4, y - 2.4, 4.8, 4.8);
      }
      ex = -21;
      slits = [0];
    } else if (fam === 4) {
      // twin-boom: slim hull, long pylons carrying pods and antennae
      for (const s of [-1, 1]) {
        part(() => {
          g.moveTo(14, s * 4);
          g.lineTo(-6, s * 14);
          g.lineTo(-10, s * 14);
          g.lineTo(-2, s * 3.5);
        }, 0, s * 15, 0.5);
        part(() => {
          g.moveTo(14, s * 15);
          g.bezierCurveTo(4, s * 18, -14, s * 18, -22, s * 14);
          g.lineTo(-22, s * 12);
          g.bezierCurveTo(-14, s * 11, 4, s * 12, 14, s * 15);
        }, s * 10, s * 19, 0.5);
        glow(() => {
          g.moveTo(10, s * 15);
          g.lineTo(-18, s * 14.3);
        }, 0.6, 0.9);
        g.strokeStyle = rim;
        g.lineWidth = 0.4;
        g.beginPath();
        g.moveTo(14, s * 15);
        g.lineTo(22 + T * 2, s * 17);
        g.stroke();
      }
      part(() => {
        g.moveTo(32, 0);
        g.bezierCurveTo(22, -4, 8, -5, -12, -4.5);
        g.lineTo(-18, -3);
        g.lineTo(-18, 3);
        g.lineTo(-12, 4.5);
        g.bezierCurveTo(8, 5, 22, 4, 32, 0);
      }, -5, 5, 0.8, true);
      lines([14, 6, -2, -9].slice(0, 2 + T), 3.8);
      canopy(15, 4.5, 1.7);
      glow(() => {
        g.moveTo(8, 0);
        g.lineTo(-15, 0);
      }, 0.7);
      ex = -18;
      slits = [0];
    } else {
      // armoured fighter: broad angular wings, hex plating, glowing cockpit
      for (const s of [-1, 1]) {
        wing([[14, 3], [4, 12], [-6, 17 + T * 1.5], [-14, 16 + T * 1.5], [-12, 9], [-20, 7], [-16, 3]], s);
        glow(() => {
          g.moveTo(14, s * 3.2);
          g.lineTo(4, s * 12);
          g.lineTo(-6, s * (17 + T * 1.5));
        }, 0.6, 0.85);
        lines([-2, -8].slice(0, 1 + (T > 1 ? 1 : 0)).map((x) => x), 0);
      }
      part(() => {
        g.moveTo(26, 0);
        g.lineTo(14, -5);
        g.lineTo(-6, -6.5);
        g.lineTo(-20, -4);
        g.lineTo(-20, 4);
        g.lineTo(-6, 6.5);
        g.lineTo(14, 5);
      }, -7, 7, 0.8, true);
      g.strokeStyle = "rgba(0,0,0,0.7)";
      g.lineWidth = 0.4;
      for (let i = 0; i < 3 + T; i++) {
        const x = 12 - i * 6;
        g.beginPath();
        g.moveTo(x, -5.5);
        g.lineTo(x - 2, 0);
        g.lineTo(x, 5.5);
        g.stroke();
      }
      canopy(12, 4, 2.2);
      glow(() => {
        g.moveTo(5, -4.5);
        g.lineTo(-17, -3.2);
        g.moveTo(5, 4.5);
        g.lineTo(-17, 3.2);
      }, 0.7, 0.9);
      ex = -20;
      slits = [-2.5, 2.5];
    }
    // weathering: soft shade toward the underside plus fine scuffs, so hulls read as worn metal rather than toys
    g.save();
    g.globalCompositeOperation = "source-atop";
    const sh = g.createLinearGradient(0, -18, 0, 18);
    sh.addColorStop(0, "rgba(0,0,0,0)");
    sh.addColorStop(1, "rgba(0,0,0,0.35)");
    g.fillStyle = sh;
    g.fillRect(-32, -32, 64, 64);
    for (let i = 0; i < 70; i++) {
      g.fillStyle = r() < 0.5 ? "rgba(0,0,0,0.28)" : "rgba(200,210,220,0.12)";
      g.fillRect(-26 + r() * 52, -14 + r() * 28, 0.5 + r() * 1.6, 0.3);
    }
    g.restore();
    // engines: small hot core with a faint streak behind it
    for (const ey of slits) {
      const gr = g.createRadialGradient(ex, ey, 0, ex, ey, 4);
      gr.addColorStop(0, `hsla(${hue},70%,85%,0.9)`);
      gr.addColorStop(0.4, `hsla(${hue},80%,60%,0.3)`);
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr;
      g.beginPath();
      g.arc(ex, ey, 4, 0, 6.283);
      g.fill();
      const sg = g.createLinearGradient(ex, 0, ex - 7, 0);
      sg.addColorStop(0, `hsla(${hue},80%,75%,0.4)`);
      sg.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = sg;
      g.fillRect(ex - 7, ey - 0.5, 7, 1);
    }
    // rimC light: a thin pale outline under the hull keeps the silhouette readable on bright nebulae
    const rimC = document.createElement("canvas");
    rimC.width = rimC.height = S;
    const rimG = rimC.getContext("2d");
    rimG.drawImage(c, 0, 0);
    rimG.globalCompositeOperation = "source-in";
    rimG.fillStyle = `hsl(${hue},55%,80%)`;
    rimG.fillRect(0, 0, S, S);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "destination-over";
    g.globalAlpha = 0.6;
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-1.4, -1.4], [1.4, 1.4], [-1.4, 1.4], [1.4, -1.4]]) g.drawImage(rimC, dx, dy);
    g.restore();
    this.sprites.set(key, c);
    if (this.sprites.size > 700) {
      // evict the oldest ship sprites first; other sprite kinds are few and small
      for (const k of this.sprites.keys()) {
        if (this.sprites.size <= 500) break;
        if (k.startsWith("ship")) this.sprites.delete(k);
      }
    }
    return c;
  }

  /* note -> craft design: more links/headings/usage = more advanced */
  craftOf(n) {
    if (n.craft) return n.craft;
    const c = clamp(n.deg / 10 + (n.heads ? n.heads.length : 0) / 16 + (n.usage || 0) / 3, 0, 1);
    n.craft = { tier: Math.min(3, Math.floor(c * 3.99)), base: n.seed % 12, hue: Math.round(n.hue / 30) * 30 % 360 };
    return n.craft;
  }

  /* draw a craft at (x,y) heading (vx,vy); returns false when too small (caller draws a dot) */
  drawCraft(ctx, src, x, y, vx, vy, sz, alpha, k, p) {
    if (this.opts.style !== "ships" || this.shipBudget <= 0) return false;
    const len = (3 + sz * 2.2) * k * 1.5;
    if (len < 5) return false;
    const cf = this.craftOf(src);
    if (p.v === undefined) p.v = Math.floor(this.rnd() * 3);
    const spr0 = this.shipSprite(cf.tier, (cf.base + p.v) % 12, cf.hue);
    if (!spr0) return false;
    if (vx * vx + vy * vy > 0.01) p.ang = Math.atan2(vy, vx);
    // on-screen size saturates: ships stay small however close you zoom
    const L = (8 + 12 * (1 - Math.exp(-len / 70))) * (0.85 + 0.15 * sz) * (64 / 44);
    // small ships use a pre-shrunk 64 px copy: much cheaper than minifying the 128 px sprite every draw
    let spr = spr0;
    if (L < 34) {
      if (!spr0._sm) {
        const sm = document.createElement("canvas");
        sm.width = sm.height = 64;
        sm.getContext("2d").drawImage(spr0, 0, 0, 64, 64);
        spr0._sm = sm;
      }
      spr = spr0._sm;
    }
    const prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = alpha * clamp((len - 5) / 4, 0, 1);
    const a = p.ang || 0, ca = Math.cos(a), sa = Math.sin(a), d = this.dpr;
    ctx.setTransform(ca * d, sa * d, -sa * d, ca * d, x * d, y * d);
    ctx.drawImage(spr, -L / 2, -L / 2, L, L);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.globalCompositeOperation = prev;
    this.shipBudget--;
    return true;
  }

  /* ---------- rendering ---------- */

  sprite(hue, kind) {
    const h = Math.round(hue / 8) * 8;
    const key = kind + h;
    let c = this.sprites.get(key);
    if (c) return c;
    const S = kind === "cloud" || kind === "flare" ? 128 : 64;
    c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d");
    const m = S / 2;
    if (kind === "flare") {
      const spike = (len, th, rot, a) => {
        g.save();
        g.translate(m, m);
        g.rotate(rot);
        for (const ax of [0, 1]) {
          const lg = g.createLinearGradient(-len, 0, len, 0);
          lg.addColorStop(0, `hsla(${h},80%,85%,0)`);
          lg.addColorStop(0.5, `hsla(${h},40%,97%,${a})`);
          lg.addColorStop(1, `hsla(${h},80%,85%,0)`);
          g.fillStyle = lg;
          g.fillRect(-len, -th / 2, len * 2, th);
          g.rotate(Math.PI / 2);
        }
        g.restore();
      };
      spike(m, 2.2, 0, 0.95);
      spike(m * 0.55, 1.4, Math.PI / 4, 0.5);
      const gr = g.createRadialGradient(m, m, 0, m, m, m * 0.32);
      gr.addColorStop(0, `hsla(${h},20%,100%,1)`);
      gr.addColorStop(0.35, `hsla(${h},85%,80%,0.7)`);
      gr.addColorStop(1, `hsla(${h},90%,60%,0)`);
      g.fillStyle = gr;
      g.fillRect(0, 0, S, S);
    } else if (kind === "cloud") {
      const r = rng(h * 31 + 5);
      for (let i = 0; i < 6; i++) {
        const x = m + (r() - 0.5) * S * 0.45, y = m + (r() - 0.5) * S * 0.45, rr = S * (0.2 + r() * 0.25);
        const gr = g.createRadialGradient(x, y, 0, x, y, rr);
        gr.addColorStop(0, `hsla(${h + (r() - 0.5) * 30},85%,58%,0.5)`);
        gr.addColorStop(1, `hsla(${h},85%,50%,0)`);
        g.fillStyle = gr;
        g.fillRect(0, 0, S, S);
      }
    } else {
      const gr = g.createRadialGradient(m, m, 0, m, m, m);
      gr.addColorStop(0, `hsla(${h},30%,98%,1)`);
      gr.addColorStop(0.2, `hsla(${h},90%,72%,0.85)`);
      gr.addColorStop(0.5, `hsla(${h},90%,52%,0.22)`);
      gr.addColorStop(1, `hsla(${h},90%,40%,0)`);
      g.fillStyle = gr;
      g.fillRect(0, 0, S, S);
    }
    this.sprites.set(key, c);
    return c;
  }

  starSprite(t01, flare) {
    const q = Math.round(t01 * 40);
    const key = (flare ? "tf" : "ts") + q;
    let c = this.sprites.get(key);
    if (c) return c;
    const rgb = starColor(q / 40);
    const S = flare ? 128 : 64, m = S / 2;
    c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d");
    const white = mix3(rgb, [255, 255, 255], 0.75);
    if (flare) {
      for (const [len, th, rot, a] of [[m, 2.2, 0, 0.9], [m * 0.55, 1.4, Math.PI / 4, 0.45]]) {
        g.save();
        g.translate(m, m);
        g.rotate(rot);
        for (let i = 0; i < 2; i++) {
          const lg = g.createLinearGradient(-len, 0, len, 0);
          lg.addColorStop(0, rgba(rgb, 0));
          lg.addColorStop(0.5, rgba(white, a));
          lg.addColorStop(1, rgba(rgb, 0));
          g.fillStyle = lg;
          g.fillRect(-len, -th / 2, len * 2, th);
          g.rotate(Math.PI / 2);
        }
        g.restore();
      }
    }
    const gr = g.createRadialGradient(m, m, 0, m, m, flare ? m * 0.3 : m);
    gr.addColorStop(0, rgba(white, 1));
    gr.addColorStop(0.2, rgba(rgb, 0.9));
    gr.addColorStop(0.5, rgba(rgb, 0.22));
    gr.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
    this.sprites.set(key, c);
    return c;
  }

  project(wx, wy, wz) {
    const x = wx - this.target.x, y = wy - this.target.y, z = wz - this.target.z;
    const x1 = x * this.cosy - y * this.siny;
    const y1 = x * this.siny + y * this.cosy;
    const Y = z * this.cosp - y1 * this.sinp;
    const dep = y1 * this.cosp + z * this.sinp;
    const p = (2.2 * this.R) / Math.max(60, 2.2 * this.R + dep);
    const k = this.s0 * this.cam.zoom;
    return { x: this.cx + x1 * p * k, y: this.cy - Y * p * k, p, dep };
  }

  systemPlanets(n) {
    if (!n.planets) {
      const nb = [...n.nbrs].sort((a, b) => b.deg - a.deg || a.seed - b.seed).slice(0, 8);
      const mk = (m, i, name, seed, deg, own) => ({
        nb: m, i, seed, hue: m.hue, deg, phase: (seed % 628) / 100, name, heat: 0, own,
        ph0: ((n.seed ^ seed) % 628) / 100, incl: (((seed >> 3) % 100) / 100 - 0.5) * 0.6,
        fr0: 0.3 + 0.25 * Math.min(1, deg / 10), fr: 0.3, sx: 0, sy: 0, pr: 0, dep: 0,
      });
      const list = nb.map((m, i) => mk(m, i, m.name, m.seed, m.deg, false));
      for (const h of n.heads || []) {
        if (list.length >= 8) break;
        list.push(mk(n, list.length, h.text, hashStr(n.path + h.text), Math.max(0, 7 - h.level * 2), true));
      }
      // notes without links or headings still get a small system
      for (let c = 1 + (n.seed % 2); list.length < c; ) list.push(mk(n, list.length, "", n.seed + list.length * 7919, 0, true));
      // Planet formation: rock condenses inside the frost line, gas/ice giants form beyond it, M dwarfs host
      // compact rocky systems, hot O/B/A stars blow away gas and leave debris disks (no Earth-likes).
      const cls = n.cls || "G";
      const hot = cls === "O" || cls === "B" || cls === "A";
      list.sort((a, b) => (a.seed * 7 % 1009) - (b.seed * 7 % 1009));
      if (cls === "O" || cls === "B") list.length = Math.min(list.length, 5);
      let u = 0.3 + (n.seed % 100) / 100 * 0.25;
      const ratio = STAR_RATIO[cls] || 1.55;
      list.forEach((p, i) => {
        const r = ((p.seed >> 4) % 100) / 100;
        p.i = i;
        p.u = u;
        u *= ratio * (0.92 + r * 0.16);
        let type;
        p.hotGiant = false;
        if (p.u < 0.5 && !hot && cls !== "M" && r < 0.1) {
          type = "gas";
          p.hotGiant = true;
        } else if (p.u < 0.45) type = "lava";
        else if (p.u < HZ_LO) type = "rocky";
        else if (p.u <= HZ_HI) type = !hot && r < 0.8 ? "earth" : "rocky";
        else if (p.u < FROST_U) type = "rocky";
        else if (cls === "M" && r > 0.3) type = "ice";
        else type = p.u < FROST_U * 2.2 ? "gas" : "ice";
        p.ptype = type;
        p.fr = p.fr0 * PLANET_SIZE[type] * (p.hotGiant ? 1.15 : 1);
        // close-in planets of dim stars are tidally locked
        p.locked = p.hotGiant || (cls === "M" && p.u < 1.6) || p.u < 0.3;
        p.atm = type === "rocky" && p.u < HZ_LO ? "255,215,150" : type === "rocky" && p.u > HZ_HI ? "230,150,110" : "";
        p.orb = 2.7 + i * 1.15;
        // moons form around giants; Earth-likes may have one big one; tidal forces strip them from close-in worlds
        const mr = ((p.seed >> 7) % 100) / 100;
        const moons = [];
        const tones = ["#e8cc6e", "#d9e4f2", "#b59a82", "#c9c9d0"];
        if (type === "gas" && !p.hotGiant) for (let m = 0, c = 2 + Math.floor(mr * 3); m < c; m++) moons.push({ k: 0.1 + m * 0.03 + ((m * 7) % 3) * 0.015, tone: tones[m % 4] });
        else if (type === "ice") for (let m = 0, c = 1 + Math.floor(mr * 2.5); m < c; m++) moons.push({ k: 0.1 + m * 0.02, tone: m ? tones[1] : "#cfd9e6" });
        else if (type === "earth" && mr < 0.7) moons.push({ k: 0.27, tone: "#c9c9c4" });
        else if (type === "rocky" && p.u > 1.3 && mr < 0.6) for (let m = 0, c = 1 + Math.floor(mr * 3); m < c; m++) moons.push({ k: 0.07, tone: "#9a8a7a" });
        p.moons = moons;
      });
      // belts: asteroid belt just inside the frost line (leftover rock that Jupiter kept from accreting),
      // outer Kuiper-style belt beyond the last giant; hot stars keep dense debris disks
      const belts = [];
      for (let i = 0; i + 1 < list.length; i++) {
        if (list[i].u < FROST_U * 0.85 && list[i + 1].u >= FROST_U * 0.85) belts.push({ orb: (list[i].orb + list[i + 1].orb) / 2, dens: 1 });
      }
      const last = list[list.length - 1];
      if (last && (last.u >= FROST_U || hot)) belts.push({ orb: last.orb + 1.1, dens: hot ? 2.2 : 1 });
      n.belts = belts;      n.planets = list;
    }
    return n.planets;
  }

  drawSun(ctx, n, t, full, labels) {
    const { sx: x, sy: y, pr, rgb } = n;
    const k = this.s0 * this.cam.zoom;
    const grow = clamp((pr - 6) / 7, 0, 1);
    const planets = full ? this.systemPlanets(n) : null;
    const sr = n.r * 1.4 * n.sf * n.scale;
    const sc = { x, y };
    if (planets) {
      const spd = 0.5 * (0.4 + this.cam.orbit * 0.6);
      for (const p of planets) {
        const ao = sr * p.orb;
        const ang = p.ph0 + (t / 1000) * spd * Math.pow(2.7 / p.orb, 1.5);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        p.wx = n.wx + ao * ca;
        p.wy = n.wy + ao * sa * Math.cos(p.incl);
        p.wz = n.wz + ao * sa * Math.sin(p.incl);
        const q = this.project(p.wx, p.wy, p.wz);
        p.pp = q.p;
        p.wr = sr * p.fr;
        p.sx = q.x;
        p.sy = q.y;
        p.dep = q.dep;
        p.pr = sr * p.fr * q.p * k * grow;
        p.heat = p.nb.heat;
      }
      // orbit paths
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(mix3(rgb, [200, 210, 255], 0.5), 1);
      ctx.globalAlpha = 0.16 * grow;
      for (const p of planets) {
        const ao = sr * p.orb, ci = Math.cos(p.incl), si = Math.sin(p.incl);
        ctx.beginPath();
        for (let s = 0; s <= 48; s++) {
          const a = (s / 48) * 6.2832;
          const q = this.project(n.wx + ao * Math.cos(a), n.wy + ao * Math.sin(a) * ci, n.wz + ao * Math.sin(a) * si);
          if (s) ctx.lineTo(q.x, q.y);
          else ctx.moveTo(q.x, q.y);
        }
        ctx.stroke();
      }
      const belts = n.belts || [];
      if (belts.length && grow > 0.3 && this.Q.name !== "Low") {
        const cnt0 = this.Q.gran ? 160 : 80;
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "rgb(170,160,150)";
        belts.forEach((bt, bi) => {
          const br = bt.orb, cnt = Math.round(cnt0 * bt.dens);
          const bao = sr * br, w = sr * 0.35 * bt.dens;
          const drift = (t / 1000) * spd * Math.pow(2.7 / br, 1.5);
          ctx.globalAlpha = 0.7 * grow;
          ctx.beginPath();
          for (let s = 0; s < cnt; s++) {
            const h = Math.sin((s + 1) * 12.9898 + (n.seed % 97) + bi * 7) * 43758.5453;
            const f1 = h - Math.floor(h);
            const h2 = Math.sin((s + 1) * 78.233 + bi) * 12345.678;
            const f2 = h2 - Math.floor(h2);
            const a = (s / cnt) * 6.2832 + f1 * 0.04 + drift;
            const rr = bao + (f2 - 0.5) * w;
            const hv = (f1 - 0.5) * sr * 0.12;
            const q = this.project(n.wx + rr * Math.cos(a), n.wy + rr * Math.sin(a), n.wz + hv);
            const d = Math.max(0.8, sr * 0.045 * (0.5 + f2) * q.p * k);
            ctx.rect(q.x, q.y, d, d);
          }
          ctx.fill();
        });
        ctx.globalAlpha = 1;
      }
      this.systems.push({ n, planets });
    }
    const drawPl = (list) => {
      list.sort((a, b) => b.dep - a.dep);
      for (const p of list) {
        if (p.pr < 0.8) continue;
        this.drawPlanet(ctx, p, p.pr, sc, t);
        if (grow > 0.7 && (p.pr > 7 || p.nb === this.hover)) labels.push([p, p.pr]);
      }
    };
    if (planets) drawPl(planets.filter((p) => p.dep > n.dep));

    // the sun
    ctx.globalCompositeOperation = "lighter";
    const pulse = 1 + 0.04 * Math.sin(t / 900 * (0.7 + (n.seed % 13) / 20) + n.phase);
    const cs = pr * (4.2 + n.heat * 3) * pulse;
    ctx.globalAlpha = 0.8;
    ctx.drawImage(this.starSprite(n.temp), x - cs, y - cs, cs * 2, cs * 2);
    const fs = pr * 7 * pulse;
    ctx.globalAlpha = 0.55 + n.heat * 0.4;
    ctx.drawImage(this.starSprite(n.temp, true), x - fs, y - fs, fs * 2, fs * 2);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    const white = mix3(rgb, [255, 255, 255], 0.65);
    const g = ctx.createRadialGradient(x, y, 0, x, y, pr);
    g.addColorStop(0, rgba(white, 1));
    g.addColorStop(0.55, rgba(rgb, 1));
    g.addColorStop(0.9, rgba(mix3(rgb, [0, 0, 0], 0.3), 1));
    g.addColorStop(1, rgba(mix3(rgb, [0, 0, 0], 0.55), 1));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, pr, 0, 6.2832);
    ctx.fill();
    if (pr >= 9 && this.Q.gran) {
      this.gran = this.gran || makeGranulation();
      const gr = this.gran;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, pr, 0, 6.2832);
      ctx.clip();
      ctx.globalCompositeOperation = "soft-light";
      ctx.globalAlpha = 0.7;
      const off = (t * 0.004 * (1 + (n.seed % 4)) + n.seed) % gr.W;
      ctx.drawImage(gr.c, off, 0, gr.W / 2, gr.H, x - pr, y - pr, pr * 2, pr * 2);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    if (planets) drawPl(planets.filter((p) => p.dep <= n.dep));
    if (pr > 13 || n === this.hover) labels.push([n, pr]);
  }

  draw(ctx, t, colors) {
    const { w, h, dpr } = this;
    const k = this.s0 * this.cam.zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    const Q = this.Q;
    this.texBudget = 1;
    this.shipGen = 4;
    if (!this.bgCache) {
      const bc = document.createElement("canvas");
      bc.width = Math.max(1, Math.floor(w * dpr));
      bc.height = Math.max(1, Math.floor(h * dpr));
      const bg = bc.getContext("2d");
      bg.scale(dpr, dpr);
      const gr = bg.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, Math.max(w, h) * 0.75);
      gr.addColorStop(0, "#150a26");
      gr.addColorStop(0.45, "#080618");
      gr.addColorStop(1, "#02020a");
      bg.fillStyle = gr;
      bg.fillRect(0, 0, w, h);
      this.bgCache = bc;
    }
    ctx.drawImage(this.bgCache, 0, 0, w, h);

    ctx.fillStyle = "#cfd8ff";
    for (let si = 0; si < Math.min(Q.stars, this.bgStars.length); si++) {
      const s = this.bgStars[si];
      const x = (((s.x * w + this.cam.yaw * 40 * s.l) % w) + w) % w;
      ctx.globalAlpha = s.a * (1 - s.ta + s.ta * Math.sin(t / 700 * s.tw + s.ph + 0.8 * Math.sin(t / 2300 * s.tw + s.ph * 3)));
      ctx.fillRect(x, s.y * h, 1.2 * s.l + 0.3, 1.2 * s.l + 0.3);
    }

    ctx.globalCompositeOperation = "lighter";
    const R = this.R;
    if (this.opts.nebula && Q.nebula) {
      for (const c of this.clouds) {
        const th = c.th + this.spin * (0.35 / (0.15 + c.rotR / R)) + this.windOff(c.rotR);
        const SP = this.cam.spread;
        const q = this.project(c.rad * SP * Math.cos(th), c.rad * SP * Math.sin(th), c.z * SP);
        const s = c.size * Math.sqrt(SP) * q.p * k;
        if (s < 4 || q.x < -s || q.x > w + s || q.y < -s || q.y > h + s) continue;
        ctx.globalAlpha = c.alpha * Math.min(1, 2 / (1 + this.cam.zoom * 0.4));
        ctx.drawImage(this.sprite(c.hue, "cloud"), q.x - s / 2, q.y - s / 2, s, s);
      }
    }
    if (this.opts.nebula && Q.nebula && this.armDust) {
      const SP = this.cam.spread;
      const lim = this.lvl >= 2 ? this.armDust.length : 350;
      const sa = 0.35 / 1;
      for (let i = 0; i < lim; i++) {
        const d = this.armDust[i];
        const th = d.th + this.spin * (sa / (0.15 + d.rotR / R)) + this.windOff(d.rotR);
        const q = this.project(d.rad * SP * Math.cos(th), d.rad * SP * Math.sin(th), d.z * SP);
        const s = d.s * 2.2 * Math.min(2, Math.max(0.6, k * 2));
        if (q.x < -s || q.x > w + s || q.y < -s || q.y > h + s) continue;
        ctx.globalAlpha = d.a * Math.min(1, 2 / (1 + this.cam.zoom * 0.4));
        ctx.drawImage(this.sprite(d.hue, "star"), q.x - s, q.y - s, s * 2, s * 2);
      }
    }
    const core = this.project(0, 0, 0);
    const cs = R * 0.55 * core.p * k;
    ctx.globalAlpha = 0.55 * Math.min(1, 2.5 / (1 + this.cam.zoom * 0.5));
    ctx.drawImage(this.sprite(40, "star"), core.x - cs, core.y - cs, cs * 2, cs * 2);

    // links
    const focus = this.hover || this.follow;
    if (this.opts.links && this.edges.length) {
      ctx.lineWidth = 1;
      const lstyle = this.opts.style;
      const web = lstyle === "web", glow = lstyle === "glow", dashed = lstyle === "dash";
      const strands = web ? (Q.stride >= 4 ? 1 : Q.stride >= 2 ? 2 : 3) : 1;
      if (web || glow) ctx.globalCompositeOperation = "lighter";
      const zoomK = this.cam.zoom > 2 ? Math.max(0.3, 2 / this.cam.zoom) : 1;
      const stride = Math.max(Q.stride, this.edges.length > 3000 ? 2 : 1);
      for (const kind in LINK_KINDS) {
        const list = this.edgesByKind[kind];
        if (!list || !this.kinds[kind]) continue;
        const ks = LINK_KINDS[kind];
        ctx.strokeStyle = ks.col;
        ctx.globalAlpha = ks.a * (focus ? 0.5 : 1) * zoomK * (web ? 0.75 : 1);
        if (dashed) {
          ctx.setLineDash(ks.dash || [3, 7]);
          ctx.lineDashOffset = -t / 45;
        } else if (ks.dash) ctx.setLineDash(ks.dash);
        if (web) ctx.lineWidth = 0.7;
        ctx.beginPath();
        // rarer kinds are always drawn in full; only the bulk of local links is thinned out
        const st = kind === "local" ? stride : 1;
        for (let ei = 0; ei < list.length; ei += st) {
          const e = list[ei];
          if (focus && (e.a === focus || e.b === focus)) continue;
          const a = e.a, b = e.b;
          if (a.hid || b.hid) continue;
          if ((a.sx < 0 && b.sx < 0) || (a.sx > w && b.sx > w) || (a.sy < 0 && b.sy < 0) || (a.sy > h && b.sy > h)) continue;
          // gentle arc: links read as flows between clusters instead of a tangle of straight hairlines
          for (let sd = 0; sd < strands; sd++) {
            // cosmic web: several slightly different threads per link form a fibre bundle
            const bd = web ? e.bend * 1.5 + (sd - (strands - 1) / 2) * 0.1 * (1 + (ei % 3) * 0.5) : e.bend;
            ctx.moveTo(a.sx, a.sy);
            ctx.quadraticCurveTo((a.sx + b.sx) / 2 - (b.sy - a.sy) * bd, (a.sy + b.sy) / 2 + (b.sx - a.sx) * bd, b.sx, b.sy);
          }
        }
        if (glow) {
          ctx.lineWidth = 4;
          ctx.globalAlpha = ks.a * (focus ? 0.5 : 1) * zoomK * 0.22;
          ctx.stroke();
          ctx.lineWidth = 1;
          ctx.globalAlpha = ks.a * (focus ? 0.5 : 1) * zoomK * 1.2;
        }
        ctx.stroke();
        if (web) ctx.lineWidth = 1;
        if (ks.dash || dashed) {
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;
        }
      }
      ctx.globalCompositeOperation = "source-over";
      if (focus) {
        ctx.strokeStyle = `hsl(${focus.hue},90%,75%)`;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        for (const e of this.edges) {
          if (e.a !== focus && e.b !== focus) continue;
          const a = e.a, b = e.b;
          if (a.hid || b.hid) continue;
          ctx.moveTo(a.sx, a.sy);
          ctx.quadraticCurveTo((a.sx + b.sx) / 2 - (b.sy - a.sy) * e.bend, (a.sy + b.sy) / 2 + (b.sx - a.sx) * e.bend, b.sx, b.sy);
        }
        ctx.stroke();
      }
    }

    // link flow: soft light pulses travelling along the arcs (or tiny craft in "ships" style)
    this.shipBudget = Q.ships;
    const pulse = this.opts.style !== "ships";
    const trailLen = this.opts.style === "web" ? 0.012 : 0.035;
    if (pulse) {
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#b4c4ff";
      ctx.globalAlpha = 0.2;
      ctx.beginPath();
    }
    const heads = [];
    const flowN = this.opts.style === "dash" ? 0 : this.linkAct || 0;
    for (let pi = 0; pi < flowN; pi++) {
      const p = this.linkP[pi];
      if (!p.e) continue;
      const e = p.e;
      if (!this.kinds[e.kind]) continue;
      const a = p.dir > 0 ? e.a : e.b, b = p.dir > 0 ? e.b : e.a;
      if (a.hid || b.hid) continue;
      const hot = Math.max(a.heat, b.heat);
      if (pulse) {
        const bd = e.bend * (p.dir > 0 ? 1 : -1);
        const mx = (a.sx + b.sx) / 2 - (b.sy - a.sy) * bd, my = (a.sy + b.sy) / 2 + (b.sx - a.sx) * bd;
        const t = p.t, u = 1 - t;
        const x = u * u * a.sx + 2 * u * t * mx + t * t * b.sx, y = u * u * a.sy + 2 * u * t * my + t * t * b.sy;
        if (x < -10 || x > w + 10 || y < -10 || y > h + 10) continue;
        const t2 = Math.max(0, t - trailLen), u2 = 1 - t2;
        ctx.moveTo(u2 * u2 * a.sx + 2 * u2 * t2 * mx + t2 * t2 * b.sx, u2 * u2 * a.sy + 2 * u2 * t2 * my + t2 * t2 * b.sy);
        ctx.lineTo(x, y);
        heads.push(x, y, LINK_KINDS[e.kind].hue ?? lerp(a.hue, b.hue, t), (0.25 + hot * 0.6) * Math.sin(t * 3.1416), (1.6 + p.sz * 0.9) * (1 + hot) * Math.min(1.6, Math.max(0.7, k * 2)));
        continue;
      }
      const x = lerp(a.sx, b.sx, p.t), y = lerp(a.sy, b.sy, p.t);
      if (x < -10 || x > w + 10 || y < -10 || y > h + 10) continue;
      const al = (0.3 + hot * 0.6) * Math.sin(p.t * 3.1416);
      if (this.drawCraft(ctx, a, x, y, b.sx - a.sx, b.sy - a.sy, p.sz, Math.min(1, al * 1.6), k, p)) continue;
      const s = (2 + p.sz * 2) * (1 + hot * 1.2) * Math.min(1.8, Math.max(0.6, k * 2));
      ctx.globalAlpha = al * 0.6;
      ctx.drawImage(this.sprite(lerp(a.hue, b.hue, p.t), "star"), x - s, y - s, s * 2, s * 2);
    }
    if (pulse) {
      ctx.stroke();
      for (let i = 0; i < heads.length; i += 5) {
        const s = heads[i + 4];
        ctx.globalAlpha = heads[i + 3];
        ctx.drawImage(this.sprite(heads[i + 2], "star"), heads[i] - s, heads[i + 1] - s, s * 2, s * 2);
      }
      ctx.globalAlpha = 1;
    }

    // stars: temperature-coloured; big ones (zoomed in) become suns with planetary systems
    const suns = [];
    const lite = [];
    for (const n of this.nodes) {
      if (n.hid || n.sx < -80 || n.sx > w + 80 || n.sy < -80 || n.sy > h + 80) continue;
      const pr = n.r * n.p * k * n.scale * 1.4 * n.sf;
      n.pr = pr;
      if (pr >= 6) suns.push(n);
      else lite.push(n);
    }
    // detail budget: only the biggest stars become full suns, the rest stay cheap sprites
    const MAX_SUNS = Q.suns;
    if (suns.length > MAX_SUNS) {
      suns.sort((a, b) => b.pr - a.pr);
      lite.push(...suns.splice(MAX_SUNS));
    }
    const cheap = this.lvl < 2 || this.nodes.length > 2500;
    for (const n of lite) {
      const pr = n.pr;
      const fade = clamp(1.25 - n.dep / (R * 2.4), 0.35, 1.1);
      const glow = Math.min(Math.max(2.6, pr * 3.2) * (1 + n.heat * 3), 160);
      ctx.globalAlpha = Math.min(1, (0.5 + n.heat + (1 - n.temp) * 0.2) * fade * (n === focus ? 1.6 : 1));
      if (cheap && glow < 5 && n.heat < 0.05 && n !== focus) {
        // far, quiet stars: a plain dot is visually the same and ~10x cheaper than a glow sprite
        ctx.fillStyle = n.dotCol;
        ctx.fillRect(n.sx - 1, n.sy - 1, 2, 2);
        continue;
      }
      ctx.drawImage(this.starSprite(n.temp), n.sx - glow, n.sy - glow, glow * 2, glow * 2);
      if ((glow > 5.5 && this.lvl >= 2) || n.heat > 0.15) {
        const fs = Math.min(glow * (2.6 + n.heat * 2), 700);
        ctx.globalAlpha = Math.min(0.9, 0.3 * fade + n.heat);
        ctx.drawImage(this.starSprite(n.temp, true), n.sx - fs, n.sy - fs, fs * 2, fs * 2);
      }
    }

    // suns and their planets, far to near
    suns.sort((a, b) => b.dep - a.dep);
    const labels = [];
    this.systems = [];
    const maxSys = Q.sys;
    suns.forEach((n, si) => {
      const full = si >= suns.length - maxSys;
      this.drawSun(ctx, n, t, full, labels);
    });
    // markers: orphan notes (no links) and the note a search just flew to
    if (this.opts.orphans || this.pulse) {
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = 1.2;
      if (this.opts.orphans) {
        ctx.strokeStyle = "#ff9a5a";
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        for (const n of this.nodes) {
          if (n.deg || n.hid || n.sx < -10 || n.sx > w + 10 || n.sy < -10 || n.sy > h + 10) continue;
          const rr = Math.max(4, n.pr || 4) + 3;
          ctx.moveTo(n.sx + rr, n.sy);
          ctx.arc(n.sx, n.sy, rr, 0, 6.283);
        }
        ctx.stroke();
      }
      if (this.pulse) {
        const age = (t - this.pulse.t0) / 1000;
        if (age > 4) this.pulse = null;
        else {
          const n = this.pulse.n;
          ctx.strokeStyle = "#7dffb0";
          for (let i = 0; i < 3; i++) {
            const ph = (age * 0.8 + i / 3) % 1;
            ctx.globalAlpha = (1 - ph) * (1 - age / 4);
            ctx.beginPath();
            ctx.arc(n.sx, n.sy, 8 + ph * 60, 0, 6.283);
            ctx.stroke();
          }
        }
      }
      ctx.globalCompositeOperation = "source-over";
    }
    // usage streams
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    const bh = this.bh;
    for (const p of this.stream) {
      if (p.t < 0) continue;
      let x, y;
      let sz = p.sz;
      if (p.kind === "out") {
        const ax = p.n.sx, ay = p.n.sy, dx = bh.x - ax, dy = bh.y - ay;
        const u = Math.pow(p.t, 1.6);
        const cx = ax + dx * 0.5 - dy * 0.32 * p.sign, cy = ay + dy * 0.5 + dx * 0.32 * p.sign;
        x = (1 - u) * (1 - u) * ax + 2 * (1 - u) * u * cx + u * u * bh.x;
        y = (1 - u) * (1 - u) * ay + 2 * (1 - u) * u * cy + u * u * bh.y;
        sz *= 1 - 0.55 * u;
      } else {
        x = lerp(p.n.sx, p.to.sx, p.t);
        y = lerp(p.n.sy, p.to.sy, p.t);
      }
      const col = `hsl(${p.hue},95%,${p.kind === "out" ? 72 : 80}%)`;
      const vx = isNaN(p.px) ? 0 : x - p.px, vy = isNaN(p.py) ? 0 : y - p.py;
      const src = p.n;
      const fade = p.kind === "out" ? clamp(1 - (p.t - 0.85) / 0.15, 0, 1) : 1;
      if (this.drawCraft(ctx, src, x, y, vx, vy, sz, 0.95 * fade, k, p)) {
        if (!isNaN(p.px)) {
          ctx.globalAlpha = 0.18 * fade;
          ctx.strokeStyle = col;
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(p.px, p.py);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
      } else {
        if (!isNaN(p.px)) {
          ctx.globalAlpha = 0.3;
          ctx.strokeStyle = col;
          ctx.lineWidth = Math.max(0.5, sz * 0.6);
          ctx.beginPath();
          ctx.moveTo(p.px, p.py);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        const s = 2 + sz * 2.4;
        ctx.globalAlpha = 0.7 * fade;
        ctx.drawImage(this.sprite(p.hue, "star"), x - s, y - s, s * 2, s * 2);
      }
      p.px = x;
      p.py = y;
    }
    ctx.lineCap = "butt";

    this.drawBlackHole(ctx, t);

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    if (this.opts.labels) {
      this.drawClusterLabels(ctx);
      ctx.font = "11px sans-serif";
      ctx.fillStyle = "#e8ecff";
      for (const [n, pr] of labels.slice(0, Q.labels)) {
        ctx.globalAlpha = n === this.hover ? 1 : 0.75;
        ctx.fillText(n.name, n.sx, n.sy + pr * 1.4 + 4);
      }
    }
    if (this.hover) this.drawTooltip(ctx);
    this.drawLog(ctx, t);
    ctx.globalAlpha = 1;
  }

  planetTex(n) {
    this.texs = this.texs || new Map();
    const type = n.ptype || PLANET_TYPES[n.seed % 5];
    const variant = Math.floor(n.seed / 5) % 4;
    const hb = type === "gas" ? Math.round(n.hue / 40) * 40 : 0;
    const key = type + variant + "_" + hb;
    let t = this.texs.get(key);
    if (!t) {
      // building a texture costs 100+ ms: do at most one per frame, show a plain disc meanwhile
      if (this.texBudget <= 0) return null;
      this.texBudget--;
      t = makePlanetTexture(type, variant, hb || n.hue);
      t.type = type;
      this.texs.set(key, t);
    }
    return t;
  }

  drawPlanet(ctx, n, pr, core, t) {
    const x = n.sx, y = n.sy, hue = n.hue;
    const tex = this.planetTex(n);
    if (!tex) {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = `hsl(${hue},35%,38%)`;
      ctx.beginPath();
      ctx.arc(x, y, pr, 0, 6.283);
      ctx.fill();
      return;
    }
    ctx.globalCompositeOperation = "lighter";
    if (n.heat > 0.05) {
      ctx.globalAlpha = n.heat * 0.8;
      const ag = pr * 2.4;
      ctx.drawImage(this.sprite(hue, "star"), x - ag, y - ag, ag * 2, ag * 2);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    const giant = tex.type === "gas" || tex.type === "ice";
    const ring = giant && !n.hotGiant && (tex.type === "ice" || (n.seed >> 2) % 3 !== 0) && pr >= 3;
    const rot = (n.seed % 628) / 100 * 0.3 - 0.4;
    const RING_BANDS = [[1.5, 0.05, 0.22], [1.62, 0.09, 0.5], [1.78, 0.07, 0.62], [2.1, 0.1, 0.5], [2.3, 0.03, 0.25]];
    const ringBands = (a0, a1) => {
      const faint = tex.type === "ice" || (n.seed >> 5) % 2 === 0;
      const sat = tex.type === "ice" ? 25 : 40;
      RING_BANDS.forEach(([k, w, al], bi) => {
        if (faint && bi < 3) return;
        ctx.strokeStyle = `hsla(${tex.type === "ice" ? 200 : hue + 15},${sat}%,${66 + bi * 4}%,${faint ? al * 0.7 : al})`;
        ctx.lineWidth = Math.max(1, pr * w);
        ctx.beginPath();
        ctx.ellipse(x, y, pr * k, pr * k * 0.28, rot, a0, a1);
        ctx.stroke();
      });
    };    if (ring) ringBands(Math.PI, 2 * Math.PI);

    const dx = core.x - x, dy = core.y - y, d = Math.hypot(dx, dy) || 1;
    const lx = x + (dx / d) * pr * 0.5, ly = y + (dy / d) * pr * 0.5;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, pr, 0, 6.283);
    ctx.clip();
    const spin = n.locked ? 0 : (n.seed % 7 + 3) * 0.004;
    const half = tex.W / 2;
    const off = (((t * spin + n.phase * 40) % tex.W) + tex.W) % tex.W;
    ctx.drawImage(tex.c, off, 0, half, tex.H, x - pr, y - pr, pr * 2, pr * 2);
    if (tex.clouds) {
      ctx.globalAlpha = 0.75;
      const co = (off * 1.35) % tex.W;
      ctx.drawImage(tex.clouds, co, 0, half, tex.H, x - pr, y - pr, pr * 2, pr * 2);
      ctx.globalAlpha = 1;
    }
    const sh = ctx.createRadialGradient(lx, ly, pr * 0.1, x, y, pr * 1.12);
    sh.addColorStop(0, "rgba(0,0,0,0)");
    sh.addColorStop(0.55, "rgba(2,2,12,0.35)");
    sh.addColorStop(1, "rgba(2,2,12,0.94)");
    ctx.fillStyle = sh;
    ctx.fillRect(x - pr, y - pr, pr * 2, pr * 2);
    if (tex.type === "lava") {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = "#ff5a10";
      ctx.fillRect(x - pr, y - pr, pr * 2, pr * 2);
    }
    ctx.restore();

    // atmosphere rim, strongest on the lit side
    ctx.globalCompositeOperation = "lighter";
    const rimCol = n.hotGiant ? "255,150,60" : n.atm ? n.atm : tex.type === "earth" ? "100,170,255" : tex.type === "lava" ? "255,120,40" : "190,210,255";
    const rg = ctx.createRadialGradient(x, y, pr * 0.9, x, y, pr * 1.22);
    rg.addColorStop(0, `rgba(${rimCol},0)`);
    rg.addColorStop(0.45, `rgba(${rimCol},0.3)`);
    rg.addColorStop(1, `rgba(${rimCol},0)`);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(x, y, pr * 1.22, 0, 6.283);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    if (ring) ringBands(0, Math.PI);
    if (pr >= 8 && n.moons) {
      const base = ring ? 2.6 : 1.8;
      n.moons.forEach((m, i) => {
        const a = t / (1400 + i * 900) + n.phase + i * 2.1;
        const orr = pr * (base + i * 0.45);
        const mx = x + Math.cos(a) * orr, my = y + Math.sin(a) * orr * 0.55, mr = Math.max(1.1, pr * m.k);
        // behind the planet: hidden by its disc
        if (Math.sin(a) < 0 && Math.hypot(mx - x, my - y) < pr + mr) return;
        ctx.fillStyle = m.tone;
        ctx.beginPath();
        ctx.arc(mx, my, mr, 0, 6.283);
        ctx.fill();
        // night side facing away from the star
        const ddx = core.x - mx, ddy = core.y - my, dd = Math.hypot(ddx, ddy) || 1;
        ctx.fillStyle = "rgba(2,2,12,0.55)";
        ctx.beginPath();
        ctx.arc(mx - (ddx / dd) * mr * 0.45, my - (ddy / dd) * mr * 0.45, mr * 0.95, 0, 6.283);
        ctx.fill();
      });
    }
    if (n === this.follow) {
      ctx.strokeStyle = "#ffffff";
      ctx.globalAlpha = 0.5 + 0.3 * Math.sin(t / 300);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, pr + 5, 0, 6.283);
      ctx.stroke();
    }
  }

  drawClusterLabels(ctx) {
    const list = this.clusterList;
    const z = this.cam.zoom;
    if (!list || z > 4.5) return;
    const fade = z < 2.5 ? 1 : 1 - (z - 2.5) / 2;
    const w = this.w, h = this.h;
    const big = [...list].sort((a, b) => b.notes.length - a.notes.length).slice(0, 18);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const c of big) {
      let sx = 0, sy = 0, cnt = 0;
      for (const n of c.notes) if (!n.hid) { sx += n.sx; sy += n.sy; cnt++; }
      if (!cnt) continue;
      sx /= cnt; sy /= cnt;
      if (sx < 0 || sx > w || sy < 0 || sy > h) continue;
      const name = c.key.split("/").pop().replace(/_/g, " ");
      const fs = clamp(10 + Math.sqrt(c.notes.length) * 0.9, 11, 18);
      ctx.font = `${fs}px sans-serif`;
      ctx.globalAlpha = 0.8 * fade;
      ctx.fillStyle = "#05060f";
      ctx.fillText(name, sx + 1, sy - fs * 1.6 + 1);
      ctx.fillStyle = `hsl(${c.hue},80%,82%)`;
      ctx.fillText(name, sx, sy - fs * 1.6);
    }
    ctx.globalAlpha = 1;
  }

  // Schwarzschild ray-trace of a thin disk (units of M, shadow 5.2M, disk 6M-15M); only redone when the viewing inclination changes
  lensBuild(inc, t) {
    const N = 112, E = 17, RIN = 6, ROUT = 15;
    let L = this.lens;
    if (!L) {
      const K = N * N;
      L = this.lens = { N, E, inc: -9, last: -1e9, n: 0, idx: new Int32Array(K), cr: new Float32Array(K * 3), cphi: new Float32Array(K * 3), cw: new Float32Array(K * 3), noise: new Float32Array(256) };
      L.cv = document.createElement("canvas");
      L.cv.width = L.cv.height = N;
      L.ctx = L.cv.getContext("2d");
      L.img = L.ctx.createImageData(N, N);
      const rnd = rng(11), raw = [];
      for (let i = 0; i < 256; i++) raw.push(rnd());
      for (let i = 0; i < 256; i++) L.noise[i] = (raw[i] + raw[(i + 1) & 255] + raw[(i + 2) & 255]) / 3;
    }
    if (Math.abs(inc - L.inc) < 0.035 || t - L.last < 120) return L;
    L.inc = inc; L.last = t;
    const si = Math.sin(inc), ci = Math.cos(inc), ds = 0.03;
    let n = 0, wmax = 0;
    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const X = ((px + 0.5) / N * 2 - 1) * E, Y = -((py + 0.5) / N * 2 - 1) * E;
        const b = Math.hypot(X, Y);
        if (b < 4.5 || b > E * 1.2) continue;
        const ph = X / b, pv = Y / b;
        let u = 0, v = 1 / b, psi = 0, prevz = ci, cnt = 0;
        const base = n * 3;
        L.cw[base] = L.cw[base + 1] = L.cw[base + 2] = 0;
        while (psi < 9.5) {
          v += (-u + 3 * u * u) * ds;
          u += v * ds;
          psi += ds;
          if (u > 0.5 || u <= 0) break;
          const cs = Math.cos(psi), sn = Math.sin(psi);
          const z = cs * ci + sn * pv * si;
          if (z * prevz < 0 && cnt < 3) {
            const r = 1 / u;
            if (r > RIN && r < ROUT) {
              const phi = Math.atan2(sn * ph, cs * si - sn * pv * ci);
              const g = Math.sqrt(Math.max(0.02, 1 - 3 / r)) / (1 + Math.sin(phi) * si * Math.pow(r, -0.5));
              const w = Math.pow(g, 3.5) * Math.pow(r, -0.75) * Math.pow(1 - Math.sqrt(RIN / r), 0.25) * Math.pow(0.9, cnt) * Math.pow(1 - (r - RIN) / (ROUT - RIN), 0.45);
              L.cr[base + cnt] = r; L.cphi[base + cnt] = phi; L.cw[base + cnt] = w;
              if (w > wmax) wmax = w;
              cnt++;
            }
          }
          prevz = z;
        }
        if (cnt) L.idx[n++] = py * N + px;
      }
    }
    L.n = n;
    const sc = 1 / (wmax || 1);
    for (let i = 0; i < n * 3; i++) L.cw[i] *= sc;
    return L;
  }

  // animate the traced disk: gas clumps shear differentially (inner orbits faster) and glow by temperature
  lensFrame(t, power) {
    const L = this.lens, d = L.img.data, nz = L.noise;
    d.fill(0);
    const T = t * 0.0155, TAU = 6.2832;
    for (let k = 0; k < L.n; k++) {
      let I = 0;
      for (let j = 0; j < 3; j++) {
        const w = L.cw[k * 3 + j];
        if (!w) continue;
        const r = L.cr[k * 3 + j];
        let a = (L.cphi[k * 3 + j] - Math.pow(r, -1.5) * T) / TAU;
        a = (a - Math.floor(a)) * 96;
        const ia = Math.floor(a), fa = a - ia, off = Math.floor(r * 1.7) * 53;
        const v = nz[(ia + off) & 255] * (1 - fa) + nz[(ia + 1 + off) & 255] * fa;
        I += w * (0.45 + 1.3 * v);
      }
      I = 1.25 * (1 - Math.exp(-I * 0.9 * Math.min(1.6, power)));
      const o = L.idx[k] * 4;
      d[o] = 255;
      d[o + 1] = Math.min(255, 60 + I * 150);
      d[o + 2] = Math.min(255, I * I * 170);
      d[o + 3] = Math.min(255, I * 260);
    }
    L.ctx.putImageData(L.img, 0, 0);
  }

  drawBlackHole(ctx, t) {
    const bh = this.bh;
    const { x, y, r } = bh;
    const power = 1 + bh.energy * 0.6 + bh.flash;
    const bst = this.opts.bhStyle || "classic";
    const flat = bst === "clean" || bst === "physical";
    const cy = this.cosy, sy = this.siny, cp = this.cosp, sp = this.sinp;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = clamp(0.15 + bh.energy * 0.2 + bh.flash * 0.3, 0, 1) * (flat ? 0.45 : 1);
    const gl = r * 4.5 * (1 + bh.flash * 0.2);
    ctx.drawImage(this.sprite(26, "star"), x - gl, y - gl, gl * 2, gl * 2);

    // accretion disk lies in the galaxy plane, so it follows the camera exactly
    const pt = (d) => {
      const wx = Math.cos(d.ang) * d.rad * r, wy = Math.sin(d.ang) * d.rad * r;
      const y1 = wx * sy + wy * cy;
      return [x + (wx * cy - wy * sy), y - -y1 * sp, y1 * cp > 0];
    };
    const drawDisk = (front) => {
      if (flat) return;
      for (const d of bh.disk) {
        const [px, py, isFar] = pt(d);
        if (isFar === front) continue;
        const s = (1.5 + d.sz * 1.5) * Math.min(2, power);
        ctx.globalAlpha = clamp((0.45 + bh.energy * 0.2) * (1.6 - d.rad / 2.6), 0.05, 1);
        ctx.drawImage(this.sprite(d.hue + bh.energy * 8, "star"), px - s, py - s, s * 2, s * 2);
      }
    };
    // continuous glowing rings with a brighter approaching side, so the disk reads as a disk
    const drawRings = (front) => {
      if (flat) return;
      if (this.lvl < 1) return;
      const rings = bst === "quasar"
        ? [[1.2, 0.14, 52], [1.45, 0.2, 44], [1.75, 0.22, 36], [2.1, 0.18, 28], [2.5, 0.12, 20], [3, 0.08, 12]]
        : bst === "gargantua"
          ? [[1.25, 0.05, 38], [1.4, 0.08, 34], [1.6, 0.06, 30], [1.85, 0.05, 28], [2.15, 0.04, 26], [2.5, 0.03, 24], [3, 0.02, 22]]
          : [[1.35, 0.3, 40], [1.9, 0.2, 30], [2.6, 0.12, 20]];
      const sharp = bst === "gargantua" ? 2.2 : 1;
      const boost = bst === "quasar" ? 1.6 : bst === "gargantua" ? 2 : 1;
      ctx.lineCap = "butt";
      for (const [rad, lw, hue] of rings) {
        ctx.lineWidth = Math.max(1, r * lw);
        const N = 40;
        let [px, py, far] = pt({ ang: 0, rad });
        for (let i = 1; i <= N; i++) {
          const ang = (i / N) * 6.2832;
          const [qx, qy] = pt({ ang, rad });
          if (far !== front) {
            const dop = Math.pow(0.55 + 0.45 * Math.cos(ang - 2.4 - t / 4000), sharp);
            ctx.strokeStyle = `hsl(${hue + bh.energy * 6},100%,${62 + 18 * dop}%)`;
            ctx.globalAlpha = clamp((0.05 + 0.14 * dop) * power * (1.1 - rad / 4) * boost, 0, 0.7);
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(qx, qy);
            ctx.stroke();
          }
          px = qx; py = qy;
          far = pt({ ang, rad })[2];
        }
      }
      ctx.lineCap = "butt";
    };
    // jets along the galaxy's polar axis (screen direction of world +z)
    const mode = this.opts.bhJet || "auto";
    const jet = mode === "off" ? 0 : bst === "gargantua" && mode !== "always" ? 0 : Math.max(bh.jet || 0, bst === "quasar" || mode === "always" ? 0.55 : 0);
    // lensed halo: the far side of the disk bent over and under the hole, as in the Interstellar render
    const drawHalo = () => {
      const N = 48;
      ctx.lineCap = "round";
      for (const [rad, lw, hue] of [[1.1, 0.22, 40], [1.3, 0.16, 34], [1.55, 0.11, 28], [1.85, 0.07, 24]]) {
        ctx.lineWidth = Math.max(1, r * lw);
        for (let i = 0; i < N; i++) {
          const a0 = (i / N) * 6.2832, a1 = ((i + 1.2) / N) * 6.2832;
          const dop = Math.pow(0.5 + 0.5 * Math.cos((a0 + a1) / 2 - 2.4 - t / 5000), 2);
          ctx.strokeStyle = `hsl(${hue},100%,${66 + 28 * dop}%)`;
          ctx.globalAlpha = clamp((0.15 + 0.6 * dop) * power * (1.5 - rad / 1.8), 0, 0.95);
          ctx.beginPath();
          ctx.arc(x, y, r * rad, a0, a1);
          ctx.stroke();
        }
      }
      ctx.lineCap = "butt";
    };
    // jets: drifting smoke and plasma that widen, kink and fade with distance, instead of a solid cone
    const drawJets = () => {
      if (jet < 0.03) return;
      const n = [40, 90, 160, 240][Math.min(3, this.lvl)];
      const len = r * (16 + 46 * jet) * (0.3 + 0.7 * Math.abs(cp));
      ctx.globalCompositeOperation = "lighter";
      const base = r * (1.6 + jet);
      ctx.globalAlpha = clamp(jet * 0.5, 0, 0.6);
      ctx.drawImage(this.sprite(200, "star"), x - base, y - base, base * 2, base * 2);
      for (let i = 0; i < n; i++) {
        const q = bh.jp[i];
        const u = q.u, grow = Math.pow(u, 0.8);
        const kink = Math.sin(u * 8 + q.ph + t * 0.0011) * (0.3 + u * 1.6) + Math.sin(u * 3.1 - t * 0.0007 + q.ph * 2) * u * 1.1;
        const lat = (q.off * (0.15 + grow * 1.5) + kink * 0.7) * r;
        const px = x + lat, py = y - cp * u * len * q.side;
        const fade = Math.pow(1 - u, 1.4) * Math.min(1, u * 8);
        if (q.knot) {
          const s = r * (0.22 + 0.18 * q.sz) * (1 - u * 0.5);
          ctx.globalAlpha = clamp(jet * fade * 0.9, 0, 1);
          ctx.drawImage(this.sprite(190, "star"), px - s, py - s, s * 2, s * 2);
          continue;
        }
        const s = r * (0.35 + grow * 1.5) * q.sz;
        ctx.globalAlpha = clamp(jet * fade * 0.3, 0, 1);
        ctx.drawImage(this.sprite(u < 0.25 ? 195 : u < 0.6 ? 212 : 232, "cloud"), px - s, py - s, s * 2, s * 2);
      }
      ctx.globalAlpha = 1;
    };
    // thin Schwarzschild ray-traced disk: the far side bends over and under the hole, the near side sweeps in front
    const drawLensed = () => {
      const inc = clamp(Math.PI / 2 - this.cam.pitch, 0.03, Math.PI - 0.03);
      const L = this.lensBuild(inc, t);
      this.lensFrame(t, power);
      const s = r / 5.196, ext = L.E * s;
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = 1;
      ctx.drawImage(L.cv, x - ext, y - ext, ext * 2, ext * 2);
    };
    if (bst === "physical" && this.lvl >= 1) drawLensed();
    drawDisk(false);
    drawRings(false);
    if (bst === "gargantua" && this.lvl >= 1) drawHalo();
    drawJets();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 6.283);
    ctx.fill();
    ctx.strokeStyle = flat ? `hsl(40,100%,${82 + bh.flash * 10}%)` : `hsl(32,100%,${60 + bh.flash * 20}%)`;
    ctx.globalAlpha = flat ? 0.75 : clamp(0.55 + bh.energy * 0.2, 0, 1);
    ctx.lineWidth = (flat ? 1 : 1.5) + bh.flash * 1.5;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.03, 0, 6.283);
    ctx.stroke();
    if (flat) {
      // faint photon-ring halo: light that orbited the hole before escaping
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = r * (bst === "clean" ? 0.16 : 0.1);
      ctx.globalAlpha = clamp(0.2 + bh.energy * 0.15 + bh.flash * 0.2, 0, 0.6) * (bst === "clean" ? 1.4 : 1);
      ctx.strokeStyle = "hsl(36,100%,70%)";
      ctx.beginPath();
      ctx.arc(x, y, r * 1.08, 0, 6.283);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "lighter";
    drawDisk(true);
    drawRings(true);
    ctx.globalCompositeOperation = "source-over";
    if (this.opts.labels) {
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = "#ffd9a8";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText("Du", x, y + r * 2.4);
    }
  }

  drawTooltip(ctx) {
    const n = this.hover;
    const text = n.path.replace(/\.md$/, "") + `  ·  ${n.cls}-type star ${n.K} K`;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    const tw = ctx.measureText(text).width + 12;
    const m = this.mouse || { x: n.sx, y: n.sy };
    const bx = clamp(m.x + 14, 4, Math.max(4, this.w - tw - 4));
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "#0b0a1a";
    ctx.fillRect(bx, m.y + 12, tw, 20);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#e8ecff";
    ctx.textBaseline = "top";
    ctx.fillText(text, bx + 6, m.y + 17);
  }

  drawLog(ctx, t) {
    const now = performance.now();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.font = "12px sans-serif";
    this.log = this.log.filter((l) => now - l.t < 8000);
    this.log.forEach((l, i) => {
      ctx.globalAlpha = clamp(1 - (now - l.t) / 8000, 0, 1) * 0.9;
      ctx.fillStyle = `hsl(${l.hue},90%,75%)`;
      ctx.fillText(l.text, 14, this.h - 34 - (this.log.length - 1 - i) * 16);
    });
  }

  /* ---------- picking ---------- */

  hitTest(x, y, wantPlanet = false) {
    const k = this.s0 * this.cam.zoom;
    let best = null, bd = Infinity, bestP = null;
    for (const sys of this.systems || []) {
      for (const p of sys.planets) {
        const d = Math.hypot(p.sx - x, p.sy - y);
        if (p.pr > 2 && d < p.pr + 3 && d < bd) {
          bd = d;
          best = p.nb;
          bestP = p;
        }
      }
    }
    if (best) return wantPlanet ? bestP : best;
    for (const n of this.nodes) {
      const pr = Math.max(n.r * n.p * k * 1.4 * n.sf, 4) + 3;
      const d = Math.hypot(n.sx - x, n.sy - y);
      if (d < pr && d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }
}

/* ------------------------------------------------------------------ */
/* Obsidian view                                                        */
/* ------------------------------------------------------------------ */
class GalaxyView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.g = new Galaxy();
    this.timer = null;
    this.frame = this.frame.bind(this);
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Live Galaxy"; }
  getIcon() { return "orbit"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("live-graph-view");
    // in a popout window, hide all Obsidian chrome so only the galaxy shows
    const solo = () => {
      const doc = this.containerEl.ownerDocument;
      if (doc !== document) {
        doc.body.addClass("lg-solo-window");
        if (!root.querySelector(".lg-dragbar")) {
          const bar = root.createDiv({ cls: "lg-dragbar" });
          bar.createSpan({ text: "✥ Live Galaxy" });
          const x = bar.createEl("button", { text: "✕", attr: { title: "Close window" } });
          x.addEventListener("click", () => this.leaf.detach());
        }
      }
    };
    solo();
    this.registerEvent(this.app.workspace.on("layout-change", solo));
    const wrap = root.createDiv({ cls: "live-graph-wrap" });
    this.canvas = wrap.createEl("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.buildPanel(wrap);
    this.bindPointer();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(wrap);
    this.resize();

    const sched = () => this.scheduleRefresh();
    const v = this.app.vault;
    const mc = this.app.metadataCache;
    this.registerEvent(v.on("create", sched));
    this.registerEvent(v.on("delete", sched));
    this.registerEvent(v.on("rename", sched));
    this.registerEvent(mc.on("resolved", sched));
    this.registerEvent(mc.on("changed", sched));
    this.plugin.views.add(this);

    const preset = this.plugin.data.presets[this.plugin.data.current];
    if (preset) this.g.applyState((({ settings, ...c }) => c)(preset), true);
    if (this.plugin.data.lastCam) this.g.applyState(this.plugin.data.lastCam, true);
    this.g.loadUsage(this.plugin.data.usage);
    this.syncControls();
    this.refresh();
    this.registerInterval(window.setInterval(() => {
      if (!this.g.usageDirty) return;
      this.g.usageDirty = false;
      this.plugin.data.usage = this.g.exportUsage();
      this.plugin.saveData(this.plugin.data);
    }, 30000));
    this.registerInterval(window.setInterval(() => this.updateStats(), 3000));
    this.raf = requestAnimationFrame(this.frame);
  }

  updateStats() {
    const g = this.g;
    const orph = g.nodes.reduce((a, n) => a + (n.deg ? 0 : 1), 0);
    this.statsEl.setText(`${g.nodes.length} notes (${orph} orphans) · ${g.edges.length} links · ${g.Q.name}${g.qMode === "auto" ? " (auto)" : ""} ${g.workMs.toFixed(1)} ms/frame · stream :${this.plugin.data.port} · REST ${this.plugin.restHooked ? "hooked" : "not hooked"}`);
  }

  async onClose() {
    this.plugin.data.lastCam = this.g.getState();
    this.plugin.saveData(this.plugin.data);
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    clearTimeout(this.hiddenTimer);
    for (const id of this.demoTimers || []) clearTimeout(id);
    this.plugin.views.delete(this);
    if (this.ro) this.ro.disconnect();
  }

  buildPanel(wrap) {
    const sb = wrap.createDiv({ cls: "lg-search" });
    this.searchInput = sb.createEl("input", { type: "text", placeholder: "Search note…  (:text  #tag  @folder)  (/)" });
    this.searchList = sb.createDiv({ cls: "lg-search-list" });
    this.contentIdx = new Map();
    this.searchHits = [];
    let seq = 0;
    // lazily builds/refreshes a lowercase text index; only notes changed since the last pass are re-read
    const buildIndex = async (mySeq) => {
      const vault = this.app.vault;
      let i = 0;
      for (const n of this.g.nodes) {
        const file = vault.getAbstractFileByPath(n.path);
        if (!file || !file.stat) continue;
        const old = this.contentIdx.get(n.path);
        if (!old || old.mtime !== file.stat.mtime) {
          try { this.contentIdx.set(n.path, { mtime: file.stat.mtime, text: await vault.cachedRead(file) }); } catch (_) {}
        }
        if (++i % 40 === 0) {
          await new Promise((r) => setTimeout(r, 0));
          if (mySeq !== seq) return false;
        }
      }
      return mySeq === seq;
    };
    const snippet = (text, q) => {
      const at = text.toLowerCase().indexOf(q);
      if (at < 0) return "";
      const from = Math.max(0, at - 28);
      return (from ? "…" : "") + text.slice(from, at + q.length + 48).replace(/\s+/g, " ");
    };
    const tagsOf = (n) => {
      const file = this.app.vault.getAbstractFileByPath(n.path);
      const c = file && this.app.metadataCache.getFileCache(file);
      const out = [];
      for (const t of (c && c.tags) || []) out.push(t.tag.toLowerCase());
      const fm = c && c.frontmatter && c.frontmatter.tags;
      for (const t of Array.isArray(fm) ? fm : typeof fm === "string" ? fm.split(/[,\s]+/) : []) out.push("#" + String(t).toLowerCase().replace(/^#/, ""));
      return out;
    };
    const show = (hits) => {
      this.searchHits = hits.map((h) => h.n);
      this.searchList.empty();
      if (!hits.length) this.searchList.createDiv({ cls: "lg-search-item", text: "No matches" });
      for (const { n, note } of hits) {
        const it = this.searchList.createDiv({ cls: "lg-search-item", text: n.name });
        it.createSpan({ cls: "lg-search-path", text: " " + (note || n.folder) });
        it.addEventListener("click", () => {
          this.flyTo(n);
          this.searchList.empty();
        });
      }
    };
    const runSearch = async () => {
      const raw = this.searchInput.value.trim();
      const mySeq = ++seq;
      this.searchList.empty();
      this.searchHits = [];
      this.searchAll = [];
      if (!raw) return;
      const mode = raw[0] === ":" ? "text" : raw[0] === "#" ? "tag" : raw[0] === "@" ? "folder" : "name";
      const q = (mode === "text" || mode === "folder" ? raw.slice(1) : mode === "tag" ? raw : raw).trim().toLowerCase();
      if (!q) return;
      const nodes = this.g.nodes;
      let hits;
      if (mode === "text") {
        if (q.length < 2) return;
        this.searchList.createDiv({ cls: "lg-search-item", text: "Searching…" });
        if (!(await buildIndex(mySeq))) return;
        hits = [];
        for (const n of nodes) {
          const e = this.contentIdx.get(n.path);
          if (e && e.text.toLowerCase().includes(q)) hits.push({ n, note: snippet(e.text, q) });
        }
        hits.sort((a, b) => b.n.deg - a.n.deg);
      } else if (mode === "tag") {
        hits = nodes.filter((n) => tagsOf(n).some((t) => t.startsWith(q))).sort((a, b) => b.deg - a.deg).map((n) => ({ n }));
      } else if (mode === "folder") {
        hits = nodes.filter((n) => n.path.toLowerCase().includes(q)).sort((a, b) => b.deg - a.deg).map((n) => ({ n, note: n.folder }));
      } else {
        hits = nodes
          .filter((n) => n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
          .sort((a, b) => (b.name.toLowerCase().startsWith(q) ? 1 : 0) - (a.name.toLowerCase().startsWith(q) ? 1 : 0) || b.deg - a.deg)
          .map((n) => ({ n }));
      }
      const total = hits.length;
      show(hits.slice(0, 8));
      if (total > 8) this.searchList.createDiv({ cls: "lg-search-item", text: `+${total - 8} more (Enter pulses all ${total})` });
      this.searchAll = hits.map((h) => h.n);
    };
    this.searchInput.addEventListener("input", runSearch);
    this.searchInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        if ((this.searchAll || []).length > 1) this.plugin.emit({ type: "search", query: this.searchInput.value, paths: this.searchAll.slice(0, 80).map((n) => n.path), intensity: 0.8 });
        const first = this.searchList.firstElementChild;
        if (first) first.click();
      } else if (e.key === "Escape") {
        this.searchInput.value = "";
        this.searchList.empty();
        this.canvas.focus();
      }
    });
    const d = wrap.createEl("details", { cls: "lg-panel" });
    d.open = true;
    d.createEl("summary", { text: "Galaxy" });
    let cur = d;
    const row = (label) => {
      const r = cur.createDiv({ cls: "lg-row" });
      r.createEl("span", { text: label });
      return r;
    };
    // collapsible groups; open/closed state is remembered between sessions
    const section = (title, open) => {
      const st = (this.plugin.data.panelOpen = this.plugin.data.panelOpen || {});
      const sec = d.createEl("details", { cls: "lg-sec" });
      sec.open = st[title] ?? open;
      sec.createEl("summary", { text: title });
      sec.addEventListener("toggle", () => {
        st[title] = sec.open;
        this.plugin.saveData(this.plugin.data);
      });
      cur = sec.createDiv({ cls: "lg-sec-body" });
    };
    this.ctl = {};
    this.optCb = {};
    this.kindCb = {};
    const slider = (key, label, min, max, step) => {
      const r = row(label);
      const inp = r.createEl("input", { type: "range" });
      inp.min = min; inp.max = max; inp.step = step;
      inp.addEventListener("input", () => {
        const val = parseFloat(inp.value);
        this.g.camTween = null;
        this.g.cam[key] = val;
        if (key === "density") this.g.reseedLinkParticles();
      });
      // neutral point: 0 where the range crosses it, otherwise the default; shown as a tick, and releasing the handle near it snaps onto it
      const neutral = min < 0 && max > 0 ? 0 : { winding: 0.4, density: 1, pspeed: 1, spread: 1.4, zoom: 0.8, bhSize: 1.6 }[key] ?? min;
      const dl = r.createEl("datalist");
      dl.id = "lg-dl-" + key;
      dl.createEl("option", { value: String(neutral) });
      inp.setAttribute("list", dl.id);
      inp.title = `Release near the tick (${neutral}) to snap to it`;
      inp.addEventListener("change", () => {
        if (Math.abs(parseFloat(inp.value) - neutral) <= (max - min) * 0.05) {
          inp.value = neutral;
          this.g.camTween = null;
          this.g.cam[key] = neutral;
          if (key === "density") this.g.reseedLinkParticles();
        }
      });
      this.ctl[key] = inp;
    };
    const toggleRow = (label, items) => {
      const tg = row(label);
      for (const [key, text] of items) {
        const l = tg.createEl("label");
        const cb = l.createEl("input", { type: "checkbox" });
        cb.checked = this.g.opts[key];
        l.appendText(text);
        this.optCb[key] = cb;
        cb.addEventListener("change", () => (this.g.opts[key] = cb.checked));
      }
    };
    section("View", true);
    slider("zoom", "Zoom", 0.15, 40, 0.01);
    slider("pitch", "Tilt", -1.55, 1.55, 0.01);
    slider("speed", "Rotation", -6, 6, 0.1);
    slider("winding", "Arm winding", 0, 1.5, 0.05);
    slider("spread", "Spread", 0.6, 3, 0.05);
    slider("orbit", "Planet orbits", -3, 3, 0.1);
    slider("bhSize", "Black hole size", 0.3, 4, 0.05);
    section("Links", true);
    toggleRow("Show", [["links", "Links"], ["orphans", "Orphans"]]);
    slider("density", "Link flow", 0, 3, 0.1);
    slider("pspeed", "Flow speed", 0.1, 4, 0.05);
    const sr = row("Link style");
    this.styleSel = sr.createEl("select");
    for (const [v, text] of [["pulse", "Light pulses"], ["ships", "Tiny ships"], ["web", "Cosmic web"], ["glow", "Neon glow"], ["dash", "Flowing dashes"]]) this.styleSel.createEl("option", { text, value: v });
    this.styleSel.value = this.plugin.data.linkStyle || "pulse";
    this.g.opts.style = this.styleSel.value;
    this.styleSel.addEventListener("change", () => {
      this.g.opts.style = this.styleSel.value;
      this.plugin.data.linkStyle = this.styleSel.value;
      this.plugin.saveData(this.plugin.data);
    });
    const kr = row("Types");
    kr.addClass("lg-kinds");
    for (const [kind, ks] of Object.entries(LINK_KINDS)) {
      const l = kr.createEl("label");
      const sw = l.createSpan({ cls: "lg-swatch" });
      sw.style.background = ks.col;
      const cb = l.createEl("input", { type: "checkbox" });
      cb.checked = this.g.kinds[kind];
      l.appendText(ks.label);
      this.kindCb[kind] = cb;
      cb.addEventListener("change", () => (this.g.kinds[kind] = cb.checked));
    }
    section("Display", true);
    toggleRow("Show", [["labels", "Labels"], ["nebula", "Nebula"]]);
    const bhr = row("Black hole");
    const bhSel = (this.bhSel = bhr.createEl("select"));
    for (const [v, text] of [["clean", "Clean (event horizon)"], ["physical", "Lensed disk (physical)"], ["classic", "Classic particles"], ["quasar", "Quasar (fiery disk)"], ["gargantua", "Gargantua (halo)"]]) bhSel.createEl("option", { text, value: v });
    bhSel.value = this.plugin.data.bhStyle || "physical";
    const bjr = row("BH jets");
    const bjSel = (this.bjSel = bjr.createEl("select"));
    for (const [v, text] of [["auto", "When feeding"], ["always", "Always"], ["off", "Off"]]) bjSel.createEl("option", { text, value: v });
    bjSel.value = this.plugin.data.bhJet || "auto";
    this.g.opts.bhJet = bjSel.value;
    bjSel.addEventListener("change", () => {
      this.g.opts.bhJet = bjSel.value;
      this.plugin.data.bhJet = bjSel.value;
      this.plugin.saveData(this.plugin.data);
    });
    this.g.opts.bhStyle = bhSel.value;
    bhSel.addEventListener("change", () => {
      this.g.opts.bhStyle = bhSel.value;
      this.plugin.data.bhStyle = bhSel.value;
      this.plugin.saveData(this.plugin.data);
    });
    section("Timeline", false);
    const tr = row("Timeline");
    const tlOn = tr.createEl("input", { type: "checkbox" });
    this.tlPlay = tr.createEl("button", { text: "▶", attr: { title: "Play: notes appear in the order they were created" } });
    this.tlSlider = tr.createEl("input", { type: "range" });
    this.tlSlider.min = 0; this.tlSlider.max = 1; this.tlSlider.step = 0.001; this.tlSlider.value = 1;
    this.tlLabel = tr.createEl("span", { cls: "lg-tl-label", text: "" });
    tlOn.addEventListener("change", () => {
      this.g.tl.on = tlOn.checked;
      if (!tlOn.checked) { this.g.tl.playing = false; this.tlPlay.textContent = "▶"; }
      this.syncTimeline();
    });
    this.tlSlider.addEventListener("input", () => {
      this.g.tl.on = true;
      tlOn.checked = true;
      this.g.tl.playing = false;
      this.g.tl.t = parseFloat(this.tlSlider.value);
      this.tlPlay.textContent = "▶";
      this.syncTimeline();
    });
    this.tlPlay.addEventListener("click", () => {
      const tl = this.g.tl;
      if (tl.playing) { tl.playing = false; }
      else {
        tl.on = true;
        tlOn.checked = true;
        if (tl.t >= 0.999) tl.t = 0;
        tl.playing = true;
      }
      this.syncTimeline();
    });
    this.tlOn = tlOn;
    section("Performance", false);
    const qr = row("Quality");
    this.qualSel = qr.createEl("select");
    for (const [v, text] of [["auto", "Auto"], ["0", "Low"], ["1", "Medium"], ["2", "High"], ["3", "Ultra"]]) this.qualSel.createEl("option", { text, value: v });
    this.qualSel.value = this.plugin.data.quality || "auto";
    this.g.setQuality(this.qualSel.value);
    this.qualSel.addEventListener("change", () => {
      this.g.setQuality(this.qualSel.value);
      this.plugin.data.quality = this.qualSel.value;
      this.plugin.saveData(this.plugin.data);
    });
    const goHome = () => this.applyPreset(this.plugin.data.presets[this.plugin.data.current] || DEFAULT_PRESETS.Galaxy);
    section("Presets", false);
    const pr = row("Preset");
    this.presetSel = pr.createEl("select");
    this.presetSel.addEventListener("change", () => {
      const name = this.presetSel.value;
      const s = this.plugin.data.presets[name];
      if (!s) return;
      this.plugin.data.current = name;
      this.plugin.saveData(this.plugin.data);
      this.applyPreset(s);
    });
    const sv = cur.createDiv({ cls: "lg-row" });
    this.nameInput = sv.createEl("input", { type: "text", placeholder: "Preset name" });
    sv.createEl("button", { text: "Save" }).addEventListener("click", () => this.savePreset());
    sv.createEl("button", { text: "Delete" }).addEventListener("click", () => this.deletePreset());
    const act = cur.createDiv({ cls: "lg-row" });
    act.createEl("button", { text: "Demo stream" }).addEventListener("click", () => this.demo());
    act.createEl("button", { text: "Home" }).addEventListener("click", goHome);

    section(`Legend · v${this.plugin.manifest.version}`, false);
    const head = (text) => cur.createDiv({ cls: "lg-leg-h", text });
    const item = (text, style) => {
      const it = cur.createDiv({ cls: "lg-leg-item" });
      const sw = it.createSpan({ cls: "lg-swatch" });
      if (style) Object.assign(sw.style, style);
      else sw.style.visibility = "hidden";
      it.createSpan({ text });
    };
    head("Stars (notes)");
    item("Colour = top-level folder; position = folder cluster", { background: "linear-gradient(90deg,#6ab0ff,#ff8a5a)" });
    item("Size = number of links; glow = recent activity", { background: "#fff", boxShadow: "0 0 6px #ffd9a8" });
    item("Black hole = you (Labels shows the name)", { background: "#000", boxShadow: "0 0 0 2px #ffb060" });
    head("Links");
    const LK = {
      local: "Inside the same top folder",
      bridge: "Between top folders",
      mutual: "Both notes link to each other",
      index: "From _index notes (structure)",
      embed: "Embedded note",
      prop: "Frontmatter property link",
    };
    for (const [kind, ks] of Object.entries(LINK_KINDS)) item(LK[kind] || ks.label, { background: ks.col });
    item("Moving light / ships = flow along links (Link style)");
    head("Planets");
    item("Rocky and lava inside the frost line, gas/ice giants beyond");
    item("Earth-likes only in the habitable zone of F/G/K/M stars");
    item("Asteroid belt inside the frost line, Kuiper belt outside");
    item("Moons mostly around giants; rings only on giants");
    head("Markers");
    item("Ring = orphan note (Orphans)", { border: "1px solid #9fb0ff", background: "transparent", borderRadius: "50%" });
    item("Green pulse = search result", { background: "#5dffa0", borderRadius: "50%" });
    head("Controls");
    item("Drag orbit · right/Shift-drag pan · Shift-click zoom to star or planet · wheel zoom · double-click fly to star");
    item("Keys: arrows orbit · +/- zoom · Home reset · Space pause · / search (:text #tag @folder) · Esc stop following");
    item("Sliders: release near the tick to snap to the neutral value");
    wrap.createEl("button", { cls: "lg-home", text: "⌂ Home", attr: { title: "Reset view to the whole galaxy (double-click empty space also works)" } }).addEventListener("click", goHome);
    const hint = wrap.createDiv({ cls: "lg-hint", text: "Drag: orbit · Right/Shift-drag: pan · Shift-click: zoom to star/planet · Wheel: zoom to cursor · Double-click: fly to star" });
    this.registerInterval(window.setTimeout(() => hint.addClass("lg-hint-hide"), 12000));
    this.statsEl = wrap.createDiv({ cls: "live-graph-stats" });
    this.fillPresets();
  }

  fillPresets() {
    this.presetSel.empty();
    for (const name of Object.keys(this.plugin.data.presets)) {
      const o = this.presetSel.createEl("option", { text: name });
      o.value = name;
    }
    this.presetSel.value = this.plugin.data.current;
  }

  // everything a preset remembers besides the camera: toggles, styles, link types and quality
  getSettings() {
    const g = this.g;
    return { opts: Object.assign({}, g.opts), kinds: Object.assign({}, g.kinds), quality: this.qualSel.value };
  }

  applyPreset(s, instant) {
    const { settings, ...cam } = s;
    this.g.applyState(cam, instant);
    if (!settings) return;
    const g = this.g, d = this.plugin.data;
    Object.assign(g.opts, settings.opts || {});
    Object.assign(g.kinds, settings.kinds || {});
    for (const [k, cb] of Object.entries(this.optCb)) cb.checked = !!g.opts[k];
    for (const [k, cb] of Object.entries(this.kindCb)) cb.checked = !!g.kinds[k];
    this.styleSel.value = g.opts.style; d.linkStyle = g.opts.style;
    this.bhSel.value = g.opts.bhStyle; d.bhStyle = g.opts.bhStyle;
    this.bjSel.value = g.opts.bhJet; d.bhJet = g.opts.bhJet;
    if (settings.quality) {
      this.qualSel.value = settings.quality;
      g.setQuality(settings.quality);
      d.quality = settings.quality;
    }
    this.plugin.saveData(d);
  }

  savePreset() {
    const name = this.nameInput.value.trim() || this.presetSel.value;
    if (!name) return;
    this.plugin.data.presets[name] = Object.assign(this.g.getState(), { settings: this.getSettings() });
    this.plugin.data.current = name;
    this.plugin.saveData(this.plugin.data);
    this.fillPresets();
    this.nameInput.value = "";
    new Notice(`Preset "${name}" saved`);
  }

  deletePreset() {
    const name = this.presetSel.value;
    if (Object.keys(this.plugin.data.presets).length <= 1) return;
    delete this.plugin.data.presets[name];
    this.plugin.data.current = Object.keys(this.plugin.data.presets)[0];
    this.plugin.saveData(this.plugin.data);
    this.fillPresets();
  }

  syncTimeline() {
    const g = this.g, tl = g.tl;
    this.tlPlay.textContent = tl.playing ? "❚❚" : "▶";
    if (document.activeElement !== this.tlSlider) this.tlSlider.value = tl.t;
    if (!tl.on) { this.tlLabel.textContent = ""; return; }
    const d = new Date(g.tlMin + tl.t * (g.tlMax - g.tlMin));
    const vis = g.nodes.reduce((s, n) => s + (n.hid ? 0 : 1), 0);
    this.tlLabel.textContent = `${d.toISOString().slice(0, 10)} · ${vis}`;
  }

  syncControls() {
    const c = this.g.cam;
    for (const k of Object.keys(this.ctl)) {
      if (document.activeElement !== this.ctl[k]) this.ctl[k].value = c[k];
    }
    if (this.g.tl.playing || this.g.tl.on) {
      if (!this.g.tl.playing) this.tlPlay.textContent = "▶";
      this.tlOn.checked = this.g.tl.on;
      this.syncTimeline();
    }
  }

  demo() {
    const ns = this.g.nodes;
    if (!ns.length) return;
    const pick = (n) => Array.from({ length: n }, () => ns[Math.floor(Math.random() * ns.length)].path);
    this.plugin.emit({ type: "ai", query: "demo: AI question", paths: pick(14), intensity: 1 });
    this.demoTimers = [
      setTimeout(() => this.plugin.emit({ type: "search", query: "demo: search", paths: pick(5), intensity: 0.6 }), 1800),
      setTimeout(() => this.plugin.emit({ type: "read", paths: pick(2), intensity: 0.3 }), 3200),
    ];
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, this.g.Q.dpr);
    const w = Math.max(100, r.width), h = Math.max(100, r.height);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.g.resize(w, h, dpr);
  }

  scheduleRefresh() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 400);
  }

  refresh() {
    const files = this.app.vault.getMarkdownFiles().filter((f) => !EXCLUDE.test(f.path));
    const headings = new Map();
    const extra = { embed: new Set(), prop: new Set() };
    const mc = this.app.metadataCache;
    const addKind = (set, f, link) => {
      const dest = mc.getFirstLinkpathDest(String(link).split("#")[0].split("|")[0], f.path);
      if (dest && dest.path !== f.path) set.add(f.path < dest.path ? f.path + "|" + dest.path : dest.path + "|" + f.path);
    };
    for (const f of files) {
      const cache = mc.getFileCache(f);
      const hs = cache?.headings;
      if (hs && hs.length) headings.set(f.path, hs.slice(0, 8).map((h) => ({ text: h.heading, level: h.level })));
      for (const em of cache?.embeds || []) addKind(extra.embed, f, em.link);
      for (const fl of cache?.frontmatterLinks || []) addKind(extra.prop, f, fl.link);
    }
    this.g.setGraph(files, mc.resolvedLinks, headings, extra);
    this.updateStats();
  }

  ingest(ev) {
    this.g.ingest(ev);
  }

  bindPointer() {
    const c = this.canvas;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    let drag = null;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      c.focus({ preventScroll: true });
      const p = pos(e);
      drag = { x: p.x, y: p.y, moved: false, pan: e.button === 2 || e.button === 1 || e.shiftKey };
      this.g.camTween = null;
      this.g.homing = false;
    });
    c.addEventListener("pointermove", (e) => {
      const p = pos(e);
      this.g.mouse = p;
      if (drag) {
        const dx = p.x - drag.x, dy = p.y - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.pan) this.g.panBy(dx, dy);
        else {
          this.g.cam.yaw += dx * 0.006;
          this.g.cam.pitch = clamp(this.g.cam.pitch + dy * 0.006, -1.55, 1.55);
        }
        drag.x = p.x;
        drag.y = p.y;
      } else {
        this.g.hover = this.g.hitTest(p.x, p.y);
        c.classList.toggle("lg-pointer", !!this.g.hover);
      }
    });
    c.addEventListener("pointerup", (e) => {
      const p = pos(e);
      if (drag && !drag.moved) {
        if (e.shiftKey) {
          // Shift-click: zoom in on the point (planets included) instead of opening the note
          const n = this.g.hitTest(p.x, p.y, true);
          if (n) this.flyTo(n, false);
        } else {
          const n = this.g.hitTest(p.x, p.y);
          if (n) this.openNode(n, e.ctrlKey || e.metaKey);
        }
      }
      drag = null;
    });
    c.addEventListener("pointerleave", () => {
      if (!drag) this.g.hover = null;
    });
    c.addEventListener("dblclick", (e) => {
      const p = pos(e);
      const n = this.g.hitTest(p.x, p.y);
      if (n) {
        this.flyTo(n, false);
      } else {
        this.g.follow = null;
        this.g.homing = true;
      }
    });
    c.tabIndex = 0;
    c.addEventListener("keydown", (e) => {
      const g = this.g, cam = g.cam;
      let used = true;
      g.camTween = null;
      switch (e.key) {
        case "ArrowLeft": cam.yaw -= 0.08; break;
        case "ArrowRight": cam.yaw += 0.08; break;
        case "ArrowUp": cam.pitch = clamp(cam.pitch - 0.06, -1.55, 1.55); break;
        case "ArrowDown": cam.pitch = clamp(cam.pitch + 0.06, -1.55, 1.55); break;
        case "+": case "=": g.zoomAt(1.2, g.cx, g.cy); break;
        case "-": case "_": g.zoomAt(1 / 1.2, g.cx, g.cy); break;
        case "Home": case "0": g.follow = null; g.home(); break;
        case " ": g.paused = !g.paused; break;
        case "Escape": g.follow = null; break;
        case "/": this.searchInput.focus(); break;
        default: used = false;
      }
      if (used) e.preventDefault();
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.g.camTween = null;
        const p = pos(e);
        this.g.zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
      },
      { passive: false }
    );
  }

  flyTo(n, pulse = true) {
    this.g.follow = n;
    this.g.homing = false;
    // planets carry their own world radius and perspective factor
    const sz = n.wr ? n.wr * n.pp : n.r * 1.4 * n.sf * n.p;
    this.g.camTween = Object.assign({}, this.g.cam, { zoom: clamp(45 / (sz * this.g.s0), 3, 40) });
    if (pulse) this.g.pulse = { n, t0: performance.now() };
  }

  openNode(node, newTab) {
    const file = this.app.vault.getAbstractFileByPath(node.path);
    if (!file) return;
    const ws = this.app.workspace;
    const leaf = newTab ? ws.getLeaf("tab") : ws.getLeavesOfType("markdown")[0] || ws.getLeaf("split");
    leaf.openFile(file);
  }

  frame(t) {
    const dt = Math.min(60, t - (this.last || t));
    this.last = t;
    if (!this.canvas.isConnected || this.canvas.offsetParent === null) {
      this.last = 0;
      this.hiddenTimer = setTimeout(() => (this.raf = requestAnimationFrame(this.frame)), 500);
      return;
    }
    this.raf = requestAnimationFrame(this.frame);
    const w0 = performance.now();
    this.g.step(dt);
    this.g.draw(this.ctx, t);
    this.g.perf(performance.now() - w0, t);
    if (this.g.qChanged) {
      this.g.qChanged = false;
      this.resize();
    }
    if ((this.n = (this.n || 0) + 1) % 20 === 0) this.syncControls();
  }
}

/* ------------------------------------------------------------------ */
/* Plugin: view registration, event ingestion + streaming interface     */
/* ------------------------------------------------------------------ */
class LiveGraphPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.data = Object.assign({ port: 27201, serverEnabled: true, current: "Galaxy" }, saved);
    this.data.presets = Object.assign({}, DEFAULT_PRESETS, saved.presets || {});
    if (!this.data.token) this.data.token = this.makeToken();
    await this.saveData(this.data);

    this.views = new Set();
    this.sse = new Set();
    this.registerView(VIEW_TYPE, (leaf) => new GalaxyView(leaf, this));
    this.addRibbonIcon("orbit", "Open Live Galaxy", () => this.openView());
    this.addCommand({ id: "open-live-graph", name: "Open Live Galaxy", callback: () => this.openView() });
    this.addCommand({
      id: "open-live-graph-window",
      name: "Open Live Galaxy in its own window",
      callback: async () => {
        for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE)) l.detach();
        const leaf = this.app.workspace.openPopoutLeaf({ size: { width: 1200, height: 800 } });
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
      },
    });
    this.addCommand({
      id: "live-galaxy-demo",
      name: "Live Galaxy: demo stream",
      callback: () => this.views.forEach((v) => v.demo()),
    });

    this.registerEvent(
      this.app.workspace.on("file-open", (f) => {
        if (f && f.extension === "md") this.emit({ type: "read", paths: [f.path], intensity: 0.25, source: "obsidian" });
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        const now = Date.now();
        if (f.extension === "md" && now - (this.lastWrite || 0) > 3000) {
          this.lastWrite = now;
          this.emit({ type: "write", paths: [f.path], intensity: 0.2, source: "obsidian" });
        }
      })
    );
    this.startServer();

    this.registerEvent(this.app.workspace.on("obsidian-local-rest-api:loaded", () => this.hookRestApi()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.hookSearchView()));
    this.app.workspace.onLayoutReady(() => {
      let tries = 0;
      const iv = window.setInterval(() => {
        if (this.hookRestApi() || ++tries > 15) window.clearInterval(iv);
      }, 2000);
      this.registerInterval(iv);
      this.hookSearchView();
    });
  }

  /* Observe authenticated Local REST API calls (agents/MCP) and show them as usage events. */
  hookRestApi() {
    if (this.data.hookRestApi === false) return false;
    const rest = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins["obsidian-local-rest-api"];
    const api = rest && rest.requestHandler && rest.requestHandler.api;
    if (!api || typeof api.handle !== "function") return false;
    if (api.__galaxyOriginalHandle) return true;
    const original = api.handle;
    const self = this;
    api.__galaxyOriginalHandle = original;
    api.handle = function () {
      try {
        self.observeRest(arguments[0], arguments[1]);
      } catch (e) {
        /* observing must never break the API */
      }
      return original.apply(this, arguments);
    };
    this.restApi = api;
    this.restHooked = true;
    return true;
  }

  unhookRestApi() {
    const api = this.restApi;
    if (api && api.__galaxyOriginalHandle) {
      api.handle = api.__galaxyOriginalHandle;
      delete api.__galaxyOriginalHandle;
    }
    this.restHooked = false;
  }

  observeRest(req, res) {
    if (!req || !res || !req.url) return;
    const url = new URL(req.url, "http://127.0.0.1");
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch (e) {
      return;
    }
    const method = req.method;
    const done = (fn) =>
      res.once("finish", () => {
        if (res.statusCode < 400) fn();
      });
    if (path.startsWith("/vault/")) {
      const rel = path.slice(7);
      if (!rel || rel.endsWith("/")) return;
      if (method === "GET") done(() => this.emit({ type: "ai", paths: [rel], intensity: 0.4, source: "rest" }));
      else if (["PUT", "POST", "PATCH", "DELETE"].includes(method))
        done(() => this.emit({ type: "write", paths: [rel], intensity: 0.35, source: "rest" }));
    } else if (path.startsWith("/search")) {
      const query = url.searchParams.get("query") || "search";
      let body = null;
      const send = res.send;
      res.send = function (b) {
        body = b;
        return send.apply(this, arguments);
      };
      done(() => {
        let paths = [];
        try {
          const text = typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : "";
          const j = JSON.parse(text);
          if (Array.isArray(j)) paths = j.map((x) => x && x.filename).filter(Boolean).slice(0, 60);
        } catch (e) {
          /* non-JSON response */
        }
        this.emit({ type: "ai", query, paths, intensity: clamp(0.5 + paths.length / 60, 0.5, 1.2), source: "rest" });
      });
    } else if ((path.startsWith("/active/") && method === "GET") || (path.startsWith("/open/") && method === "POST")) {
      done(() => {
        const f = path.startsWith("/open/") ? { path: path.slice(6) } : this.app.workspace.getActiveFile();
        if (f) this.emit({ type: "ai", paths: [f.path], intensity: 0.35, source: "rest" });
      });
    }
  }

  /* Observe Obsidian's own search pane (typing a query) as "search" events. */
  hookSearchView() {
    for (const leaf of this.app.workspace.getLeavesOfType("search")) {
      const view = leaf.view;
      const inp = view && view.searchComponent && view.searchComponent.inputEl;
      if (!inp || view.__galaxyHooked) continue;
      view.__galaxyHooked = true;
      let timer = null;
      this.registerDomEvent(inp, "input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const q = inp.value.trim();
          if (q.length < 2) return;
          const lookup = view.dom && view.dom.resultDomLookup;
          const paths = lookup && typeof lookup.keys === "function" ? [...lookup.keys()].map((f) => f.path).filter(Boolean).slice(0, 60) : [];
          this.emit({ type: "search", query: q, paths, intensity: clamp(0.4 + paths.length / 80, 0.4, 1), source: "obsidian-search" });
        }, 900);
      });
    }
  }

  makeToken() {
    try {
      return require("crypto").randomBytes(18).toString("hex");
    } catch (e) {
      return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
  }

  emit(ev) {
    this.views.forEach((v) => v.ingest(ev));
    const line = `data: ${JSON.stringify(Object.assign({ ts: Date.now() }, ev))}\n\n`;
    for (const res of this.sse) {
      try {
        res.write(line);
      } catch (e) {
        this.sse.delete(res);
      }
    }
  }

  startServer() {
    if (!this.data.serverEnabled) return;
    let http;
    try {
      http = require("http");
    } catch (e) {
      return;
    }
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const send = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      // browsers always send Origin on cross-site requests; refuse them
      if (req.headers.origin) return send(403, { error: "forbidden" });
      const token = req.headers["x-graph-token"] || url.searchParams.get("token");
      if (token !== this.data.token) return send(401, { error: "bad token" });
      if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true, views: this.views.size });
      if (req.method === "GET" && url.pathname === "/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": connected\n\n");
        this.sse.add(res);
        req.on("close", () => this.sse.delete(res));
        return;
      }
      if (req.method === "POST" && url.pathname === "/event") {
        let body = "";
        req.on("data", (c) => {
          body += c;
          if (body.length > 65536) req.destroy();
        });
        req.on("end", () => {
          try {
            const ev = JSON.parse(body || "{}");
            const list = (Array.isArray(ev) ? ev : [ev]).slice(0, 50);
            if (!list.every((e) => e && typeof e === "object" && !Array.isArray(e))) {
              send(400, { error: "events must be objects" });
              return;
            }
            for (const e of list) {
              this.emit({
                type: typeof e.type === "string" ? e.type : "search",
                query: typeof e.query === "string" ? e.query.slice(0, 200) : undefined,
                paths: Array.isArray(e.paths) ? e.paths.filter((p) => typeof p === "string").slice(0, 100) : undefined,
                intensity: Number.isFinite(Number(e.intensity)) ? Number(e.intensity) : undefined,
                source: typeof e.source === "string" ? e.source.slice(0, 40) : "api",
              });
            }
            send(200, { ok: true, accepted: list.length });
          } catch (e) {
            send(400, { error: "invalid json" });
          }
        });
        return;
      }
      send(404, { error: "not found" });
    });
    this.server.on("error", (e) => new Notice(`Live Galaxy stream server: ${e.code || e.message}`));
    this.server.listen(this.data.port, "127.0.0.1");
  }

  async openView() {
    const ws = this.app.workspace;
    const existing = ws.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  onunload() {
    this.unhookRestApi();
    for (const leaf of this.app.workspace.getLeavesOfType("search")) {
      if (leaf.view) delete leaf.view.__galaxyHooked;
    }
    for (const res of this.sse) {
      try { res.end(); } catch (e) { /* ignore */ }
    }
    if (this.server) this.server.close();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }
}

module.exports = LiveGraphPlugin;
module.exports.Galaxy = Galaxy;
