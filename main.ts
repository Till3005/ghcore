// Entry-point lifecycle negotiated with the harness. The flow: grab an ephemeral TCP port, report it
// to the env, then wait until the env declares the trial finished and leave with status zero.
//
//   1. MAKEFUN_ENV_URL is the env origin (http://store:8080 inside a trial). No URL means no env, and
//      the program fails immediately.
//   2. createApp() plus listen(0) lets the kernel choose a free port; port 8080 belongs to the env.
//   3. POST <env>/register {"port": N}. The env combines the peer address with N to form our base URL.
//      The first registration wins: a 409 simply means another entry got there first.
//   4. Poll GET <env>/done until {"done":true}. Each answer is immediate; transient failures back off
//      exponentially, and this process must never exit on its own before the env says done.
//   5. Close the listener and exit 0 so the harness can stop the env and collect the scorer export.
//
// Only the server factory is imported here: no packages, no Node built-ins, no model calls.

import { createApp } from './app.ts';

const harnessOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (harnessOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const CALL_TIMEOUT = 30_000;
const FIRST_BACKOFF = 250;
const BACKOFF_CEILING = 2_000;

function pause(duration: number): Promise<void> {
  return new Promise((done) => setTimeout(done, duration));
}

function backoffFor(attempt: number): number {
  return Math.min(BACKOFF_CEILING, FIRST_BACKOFF * 2 ** Math.min(attempt, 8));
}

// 200 means accepted, 409 means someone else registered first. Contract errors (400/405) are fatal;
// everything else may be a still-warming env, so it is retried.
async function tellEnvMyPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${harnessOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new Error(`register answered HTTP ${answer.status}: ${await answer.text()}`);
      }
    } catch (problem) {
      if (problem instanceof Error && problem.message.startsWith('register answered HTTP ')) throw problem;
    }
    await pause(backoffFor(attempt));
  }
}

async function awaitCompletion(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${harnessOrigin}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT) });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // No reply (or a timeout) only means the suite has not finished yet.
    }
    await pause(backoffFor(attempt));
  }
}

async function run(): Promise<void> {
  const listener = createApp();
  await new Promise<void>((accept, reject) => {
    listener.once('error', reject);
    listener.listen(0, () => accept());
  });
  const bound = listener.address();
  if (bound === null || typeof bound === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await tellEnvMyPort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitCompletion();
  listener.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (problem) {
  process.stderr.write(`[entry] ${problem instanceof Error ? problem.message : String(problem)}\n`);
  process.exit(1);
}
