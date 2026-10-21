// Headless smoke/perf test for the Live Galaxy engine.
// Usage: node scripts/smoke.js [notes=800]
// Needs @napi-rs/canvas (npm i @napi-rs/canvas in a scratch dir; set CANVAS_DIR to it, or it is installed globally).
const fs = require("fs");
const path = require("path");
const Module = require("module");

let canvasLib;
for (const dir of [process.env.CANVAS_DIR, path.join(process.env.TEMP || "", "shipprev"), "."]) {
  if (!dir) continue;
  try {
    canvasLib = require(require.resolve("@napi-rs/canvas", { paths: [dir] }));
    break;
  } catch (_) {}
}
if (!canvasLib) {
  console.error("SKIP: @napi-rs/canvas not found (set CANVAS_DIR)");
  process.exit(2);
}

global.document = { createElement: () => canvasLib.createCanvas(8, 8) };
global.window = global;
const src = fs.readFileSync(process.env.MAIN_JS || path.join(__dirname, "..", "main.js"), "utf8");
const stub = { Plugin: class {}, ItemView: class {}, Notice: class {} };
const mod = { exports: {} };
const req = (n) => (n === "obsidian" ? stub : Module.createRequire(__filename)(n));
new Function("require", "module", src + "\nmodule.exports.__t = { Galaxy, QUALITY };")(req, mod);
const { Galaxy, QUALITY } = mod.exports.__t;

const N = +process.argv[2] || 800;
const folders = ["Companies/Cytiva", "Work/Projects/ME", "Work/Teams", "Learning/Programming", "Learning/Knowledge", "Scratch/Kludd"];
const files = [];
const resolved = {};
for (let i = 0; i < N; i++) {
  const p = `${folders[i % folders.length]}/note${i}.md`;
  files.push({ path: p, basename: `note${i}`, stat: { mtime: 1.7e12 + i * 1e6 } });
}
for (let i = 0; i < N * 1.5; i++) {
  const a = files[Math.floor(Math.random() * N)].path, b = files[Math.floor(Math.random() * N)].path;
  (resolved[a] = resolved[a] || {})[b] = 1;
}

let failed = false;
for (const [lvl, zoom] of [[3, 0.8], [3, 8], [1, 0.8], [0, 8]]) {
  try {
    const g = new Galaxy();
    g.resize(1200, 800, 1);
    g.setGraph(files, resolved, new Map());
    g.setQuality(String(lvl));
    g.cam.zoom = zoom;
    g.opts.orphans = true;
    const c = canvasLib.createCanvas(1200, 800).getContext("2d");
    const frames = 90, times = [];
    for (let f = 0; f < frames; f++) {
      const t0 = process.hrtime.bigint();
      g.step(16);
      g.draw(c, f * 16);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    if (process.env.SPIKES) console.log("  slowest frames:", times.map((t, i) => [i, +t.toFixed(0)]).filter(x => x[1] > 60).slice(0, 8).join(" | "));
    times.sort((a, b) => a - b);
    console.log(`${QUALITY[lvl].name.padEnd(6)} zoom ${String(zoom).padEnd(3)} median ${times[45].toFixed(1)} ms  p95 ${times[85].toFixed(1)} ms  ships<=${g.Q.ships}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL level ${lvl} zoom ${zoom}:`, e.stack);
  }
}
console.log(failed ? "SMOKE FAILED" : "SMOKE OK");
process.exit(failed ? 1 : 0);
