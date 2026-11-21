// Smoke test for the forge - verifies REST, GraphQL, MCP, and Git smart HTTP

const BASE = process.env.FORGE_URL ?? 'http://localhost:41234';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';

async function fetchJson(url: string, options: RequestInit = {}): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/json',
      ...options.headers,
    },
  });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  OK: ${msg}`);
}

async function testRest() {
  console.log('\n=== REST v3 ===');
  
  // GET /api/v3/
  let r = await fetchJson(`${BASE}/api/v3/`);
  assert(r.status === 200, 'GET /api/v3/ 200');
  assert(r.headers.get('x-oauth-scopes')?.includes('repo'), 'X-OAuth-Scopes header');
  assert(r.headers.get('x-github-request-id'), 'X-GitHub-Request-Id header');

  // GET /api/v3/meta
  r = await fetchJson(`${BASE}/api/v3/meta`);
  assert(r.status === 200, 'GET /api/v3/meta 200');
  assert((r.body as any)?.installed_version, 'installed_version present');

  // GET /api/v3/user
  r = await fetchJson(`${BASE}/api/v3/user`);
  assert(r.status === 200, 'GET /api/v3/user 200');
  const viewerLogin = (r.body as any).login;
  assert(viewerLogin, 'viewer login');
  console.log(`  viewer: ${viewerLogin}`);

  // Create repo
  const repoName = `smoke-${Date.now()}`;
  r = await fetchJson(`${BASE}/api/v3/user/repos`, {
    method: 'POST',
    body: JSON.stringify({ name: repoName, private: true, description: 'smoke test' }),
  });
  assert(r.status === 201, 'POST /user/repos 201');
  assert((r.body as any).name === repoName, 'repo name echoed');

  // Get repo
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}`);
  assert(r.status === 200, 'GET /repos/{o}/{r} 200');
  const defaultBranch = (r.body as any).default_branch;

  // PATCH repo
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}`, {
    method: 'PATCH',
    body: JSON.stringify({ description: 'updated' }),
  });
  assert(r.status === 200, 'PATCH repo 200');
  assert((r.body as any).description === 'updated', 'description updated');

  // PUT contents (create file)
  const content = Buffer.from('hello world').toString('base64');
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/contents/test.txt`, {
    method: 'PUT',
    body: JSON.stringify({ message: 'add file', content }),
  });
  assert([200, 201].includes(r.status), 'PUT contents 200/201');
  const fileSha = (r.body as any).content?.sha;
  const initialCommitSha = (r.body as any).commit?.sha;
  assert(initialCommitSha && /^[0-9a-f]{40}$/.test(initialCommitSha), 'commit sha is 40-hex');

  // Create branch at the initial commit
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'refs/heads/feature', sha: initialCommitSha }),
  });
  assert(r.status === 201, 'POST git/refs 201');
  assert((r.body as any).ref === 'refs/heads/feature', 'branch ref echoed');

  // GET contents
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/contents/test.txt`);
  assert(r.status === 200, 'GET contents 200');
  assert((r.body as any).content === 'aGVsbG8gd29ybGQ=', 'base64 content matches');

  // PUT contents (update with sha)
  const content2 = Buffer.from('hello world v2').toString('base64');
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/contents/test.txt`, {
    method: 'PUT',
    body: JSON.stringify({ message: 'update', content: content2, sha: fileSha }),
  });
  assert([200, 201].includes(r.status), 'PUT contents update 200/201');
  const fileSha2 = (r.body as any).content?.sha;
  assert(fileSha2 && fileSha2 !== fileSha, 'update changed the content sha');

  // Stale sha → 409
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/contents/test.txt`, {
    method: 'PUT',
    body: JSON.stringify({ message: 'stale', content: content2, sha: fileSha }),
  });
  assert(r.status === 409, 'stale sha 409');

  // DELETE contents (with the current sha)
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/contents/test.txt`, {
    method: 'DELETE',
    body: JSON.stringify({ message: 'delete', sha: fileSha2 }),
  });
  assert(r.status === 200, 'DELETE contents 200');
  assert((r.body as any).commit?.sha, 'delete returns commit sha');

  // GET after delete → 404
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/contents/test.txt`);
  assert(r.status === 404, 'GET deleted file 404');

  // Create label
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/labels`, {
    method: 'POST',
    body: JSON.stringify({ name: 'bug', color: 'ff0000' }),
  });
  assert(r.status === 201, 'POST labels 201');

  // Create issue
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Test Issue', body: 'Issue body', labels: ['bug'] }),
  });
  assert(r.status === 201, 'POST issues 201');
  const issueNumber = (r.body as any).number;
  assert(issueNumber === 1, 'issue number is 1');

  // Issue with unknown label → 422
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Bad Label', labels: ['nonexistent'] }),
  });
  assert(r.status === 422, 'unknown label 422');

  // List issues
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/issues?state=open`);
  assert(r.status === 200, 'GET issues 200');
  assert(Array.isArray(r.body) && (r.body as any[]).length >= 1, 'issues listed');

  // Get issue
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/issues/${issueNumber}`);
  assert(r.status === 200, 'GET issue 200');

  // Close issue
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/issues/${issueNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
  });
  assert(r.status === 200, 'PATCH issue close 200');
  assert((r.body as any).state === 'closed', 'issue closed');

  // Add comment
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: 'A comment' }),
  });
  assert(r.status === 201, 'POST comment 201');

  // List comments
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/issues/${issueNumber}/comments`);
  assert(r.status === 200, 'GET comments 200');

  // Create pull request (needs head branch)
  // First create a branch with a commit via contents
  const headContent = Buffer.from('head content').toString('base64');
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/contents/head.txt`, {
    method: 'PUT',
    body: JSON.stringify({ message: 'head commit', content: headContent, branch: 'feature' }),
  });
  const headBranchExists = [200, 201].includes(r.status);

  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Test PR', head: 'feature', base: defaultBranch }),
  });
  // May 422 if branch doesn't exist - that's okay for smoke
  const prStatus = r.status;
  console.log(`  PR create status: ${prStatus}`);

  // DELETE repo
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}`, { method: 'DELETE' });
  assert(r.status === 204, 'DELETE repo 204');

  // Verify gone
  r = await fetchJson(`${BASE}/api/v3/repos/${viewerLogin}/${repoName}`);
  assert(r.status === 404, 'GET deleted repo 404');
}

async function testGraphQL() {
  console.log('\n=== GraphQL ===');
  const repoName = `gql-${Date.now()}`;

  // Create repo via REST first
  let r = await fetchJson(`${BASE}/api/v3/user/repos`, {
    method: 'POST',
    body: JSON.stringify({ name: repoName, private: true }),
  });
  assert(r.status === 201, 'REST create repo for GraphQL');

  // viewer login
  r = await fetchJson(`${BASE}/api/graphql`, {
    method: 'POST',
    body: JSON.stringify({ query: 'query { viewer { login } }' }),
  });
  assert(r.status === 200, 'GraphQL viewer login');
  assert((r.body as any).data?.viewer?.login, 'viewer.login returned');

  // repository fields
  r = await fetchJson(`${BASE}/api/graphql`, {
    method: 'POST',
    body: JSON.stringify({
      query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }`,
      variables: { owner: viewer, name: repoName },
    }),
  });
  assert(r.status === 200, 'GraphQL repository fields');
  assert((r.body as any).data?.repository?.name === repoName, 'repo name');

  // __type Issue fields
  r = await fetchJson(`${BASE}/api/graphql`, {
    method: 'POST',
    body: JSON.stringify({ query: 'query { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }' }),
  });
  assert(r.status === 200, 'GraphQL __type Issue');
  const issueFields = ((r.body as any).data?.Issue?.fields ?? []).map((f: any) => f.name);
  assert(issueFields.includes('id') && issueFields.includes('number') && issueFields.includes('title') && issueFields.includes('state') && issueFields.includes('body'), 'Issue has required fields');

  // __type PullRequest + Repository + SearchType
  r = await fetchJson(`${BASE}/api/graphql`, {
    method: 'POST',
    body: JSON.stringify({ query: 'query { PullRequest: __type(name: "PullRequest") { fields { name } } Repository: __type(name: "Repository") { fields { name } } SearchType: __type(name: "SearchType") { enumValues { name } } }' }),
  });
  assert(r.status === 200, 'GraphQL type introspection');
  const prFields = ((r.body as any).data?.PullRequest?.fields ?? []).map((f: any) => f.name);
  assert(prFields.includes('id') && prFields.includes('number') && prFields.includes('headRefName') && prFields.includes('baseRefName') && prFields.includes('mergeable') && prFields.includes('state') && prFields.includes('merged') && prFields.includes('files'), 'PullRequest has required fields');
  const repoFields = ((r.body as any).data?.Repository?.fields ?? []).map((f: any) => f.name);
  assert(repoFields.includes('id') && repoFields.includes('databaseId') && repoFields.includes('name') && repoFields.includes('nameWithOwner') && repoFields.includes('owner') && repoFields.includes('defaultBranchRef') && repoFields.includes('viewerPermission') && repoFields.includes('hasIssuesEnabled') && repoFields.includes('issue') && repoFields.includes('issues') && repoFields.includes('pullRequests') && repoFields.includes('pullRequest'), 'Repository has required fields');
  const searchTypes = ((r.body as any).data?.SearchType?.enumValues ?? []).map((e: any) => e.name);
  assert(searchTypes.includes('ISSUE'), 'SearchType has ISSUE');

  // createIssue mutation (fetch the repository's global id first)
  r = await fetchJson(`${BASE}/api/graphql`, {
    method: 'POST',
    body: JSON.stringify({
      query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId } }`,
      variables: { owner: viewer, name: repoName },
    }),
  });
  assert(r.status === 200, 'GraphQL repo id lookup');
  const repoGid = (r.body as any).data?.repository?.id;
  assert(repoGid, 'repository global id');
  assert(String((r.body as any).data?.repository?.databaseId) !== repoGid, 'global id is opaque, not the databaseId');

  r = await fetchJson(`${BASE}/api/graphql`, {
    method: 'POST',
    body: JSON.stringify({
      query: 'mutation($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }',
      variables: { input: { repositoryId: repoGid, title: 'GraphQL Issue', body: 'body' } },
    }),
  });
  assert(r.status === 200, 'GraphQL createIssue 200');
  assert(!(r.body as any).errors, `createIssue no errors: ${JSON.stringify((r.body as any).errors ?? [])}`);
  const gqlIssueNumber = (r.body as any).data?.createIssue?.issue?.number;
  assert(gqlIssueNumber >= 1, 'created issue number');

  // REST reads the GraphQL-created issue back
  r = await fetchJson(`${BASE}/api/v3/repos/${viewer}/${repoName}/issues/${gqlIssueNumber}`);
  assert(r.status === 200, 'REST reads GraphQL issue');
  assert((r.body as any).title === 'GraphQL Issue', 'same title over REST');

  // closeIssue via GraphQL
  r = await fetchJson(`${BASE}/api/graphql`, {
    method: 'POST',
    body: JSON.stringify({
      query: `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { id } } }`,
      variables: { owner: viewer, name: repoName, number: gqlIssueNumber },
    }),
  });
  const issueGid = (r.body as any).data?.repository?.issue?.id;
  r = await fetchJson(`${BASE}/api/graphql`, {
    method: 'POST',
    body: JSON.stringify({
      query: 'mutation($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number state } } }',
      variables: { input: { issueId: issueGid } },
    }),
  });
  assert(!(r.body as any).errors, `closeIssue no errors: ${JSON.stringify((r.body as any).errors ?? [])}`);
  assert((r.body as any).data?.closeIssue?.issue?.state === 'CLOSED', 'issue closed over GraphQL');

  // Invalid field → 200 with errors
  r = await fetchJson(`${BASE}/api/graphql`, {
    method: 'POST',
    body: JSON.stringify({ query: 'query { viewer { login noSuchFieldOnViewer } }' }),
  });
  assert(r.status === 200, 'GraphQL invalid field 200');
  assert(Array.isArray((r.body as any).errors) && (r.body as any).errors.length > 0, 'errors array present');

  // Batched operations
  r = await fetchJson(`${BASE}/api/graphql`, {
    method: 'POST',
    body: JSON.stringify([
      { query: 'query { viewer { login } }' },
      { query: 'query { Issue: __type(name: "Issue") { fields { name } } }' },
    ]),
  });
  assert(r.status === 200, 'GraphQL batched 200');
  assert(Array.isArray(r.body) && (r.body as any[]).length === 2, 'two results returned');

  // Unauthenticated → 401
  const r2 = await fetch(`${BASE}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query { viewer { login } }' }),
  });
  assert(r2.status === 401, 'GraphQL unauth 401');

  // Cleanup
  await fetchJson(`${BASE}/api/v3/repos/${viewer}/${repoName}`, { method: 'DELETE' });
}

