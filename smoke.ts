// End-to-end smoke coverage across REST v3, GraphQL v4, MCP and the Git smart-HTTP protocol.

const forgeUrl = process.env.FORGE_URL ?? 'http://localhost:41234';
const secretToken = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';

type Reply = { status: number; body: unknown; headers: Headers };

async function jsonCall(url: string, options: RequestInit = {}): Promise<Reply> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secretToken}`,
      accept: 'application/json',
      ...options.headers,
    },
  });
  const raw = await response.text();
  let body: unknown;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  return { status: response.status, body, headers: response.headers };
}

function verify(condition: boolean, label: string): void {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  OK: ${label}`);
}

let currentViewer = 'adaiversen';

async function checkProtocolAndAuth() {
  console.log('\n=== Auth / Protocol ===');
  const missingHeader = await fetch(`${forgeUrl}/api/v3/user/repos`);
  verify(missingHeader.status === 401, 'REST no auth 401');

  const badCredential = await fetch(`${forgeUrl}/api/v3/user/repos`, {
    headers: { authorization: 'Bearer wrong' },
  });
  verify(badCredential.status === 401, 'REST wrong token 401');

  const brokenJson = await fetch(`${forgeUrl}/api/v3/user/repos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secretToken}` },
    body: '{"name":',
  });
  verify(brokenJson.status === 400, 'malformed JSON 400');

  const unknown = await fetch(`${forgeUrl}/api/v3/nope`, {
    headers: { authorization: `Bearer ${secretToken}` },
  });
  verify(unknown.status === 404, 'unknown route 404');
  const unknownBody = await unknown.json();
  verify(unknownBody.message === 'Not Found', '404 JSON body');

  const foreign = await fetch(`${forgeUrl}/api/v3/repos/nonexistentowner/somerepo`, {
    headers: { authorization: `Bearer ${secretToken}` },
  });
  verify(foreign.status === 404, 'foreign owner 404');
}

