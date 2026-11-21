// Run the kit's real conformance suite against the local forge.
// Usage: node --experimental-strip-types run-kit-suite.ts [group...]

const kitSource = '/Users/devin/makefun/kit-ghclone/github-core-clone-01-kit/program/env/src';
const forgeOrigin = process.env.FORGE_URL ?? 'http://localhost:41234';
const bearerToken = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';

const { buildScenario } = await import(`${kitSource}/wire.ts`);
const { restChecks, restProtocolChecks } = await import(`${kitSource}/checks-rest.ts`);
const { GRAPHQL_CHECKS, configureGraphQLGit } = await import(`${kitSource}/checks-graphql.ts`);
const { MCP_CHECKS } = await import(`${kitSource}/checks-mcp.ts`);
const { GIT_CHECKS } = await import(`${kitSource}/checks-git.ts`);
const { GitClient } = await import(`${kitSource}/git-client.ts`);

const builtScenario = buildScenario();
const selectedGroups = process.argv.slice(2);

const allSuites: Array<{ name: string; specs: ReturnType<typeof restChecks> }> = [];
if (selectedGroups.length === 0 || selectedGroups.includes('repos')) allSuites.push({ name: 'repos+issues+pulls', specs: restChecks() });
if (selectedGroups.length === 0 || selectedGroups.includes('protocol')) allSuites.push({ name: 'protocol', specs: restProtocolChecks() });
if (selectedGroups.length === 0 || selectedGroups.includes('graphql')) allSuites.push({ name: 'graphql', specs: GRAPHQL_CHECKS as any });
if (selectedGroups.length === 0 || selectedGroups.includes('mcp')) allSuites.push({ name: 'mcp', specs: MCP_CHECKS as any });
if (selectedGroups.length === 0 || selectedGroups.includes('git')) allSuites.push({ name: 'git', specs: GIT_CHECKS as any });

// GraphQL PR checks need a branch push; supply one that builds the objects with the kit's helpers.
configureGraphQLGit({
  async pushBranch(req) {
    const transport = new GitClient({ baseUrl: forgeOrigin, token: bearerToken });
    try {
      const listing = await transport.lsRefs(req.owner, req.repo, {});
      const baseRef = listing.refs.find(r => r.name === `refs/heads/${req.from ?? 'main'}`);
      const parent = baseRef?.oid;
      const { buildTree, buildCommit, hashObject, ZERO_OID } = await import(`${kitSource}/git-client.ts`);
      const fileBytes = Buffer.from(req.content, 'utf8');
      const blobId = hashObject('blob', fileBytes);
      const treeBytes = buildTree([{ mode: '100644', name: req.path, oid: blobId }]);
      const treeId = hashObject('tree', treeBytes);
      // The root tree contains just the pushed file; the forge diffs per path.
      const commitBytes = buildCommit({
        tree: treeId,
        parents: parent && parent !== ZERO_OID ? [parent] : [],
        message: req.message.endsWith('\n') ? req.message : `${req.message}\n`,
        author: 'entry-forge <forge@entry.invalid>',
        timestamp: 1735689600,
      });
      const commitId = hashObject('commit', commitBytes);
      const { writePack } = await import(`${kitSource}/git-client.ts`);
      const packed = writePack([
        { type: 'blob', data: fileBytes },
        { type: 'tree', data: treeBytes },
        { type: 'commit', data: commitBytes },
      ]);
      // The ref's old value is its current tip (zero when creating), not the commit's parent.
      const oldTip = listing.refs.find(r => r.name === `refs/heads/${req.branch}`)?.oid;
      const pushed = await transport.push(req.owner, req.repo, [
        { oldOid: oldTip ?? ZERO_OID, newOid: commitId, ref: `refs/heads/${req.branch}` },
      ], { pack: packed });
      if (!pushed.report) return 'no report-status';
      if (!pushed.report.unpackOk) return `unpack failed: ${pushed.report.unpackDetail}`;
      const pushedRef = pushed.report.refs.find(r => r.ref === `refs/heads/${req.branch}`);
      if (!pushedRef?.ok) return `${pushedRef?.reason ?? 'refused'}`;
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  },
});

let successes = 0, failures = 0;
const failureLog: string[] = [];

for (const suite of allSuites) {
  console.log(`\n=== ${suite.name} (${suite.specs.length} checks) ===`);
  for (const spec of suite.specs) {
    const checkContext = {
      baseUrl: forgeOrigin,
      token: bearerToken,
      scenario: builtScenario,
      signal: new AbortController().signal,
      deadlineMs: performance.now() + 60_000,
      timeoutMs: spec.timeoutMs ?? 15_000,
      log: (_message: string) => {},
    };
    const began = performance.now();
    let verdict: { ok: boolean; detail?: string };
    try {
      verdict = await spec.fn(checkContext as any);
    } catch (error) {
      verdict = { ok: false, detail: (error as Error).message };
    }
    const elapsed = Math.round(performance.now() - began);
    if (verdict.ok) {
      successes += 1;
      console.log(`  PASS ${spec.id} (${elapsed}ms)`);
    } else {
      failures += 1;
      const detail = (verdict.detail ?? '').slice(0, 300);
      failureLog.push(`${spec.id}: ${detail}`);
      console.log(`  FAIL ${spec.id} (${elapsed}ms): ${detail}`);
    }
  }
}

console.log(`\n==== TOTAL: ${successes} passed, ${failures} failed (${Math.round((successes / (successes + failures)) * 100)}%) ====`);
if (failureLog.length) {
  console.log('\nFailures:');
  for (const entry of failureLog) console.log(`  - ${entry}`);
}
process.exit(failures > 0 ? 1 : 0);
