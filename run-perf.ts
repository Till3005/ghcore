// Runs the kit's REAL benchmark (the four timed workloads) against the local forge.
// Usage: node --experimental-strip-types run-perf.ts

const KIT = '/Users/devin/makefun/kit-ghclone/github-core-clone-01-kit/program/env/src';
const BASE = process.env.FORGE_URL ?? 'http://localhost:41234';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';

const { runBenchmark } = await import(`${KIT}/bench.ts`);

const perf = await runBenchmark({
  baseUrl: BASE,
  token: TOKEN,
  rounds: 3,
  warmupOps: 5,
  log: (line) => console.log(line),
});

console.log('\n==== RESULTS ====');
for (const w of perf.workloads) {
  const tref = { push: 1640.82, clone: 266.941, read: 2759.715, write: 348.965 }[w.name] ?? 0;
  const ratio = tref > 0 ? (w.p50_ms / tref).toFixed(2) : 'n/a';
  console.log(`${w.name}: p50=${w.p50_ms}ms  (T_ref=${tref}ms, ratio=${ratio}x)  points=${w.points}${w.error ? `  ERROR: ${w.error}` : ''}`);
}
console.log(`points_total: ${perf.points_total}/200`);
console.log(`perf_p50_us: ${perf.perf_p50_us}`);