async function checkRestApi() {
  console.log('\n=== REST v3 ===');

  let reply = await jsonCall(`${forgeUrl}/api/v3/`);
  verify(reply.status === 200, 'GET /api/v3/ 200');
  verify(reply.headers.get('x-oauth-scopes')?.includes('repo'), 'X-OAuth-Scopes header');
  verify(reply.headers.get('x-github-request-id'), 'X-GitHub-Request-Id header');

  reply = await jsonCall(`${forgeUrl}/api/v3/meta`);
  verify(reply.status === 200, 'GET /api/v3/meta 200');
  verify((reply.body as any)?.installed_version, 'installed_version present');

  reply = await jsonCall(`${forgeUrl}/api/v3/user`);
  verify(reply.status === 200, 'GET /api/v3/user 200');
  const login = (reply.body as any).login;
  verify(login, 'viewer login');
  currentViewer = login;
  console.log(`  viewer: ${login}`);

  const repoName = `smoke-${Date.now()}`;
  reply = await jsonCall(`${forgeUrl}/api/v3/user/repos`, {
    method: 'POST',
    body: JSON.stringify({ name: repoName, private: true, description: 'smoke test' }),
  });
  verify(reply.status === 201, 'POST /user/repos 201');
  verify((reply.body as any).name === repoName, 'repo name echoed');

  const repoBase = `${forgeUrl}/api/v3/repos/${login}/${repoName}`;
  reply = await jsonCall(repoBase);
  verify(reply.status === 200, 'GET /repos/{o}/{r} 200');
  const defaultBranch = (reply.body as any).default_branch;

  reply = await jsonCall(repoBase, {
    method: 'PATCH',
    body: JSON.stringify({ description: 'updated' }),
  });
  verify(reply.status === 200, 'PATCH repo 200');
  verify((reply.body as any).description === 'updated', 'description updated');

  const initialContent = Buffer.from('hello world').toString('base64');
  reply = await jsonCall(`${repoBase}/contents/test.txt`, {
    method: 'PUT',
    body: JSON.stringify({ message: 'add file', content: initialContent }),
  });
  verify([200, 201].includes(reply.status), 'PUT contents 200/201');
  const firstBlobSha = (reply.body as any).content?.sha;
  const firstCommitSha = (reply.body as any).commit?.sha;
  verify(firstCommitSha && /^[0-9a-f]{40}$/.test(firstCommitSha), 'commit sha is 40-hex');

  reply = await jsonCall(`${repoBase}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'refs/heads/feature', sha: firstCommitSha }),
  });
  verify(reply.status === 201, 'POST git/refs 201');
  verify((reply.body as any).ref === 'refs/heads/feature', 'branch ref echoed');

  reply = await jsonCall(`${repoBase}/contents/test.txt`);
  verify(reply.status === 200, 'GET contents 200');
  verify((reply.body as any).content === 'aGVsbG8gd29ybGQ=', 'base64 content matches');

  const updatedContent = Buffer.from('hello world v2').toString('base64');
  reply = await jsonCall(`${repoBase}/contents/test.txt`, {
    method: 'PUT',
    body: JSON.stringify({ message: 'update', content: updatedContent, sha: firstBlobSha }),
  });
  verify([200, 201].includes(reply.status), 'PUT contents update 200/201');
  const secondBlobSha = (reply.body as any).content?.sha;
  verify(secondBlobSha && secondBlobSha !== firstBlobSha, 'update changed the content sha');

  reply = await jsonCall(`${repoBase}/contents/test.txt`, {
    method: 'PUT',
    body: JSON.stringify({ message: 'stale', content: updatedContent, sha: firstBlobSha }),
  });
  verify(reply.status === 409, 'stale sha 409');

  reply = await jsonCall(`${repoBase}/contents/test.txt`, {
    method: 'DELETE',
    body: JSON.stringify({ message: 'delete', sha: secondBlobSha }),
  });
  verify(reply.status === 200, 'DELETE contents 200');
  verify((reply.body as any).commit?.sha, 'delete returns commit sha');

  reply = await jsonCall(`${repoBase}/contents/test.txt`);
  verify(reply.status === 404, 'GET deleted file 404');

  reply = await jsonCall(`${repoBase}/labels`, {
    method: 'POST',
    body: JSON.stringify({ name: 'bug', color: 'ff0000' }),
  });
  verify(reply.status === 201, 'POST labels 201');

  reply = await jsonCall(`${repoBase}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Test Issue', body: 'Issue body', labels: ['bug'] }),
  });
  verify(reply.status === 201, 'POST issues 201');
  const issueNumber = (reply.body as any).number;
  verify(issueNumber === 1, 'issue number is 1');

  reply = await jsonCall(`${repoBase}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Bad Label', labels: ['nonexistent'] }),
  });
  verify(reply.status === 422, 'unknown label 422');

  reply = await jsonCall(`${repoBase}/issues?state=open`);
  verify(reply.status === 200, 'GET issues 200');
  verify(Array.isArray(reply.body) && (reply.body as any[]).length >= 1, 'issues listed');

  reply = await jsonCall(`${repoBase}/issues/${issueNumber}`);
  verify(reply.status === 200, 'GET issue 200');

  reply = await jsonCall(`${repoBase}/issues/${issueNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
  });
  verify(reply.status === 200, 'PATCH issue close 200');
  verify((reply.body as any).state === 'closed', 'issue closed');

  reply = await jsonCall(`${repoBase}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: 'A comment' }),
  });
  verify(reply.status === 201, 'POST comment 201');

  reply = await jsonCall(`${repoBase}/issues/${issueNumber}/comments`);
  verify(reply.status === 200, 'GET comments 200');

  const headContent = Buffer.from('head content').toString('base64');
  await jsonCall(`${repoBase}/contents/head.txt`, {
    method: 'PUT',
    body: JSON.stringify({ message: 'head commit', content: headContent, branch: 'feature' }),
  });

  reply = await jsonCall(`${repoBase}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Test PR', head: 'feature', base: defaultBranch }),
  });
  console.log(`  PR create status: ${reply.status}`);

  reply = await jsonCall(repoBase, { method: 'DELETE' });
  verify(reply.status === 204, 'DELETE repo 204');

  reply = await jsonCall(repoBase);
  verify(reply.status === 404, 'GET deleted repo 404');
}