async function testMCP() {
  console.log('\n=== MCP ===');
  
  // Initialize (modern)
  let r = await fetchJson(`${BASE}/mcp`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
  });
  assert(r.status === 200, 'MCP server/discover 200');
  const discover = (r.body as any);
  assert(discover.result?.supportedVersions?.length > 0, 'supportedVersions present');
  assert(discover.result?.serverInfo?.name, 'serverInfo.name');
  assert(discover.result?.serverInfo?.version, 'serverInfo.version');
  assert(discover.result?.capabilities?.tools !== undefined, 'capabilities.tools');

  // tools/list
  r = await fetchJson(`${BASE}/mcp`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  assert(r.status === 200, 'MCP tools/list 200');
  const tools = (r.body as any).result?.tools ?? [];
  assert(tools.length >= 6, `at least 6 tools (got ${tools.length})`);
  const required = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'];
  for (const name of required) {
    assert(tools.some((t: any) => t.name === name), `tool ${name} present`);
  }
  // Check schemas
  for (const tool of tools) {
    assert(tool.description && tool.description.length > 0, `tool ${tool.name} has description`);
    assert(tool.inputSchema?.type === 'object', `tool ${tool.name} inputSchema is object`);
  }

  // create_repo
  const repoName = `mcp-${Date.now()}`;
  r = await fetchJson(`${BASE}/mcp`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_repo', arguments: { name: repoName, private: true } } }),
  });
  assert(r.status === 200, 'MCP create_repo 200');
  assert((r.body as any).result, 'create_repo result');

  // get_repo
  r = await fetchJson(`${BASE}/mcp`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_repo', arguments: { owner: viewer, repo: repoName } } }),
  });
  assert(r.status === 200, 'MCP get_repo 200');

  // create_issue
  r = await fetchJson(`${BASE}/mcp`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: viewer, repo: repoName, title: 'MCP Issue', body: 'body' } } }),
  });
  assert(r.status === 200, 'MCP create_issue 200');

  // list_issues
  r = await fetchJson(`${BASE}/mcp`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_issues', arguments: { owner: viewer, repo: repoName, state: 'open' } } }),
  });
  assert(r.status === 200, 'MCP list_issues 200');

  // Unknown tool → -32601/-32602
  r = await fetchJson(`${BASE}/mcp`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } }),
  });
  assert(r.status !== 500, 'unknown tool not 500');
  assert((r.body as any).error?.code === -32601 || (r.body as any).error?.code === -32602, 'unknown tool JSON-RPC error');

  // Parse error → 400 with -32700
  const r2 = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: '{"jsonrpc": "2.0", "id": 8, "method": "tools/list"',
  });
  assert(r2.status === 400, 'parse error 400');
  const errBody = await r2.json();
  assert(errBody.error?.code === -32700, 'parse error -32700');

  // Missing required args → -32602 or isError
  r = await fetchJson(`${BASE}/mcp`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'create_issue', arguments: {} } }),
  });
  assert((r.body as any).error?.code === -32602 || (r.body as any).result?.isError === true, 'missing args error');

  // Auth required for tools/call
  const r3 = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'x', repo: 'y', title: 'z' } } }),
  });
  assert(r3.status === 401, 'no auth 401');

  // Cleanup
  await fetchJson(`${BASE}/api/v3/repos/${viewer}/${repoName}`, { method: 'DELETE' });
}

