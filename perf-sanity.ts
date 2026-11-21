// Quick perf sanity on the four benchmark workloads' hot paths.
const BASE = process.env.FORGE_URL ?? 'http://localhost:41234';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

async function j(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

const owner = 'adaiversen';
const stamp = Date.now();

// write workload shape: 200 sequential POST issues
const w = await j('POST', '/api/v3/user/repos', { name: `perf-write-${stamp}`, private: true });
if (w.status !== 201) { console.log('repo create failed', w.status); process.exit(1); }
{
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) {
    const r = await j('POST', `/api/v3/repos/${owner}/perf-write-${stamp}/issues`, { title: `issue ${i}`, body: 'x' });
    if (r.status !== 201) { console.log('write failed at', i, r.status); process.exit(1); }
  }
  console.log(`write: 200 issues in ${Math.round(performance.now() - t0)}ms (house T_ref 349ms)`);
}
{
  const t0 = performance.now();
  for (let i = 0; i < 500; i++) {
    const r = await j('GET', `/api/v3/repos/${owner}/perf-write-${stamp}/issues/1`);
    if (r.status !== 200) { console.log('read failed', r.status); process.exit(1); }
  }
  console.log(`read: 500 GETs in ${Math.round(performance.now() - t0)}ms (2.5x scaled house T_ref ~690ms)`);
}
await j('DELETE', `/api/v3/repos/${owner}/perf-write-${stamp}`);
console.log('done');