async function checkGraphQL() {
  console.log('\n=== GraphQL ===');
  const repoName = `gql-${Date.now()}`;

  let reply = await jsonCall(`${forgeUrl}/api/v3/user/repos`, {
    method: 'POST',
    body: JSON.stringify({ name: repoName, private: true }),
  });
  verify(reply.status === 201, 'REST create repo for GraphQL');

  const gqlEndpoint = `${forgeUrl}/api/graphql`;
  reply = await jsonCall(gqlEndpoint, {
    method: 'POST',
    body: JSON.stringify({ query: 'query { viewer { login } }' }),
  });
  verify(reply.status === 200, 'GraphQL VIEWER login');
  verify((reply.body as any).data?.viewer?.login, 'VIEWER.login returned');

  reply = await jsonCall(gqlEndpoint, {
    method: 'POST',
    body: JSON.stringify({
      query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }`,
      variables: { owner: currentViewer, name: repoName },
    }),
  });
  verify(reply.status === 200, 'GraphQL repository fields');
  verify((reply.body as any).data?.repository?.name === repoName, 'repo name');

  reply = await jsonCall(gqlEndpoint, {
    method: 'POST',
    body: JSON.stringify({ query: 'query { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }' }),
  });
  verify(reply.status === 200, 'GraphQL __type Issue');
  const issueFieldNames = ((reply.body as any).data?.Issue?.fields ?? []).map((field: any) => field.name);
  verify(issueFieldNames.includes('id') && issueFieldNames.includes('number') && issueFieldNames.includes('title') && issueFieldNames.includes('state') && issueFieldNames.includes('body'), 'Issue has required fields');

  reply = await jsonCall(gqlEndpoint, {
    method: 'POST',
    body: JSON.stringify({ query: 'query { PullRequest: __type(name: "PullRequest") { fields { name } } Repository: __type(name: "Repository") { fields { name } } SearchType: __type(name: "SearchType") { enumValues { name } } }' }),
  });
  verify(reply.status === 200, 'GraphQL type introspection');
  const pullFieldNames = ((reply.body as any).data?.PullRequest?.fields ?? []).map((field: any) => field.name);
  verify(pullFieldNames.includes('id') && pullFieldNames.includes('number') && pullFieldNames.includes('headRefName') && pullFieldNames.includes('baseRefName') && pullFieldNames.includes('mergeable') && pullFieldNames.includes('state') && pullFieldNames.includes('merged') && pullFieldNames.includes('files'), 'PullRequest has required fields');
  const repoFieldNames = ((reply.body as any).data?.Repository?.fields ?? []).map((field: any) => field.name);
  verify(repoFieldNames.includes('id') && repoFieldNames.includes('databaseId') && repoFieldNames.includes('name') && repoFieldNames.includes('nameWithOwner') && repoFieldNames.includes('owner') && repoFieldNames.includes('defaultBranchRef') && repoFieldNames.includes('viewerPermission') && repoFieldNames.includes('hasIssuesEnabled') && repoFieldNames.includes('issue') && repoFieldNames.includes('issues') && repoFieldNames.includes('pullRequests') && repoFieldNames.includes('pullRequest'), 'Repository has required fields');
  const searchEnumNames = ((reply.body as any).data?.SearchType?.enumValues ?? []).map((entry: any) => entry.name);
  verify(searchEnumNames.includes('ISSUE'), 'SearchType has ISSUE');

  reply = await jsonCall(gqlEndpoint, {
    method: 'POST',
    body: JSON.stringify({
      query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId } }`,
      variables: { owner: currentViewer, name: repoName },
    }),
  });
  verify(reply.status === 200, 'GraphQL repo id lookup');
  const repositoryGid = (reply.body as any).data?.repository?.id;
  verify(repositoryGid, 'repository global id');
  verify(String((reply.body as any).data?.repository?.databaseId) !== repositoryGid, 'global id is opaque, not the databaseId');

  reply = await jsonCall(gqlEndpoint, {
    method: 'POST',
    body: JSON.stringify({
      query: 'mutation($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }',
      variables: { input: { repositoryId: repositoryGid, title: 'GraphQL Issue', body: 'body' } },
    }),
  });
  verify(reply.status === 200, 'GraphQL createIssue 200');
  verify(!(reply.body as any).errors, `createIssue no errors: ${JSON.stringify((reply.body as any).errors ?? [])}`);
  const graphIssueNumber = (reply.body as any).data?.createIssue?.issue?.number;
  verify(graphIssueNumber >= 1, 'created issue number');

  reply = await jsonCall(`${forgeUrl}/api/v3/repos/${currentViewer}/${repoName}/issues/${graphIssueNumber}`);
  verify(reply.status === 200, 'REST reads GraphQL issue');
  verify((reply.body as any).title === 'GraphQL Issue', 'same title over REST');

  reply = await jsonCall(gqlEndpoint, {
    method: 'POST',
    body: JSON.stringify({
      query: `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { id } } }`,
      variables: { owner: currentViewer, name: repoName, number: graphIssueNumber },
    }),
  });
  const issueGid = (reply.body as any).data?.repository?.issue?.id;
  reply = await jsonCall(gqlEndpoint, {
    method: 'POST',
    body: JSON.stringify({
      query: 'mutation($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number state } } }',
      variables: { input: { issueId: issueGid } },
    }),
  });
  verify(!(reply.body as any).errors, `closeIssue no errors: ${JSON.stringify((reply.body as any).errors ?? [])}`);
  verify((reply.body as any).data?.closeIssue?.issue?.state === 'CLOSED', 'issue closed over GraphQL');

  reply = await jsonCall(gqlEndpoint, {
    method: 'POST',
    body: JSON.stringify({ query: 'query { viewer { login noSuchFieldOnViewer } }' }),
  });
  verify(reply.status === 200, 'GraphQL invalid field 200');
  verify(Array.isArray((reply.body as any).errors) && (reply.body as any).errors.length > 0, 'errors array present');

  reply = await jsonCall(gqlEndpoint, {
    method: 'POST',
    body: JSON.stringify([
      { query: 'query { viewer { login } }' },
      { query: 'query { Issue: __type(name: "Issue") { fields { name } } }' },
    ]),
  });
  verify(reply.status === 200, 'GraphQL batched 200');
  verify(Array.isArray(reply.body) && (reply.body as any[]).length === 2, 'two results returned');

  const anonymous = await fetch(gqlEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query { viewer { login } }' }),
  });
  verify(anonymous.status === 401, 'GraphQL unauth 401');

  await jsonCall(`${forgeUrl}/api/v3/repos/${currentViewer}/${repoName}`, { method: 'DELETE' });
}