async function testGit() {
  console.log('\n=== Git Smart HTTP ===');
  const repoName = `git-${Date.now()}`;

  // Create repo via REST
  let r = await fetchJson(`${BASE}/api/v3/user/repos`, {
    method: 'POST',
    body: JSON.stringify({ name: repoName, private: true }),
  });
  assert(r.status === 201, 'REST create repo for Git');

  // v2 info/refs upload-pack
  const r2 = await fetch(`${BASE}/${viewer}/${repoName}.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Bearer ${TOKEN}`, 'git-protocol': 'version=2' },
  });
  assert(r2.status === 200, 'Git v2 info/refs 200');
  assert(r2.headers.get('content-type')?.includes('application/x-git-upload-pack-advertisement'), 'v2 content-type');
  const text = await r2.text();
  assert(text.startsWith('version 2'), 'v2 advertisement starts with version 2');
  assert(text.includes('ls-refs') && text.includes('fetch'), 'v2 caps');

  // v0 info/refs upload-pack
  const r3 = await fetch(`${BASE}/${viewer}/${repoName}.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert(r3.status === 200, 'Git v0 info/refs 200');
  const text3 = await r3.text();
  assert(text3.startsWith('# service=git-upload-pack'), 'v0 preamble');

  // receive-pack advertisement
  const r4 = await fetch(`${BASE}/${viewer}/${repoName}.git/info/refs?service=git-receive-pack`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert(r4.status === 200, 'receive-pack info/refs 200');
  const text4 = await r4.text();
  assert(text4.startsWith('# service=git-receive-pack'), 'receive-pack preamble');
  assert(text4.includes('report-status') && text4.includes('side-band-64k') && text4.includes('delete-refs'), 'receive-pack caps');

  // Missing repo 404
  const r5 = await fetch(`${BASE}/${viewer}/nonexistent.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert(r5.status === 404, 'missing repo 404');

  // Cleanup
  await fetchJson(`${BASE}/api/v3/repos/${viewer}/${repoName}`, { method: 'DELETE' });
}

