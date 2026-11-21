// Drive the kit's actual benchmark (all four timed workloads) against the local forge.
// Usage: node --experimental-strip-types run-perf.ts

const kitSource = '/Users/devin/makefun/kit-ghclone/github-core-clone-01-kit/program/env/src';
const forgeOrigin = process.env.FORGE_URL ?? 'http://localhost:41234';
const bearerToken = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';

const { runBenchmark } = await import(`${kitSource}/bench.ts`);

const results = await runBenchmark({
  baseUrl: forgeOrigin,
  token: bearerToken,
  rounds: 3,
  warmupOps: 5,
  log: (line) => console.log(line),
});

const referenceTimes: Record<string, number> = { push: 1640.82, clone: 266.941, read: 2759.715, write: 348.965 };

console.log('\n==== RESULTS ====');
for (const workload of results.workloads) {
  const reference = referenceTimes[workload.name] ?? 0;
  const ratio = reference > 0 ? (workload.p50_ms / reference).toFixed(2) : 'n/a';
  const errorText = workload.error ? `  ERROR: ${workload.error}` : '';
  console.log(`${workload.name}: p50=${workload.p50_ms}ms  (T_ref=${reference}ms, ratio=${ratio}x)  points=${workload.points}${errorText}`);
}
console.log(`points_total: ${results.points_total}/200`);
console.log(`perf_p50_us: ${results.perf_p50_us}`);