async function checkMcp() {
  console.log('\n=== MCP ===');
  const mcpEndpoint = `${forgeUrl}/mcp`;

  let reply = await jsonCall(mcpEndpoint, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
  });
  verify(reply.status === 200, 'MCP server/discover 200');
  const discover = (reply.body as any);
  verify(discover.result?.supportedVersions?.length > 0, 'supportedVersions present');
  verify(discover.result?.serverInfo?.name, 'serverInfo.name');
  verify(discover.result?.serverInfo?.version, 'serverInfo.version');
  verify(discover.result?.capabilities?.tools !== undefined, 'capabilities.tools');

  reply = await jsonCall(mcpEndpoint, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  verify(reply.status === 200, 'MCP tools/list 200');
  const tools = (reply.body as any).result?.tools ?? [];
  verify(tools.length >= 6, `at least 6 tools (got ${tools.length})`);
  const neededTools = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'];
  for (const toolName of neededTools) {
    verify(tools.some((tool: any) => tool.name === toolName), `tool ${toolName} present`);
  }
  for (const tool of tools) {
    verify(tool.description && tool.description.length > 0, `tool ${tool.name} has description`);
    verify(tool.inputSchema?.type === 'object', `tool ${tool.name} inputSchema is object`);
  }

  const repoName = `mcp-${Date.now()}`;
  reply = await jsonCall(mcpEndpoint, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_repo', arguments: { name: repoName, private: true } } }),
  });
  verify(reply.status === 200, 'MCP create_repo 200');
  verify((reply.body as any).result, 'create_repo result');

  reply = await jsonCall(mcpEndpoint, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_repo', arguments: { owner: currentViewer, repo: repoName } } }),
  });
  verify(reply.status === 200, 'MCP get_repo 200');

  reply = await jsonCall(mcpEndpoint, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: currentViewer, repo: repoName, title: 'MCP Issue', body: 'body' } } }),
  });
  verify(reply.status === 200, 'MCP create_issue 200');

  reply = await jsonCall(mcpEndpoint, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_issues', arguments: { owner: currentViewer, repo: repoName, state: 'open' } } }),
  });
  verify(reply.status === 200, 'MCP list_issues 200');

  reply = await jsonCall(mcpEndpoint, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } }),
  });
  verify(reply.status !== 500, 'unknown tool not 500');
  verify((reply.body as any).error?.code === -32601 || (reply.body as any).error?.code === -32602, 'unknown tool JSON-RPC error');

  const malformed = await fetch(mcpEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secretToken}` },
    body: '{"jsonrpc": "2.0", "id": 8, "method": "tools/list"',
  });
  verify(malformed.status === 400, 'parse error 400');
  const parseErrorBody = await malformed.json();
  verify(parseErrorBody.error?.code === -32700, 'parse error -32700');

  reply = await jsonCall(mcpEndpoint, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'create_issue', arguments: {} } }),
  });
  verify((reply.body as any).error?.code === -32602 || (reply.body as any).result?.isError === true, 'missing args error');

  const unauthenticated = await fetch(mcpEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'x', repo: 'y', title: 'z' } } }),
  });
  verify(unauthenticated.status === 401, 'no auth 401');

  await jsonCall(`${forgeUrl}/api/v3/repos/${currentViewer}/${repoName}`, { method: 'DELETE' });
}

function packetPayload(text: string): string {
  const length = parseInt(text.slice(0, 4), 16);
  return length > 4 ? text.slice(4, length) : '';
}

async function checkGitTransport() {
  console.log('\n=== Git Smart HTTP ===');
  const repoName = `git-${Date.now()}`;

  let reply = await jsonCall(`${forgeUrl}/api/v3/user/repos`, {
    method: 'POST',
    body: JSON.stringify({ name: repoName, private: true }),
  });
  verify(reply.status === 201, 'REST create repo for Git');

  const authOnly = { authorization: `Bearer ${secretToken}` };
  const gitBase = `${forgeUrl}/${currentViewer}/${repoName}.git`;

  const v2Advert = await fetch(`${gitBase}/info/refs?service=git-upload-pack`, {
    headers: { ...authOnly, 'git-protocol': 'version=2' },
  });
  verify(v2Advert.status === 200, 'Git v2 info/refs 200');
  verify(v2Advert.headers.get('content-type')?.includes('application/x-git-upload-pack-advertisement'), 'v2 content-type');
  const v2Text = await v2Advert.text();
  verify(packetPayload(v2Text) === 'version 2\n', `v2 advertisement first pkt is "version 2" (got ${JSON.stringify(packetPayload(v2Text))})`);
  verify(v2Text.includes('ls-refs') && v2Text.includes('fetch'), 'v2 caps');

  const v0Advert = await fetch(`${gitBase}/info/refs?service=git-upload-pack`, { headers: authOnly });
  verify(v0Advert.status === 200, 'Git v0 info/refs 200');
  verify(packetPayload(await v0Advert.text()) === '# service=git-upload-pack\n', 'v0 preamble');

  const receiveAdvert = await fetch(`${gitBase}/info/refs?service=git-receive-pack`, { headers: authOnly });
  verify(receiveAdvert.status === 200, 'receive-pack info/refs 200');
  const receiveText = await receiveAdvert.text();
  verify(packetPayload(receiveText) === '# service=git-receive-pack\n', 'receive-pack preamble');
  verify(receiveText.includes('report-status') && receiveText.includes('side-band-64k') && receiveText.includes('delete-refs'), 'receive-pack caps');

  const absent = await fetch(`${forgeUrl}/${currentViewer}/nonexistent.git/info/refs?service=git-upload-pack`, { headers: authOnly });
  verify(absent.status === 404, 'missing repo 404');

  await jsonCall(`${forgeUrl}/api/v3/repos/${currentViewer}/${repoName}`, { method: 'DELETE' });
}

async function runAll() {
  console.log(`Testing forge at ${forgeUrl}`);
  try {
    await checkProtocolAndAuth();
    await checkRestApi();
    await checkGraphQL();
    await checkMcp();
    await checkGitTransport();
    console.log('\n✅ All smoke tests passed!');
  } catch (error) {
    console.error('\n❌ Smoke test failed:', (error as Error).message);
    process.exit(1);
  }
}

runAll();
