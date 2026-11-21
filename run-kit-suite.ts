// Runs the kit's REAL conformance suite against the local forge.
// Usage: node --experimental-strip-types run-kit-suite.ts [group...]

const KIT = '/Users/devin/makefun/kit-ghclone/github-core-clone-01-kit/program/env/src';
const BASE = process.env.FORGE_URL ?? 'http://localhost:41234';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';

const { buildScenario } = await import(`${KIT}/wire.ts`);
const { restChecks, restProtocolChecks } = await import(`${KIT}/checks-rest.ts`);
const { GRAPHQL_CHECKS, configureGraphQLGit } = await import(`${KIT}/checks-graphql.ts`);
const { MCP_CHECKS } = await import(`${KIT}/checks-mcp.ts`);
const { GIT_CHECKS } = await import(`${KIT}/checks-git.ts`);
const { GitClient } = await import(`${KIT}/git-client.ts`);

const scenario = buildScenario();
const groups = process.argv.slice(2);

const suites: Array<{ name: string; specs: ReturnType<typeof restChecks> }> = [];
if (groups.length === 0 || groups.includes('repos')) suites.push({ name: 'repos+issues+pulls', specs: restChecks() });
if (groups.length === 0 || groups.includes('protocol')) suites.push({ name: 'protocol', specs: restProtocolChecks() });
if (groups.length === 0 || groups.includes('graphql')) suites.push({ name: 'graphql', specs: GRAPHQL_CHECKS as any });
if (groups.length === 0 || groups.includes('mcp')) suites.push({ name: 'mcp', specs: MCP_CHECKS as any });
if (groups.length === 0 || groups.includes('git')) suites.push({ name: 'git', specs: GIT_CHECKS as any });

// Install the git adapter the GraphQL PR checks need (uses the kit's own GitClient).
configureGraphQLGit({
  async pushBranch(request) {
    const client = new GitClient({ baseUrl: BASE, token: TOKEN });
    try {
      // Find the base commit: clone nothing; look at the repo's refs via ls-refs after ensuring base exists.
      const ls = await client.lsRefs(request.owner, request.repo, {});
      const baseRef = ls.refs.find(r => r.name === `refs/heads/${request.from ?? 'main'}`);
      const baseTip = baseRef?.oid;
      // Build objects client-side: tree with one file, commit on top of baseTip.
      const { buildTree, buildCommit, hashObject, ZERO_OID } = await import(`${KIT}/git-client.ts`);
      const blob = Buffer.from(request.content, 'utf8');
      const blobOid = hashObject('blob', blob);
      const tree = buildTree([{ mode: '100644', name: request.path, oid: blobOid }]);
      const treeOid = hashObject('tree', tree);
      // For a commit with a parent, include the parent tree too? No: our tree replaces the whole root.
      // The forge accepts a tree that only holds the pushed file (it diffs per path).
      const commit = buildCommit({
        tree: treeOid,
        parents: baseTip && baseTip !== ZERO_OID ? [baseTip] : [],
        message: request.message.endsWith('\n') ? request.message : `${request.message}\n`,
        author: 'entry-forge <forge@entry.invalid>',
        timestamp: 1735689600,
      });
      const commitOid = hashObject('commit', commit);
      const { writePack } = await import(`${KIT}/git-client.ts`);
      const pack = writePack([
        { type: 'blob', data: blob },
        { type: 'tree', data: tree },
        { type: 'commit', data: commit },
      ]);
      // oldOid is the pushed ref's CURRENT value (zero for a create), not the parent commit.
      const existingTip = ls.refs.find(r => r.name === `refs/heads/${request.branch}`)?.oid;
      const result = await client.push(request.owner, request.repo, [
        { oldOid: existingTip ?? ZERO_OID, newOid: commitOid, ref: `refs/heads/${request.branch}` },
      ], { pack });
      if (!result.report) return 'no report-status';
      if (!result.report.unpackOk) return `unpack failed: ${result.report.unpackDetail}`;
      const ref = result.report.refs.find(r => r.ref === `refs/heads/${request.branch}`);
      if (!ref?.ok) return `${ref?.reason ?? 'refused'}`;
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  },
});

let passed = 0, failed = 0;
const failures: string[] = [];

for (const suite of suites) {
  console.log(`\n=== ${suite.name} (${suite.specs.length} checks) ===`);
  for (const spec of suite.specs) {
    const context = {
      baseUrl: BASE,
      token: TOKEN,
      scenario,
      signal: new AbortController().signal,
      deadlineMs: performance.now() + 60_000,
      timeoutMs: spec.timeoutMs ?? 15_000,
      log: (_m: string) => {},
    };
    const started = performance.now();
    let result: { ok: boolean; detail?: string };
    try {
      result = await spec.fn(context as any);
    } catch (e) {
      result = { ok: false, detail: (e as Error).message };
    }
    const ms = Math.round(performance.now() - started);
    if (result.ok) {
      passed += 1;
      console.log(`  PASS ${spec.id} (${ms}ms)`);
    } else {
      failed += 1;
      const detail = (result.detail ?? '').slice(0, 300);
      failures.push(`${spec.id}: ${detail}`);
      console.log(`  FAIL ${spec.id} (${ms}ms): ${detail}`);
    }
  }
}

console.log(`\n==== TOTAL: ${passed} passed, ${failed} failed (${Math.round((passed / (passed + failed)) * 100)}%) ====`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