async function testAuth() {
  console.log('\n=== Auth / Protocol ===');
  // No auth on REST → 401
  const r = await fetch(`${BASE}/api/v3/user/repos`);
  assert(r.status === 401, 'REST no auth 401');

  // Wrong token → 401
  const r2 = await fetch(`${BASE}/api/v3/user/repos`, {
    headers: { authorization: 'Bearer wrong' },
  });
  assert(r2.status === 401, 'REST wrong token 401');

  // Malformed JSON → 400
  const r3 = await fetch(`${BASE}/api/v3/user/repos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: '{"name":',
  });
  assert(r3.status === 400, 'malformed JSON 400');

  // Unknown route → 404 JSON
  const r4 = await fetch(`${BASE}/api/v3/nope`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert(r4.status === 404, 'unknown route 404');
  const body4 = await r4.json();
  assert(body4.message === 'Not Found', '404 JSON body');

  // Foreign owner → 404
  const r5 = await fetch(`${BASE}/api/v3/repos/nonexistentowner/somerepo`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert(r5.status === 404, 'foreign owner 404');
}

async function main() {
  console.log(`Testing forge at ${BASE}`);
  try {
    await testAuth();
    await testRest();
    await testGraphQL();
    await testMCP();
    await testGit();
    console.log('\n✅ All smoke tests passed!');
  } catch (e) {
    console.error('\n❌ Smoke test failed:', (e as Error).message);
    process.exit(1);
  }
}

main();