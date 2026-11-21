// Lightweight timing probe for the hot paths of the four benchmark workloads.
const origin = process.env.FORGE_URL ?? 'http://localhost:41234';
const authToken = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';
const requestHeaders = { 'content-type': 'application/json', authorization: `Bearer ${authToken}` };

async function callApi(method: string, path: string, payload?: unknown) {
  const reply = await fetch(`${origin}${path}`, {
    method,
    headers: requestHeaders,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const raw = await reply.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch {}
  return { status: reply.status, json: parsed };
}

const userLogin = 'adaiversen';
const runStamp = Date.now();
const newRepoName = `perf-write-${runStamp}`;
const repoPath = `/api/v3/repos/${userLogin}/${newRepoName}`;

// Write shape: 200 issue creations performed one after another.
const created = await callApi('POST', '/api/v3/user/repos', { name: newRepoName, private: true });
if (created.status !== 201) {
  console.log('repo create failed', created.status);
  process.exit(1);
}

{
  const startedAt = performance.now();
  for (let index = 0; index < 200; index += 1) {
    const outcome = await callApi('POST', `${repoPath}/issues`, { title: `issue ${index}`, body: 'x' });
    if (outcome.status !== 201) {
      console.log('write failed at', index, outcome.status);
      process.exit(1);
    }
  }
  console.log(`write: 200 issues in ${Math.round(performance.now() - startedAt)}ms (house T_ref 349ms)`);
}
{
  const startedAt = performance.now();
  for (let index = 0; index < 500; index += 1) {
    const outcome = await callApi('GET', `${repoPath}/issues/1`);
    if (outcome.status !== 200) {
      console.log('read failed', outcome.status);
      process.exit(1);
    }
  }
  console.log(`read: 500 GETs in ${Math.round(performance.now() - startedAt)}ms (2.5x scaled house T_ref ~690ms)`);
}
await callApi('DELETE', repoPath);
console.log('done');
