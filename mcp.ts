// MCP endpoint /mcp: JSON-RPC 2.0 over Streamable HTTP (revision 2026-07-28). Exposes discovery,
// initialize, tools/list and tools/call for the six required GitHub-shaped tools.

import type { Store, Repo, Issue, Pull } from './store.ts';
import { isObjectId } from './store.ts';

const MCP_REVISION = '2026-07-28';
export { MCP_REVISION };
const OLDER_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface RpcCall {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcReply {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOL_CATALOG: ToolDefinition[] = [
  {
    name: 'create_repo',
    title: 'Create Repository',
    description: 'Create a new repository',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    title: 'Get Repository',
    description: 'Get repository details',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    title: 'Create Issue',
    description: 'Create a new issue',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    title: 'List Issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter (open, closed, all)' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    title: 'Create Pull Request',
    description: 'Create a new pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'PR title' },
        body: { type: 'string', description: 'PR body' },
        head: { type: 'string', description: 'Head branch' },
        base: { type: 'string', description: 'Base branch' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge Pull Request',
    description: 'Merge a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function okReply(id: string | number | null, payload: unknown): RpcReply {
  return { jsonrpc: '2.0', id, result: payload };
}

function failReply(id: string | number | null, code: number, message: string, data?: unknown): RpcReply {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

function discoveryPayload(): unknown {
  return {
    resultType: 'DiscoverResult',
    supportedVersions: [MCP_REVISION, ...OLDER_REVISIONS],
    capabilities: { tools: {} },
    serverInfo: { name: 'entry-forge', version: '1.0.0' },
    instructions: 'GitHub-compatible MCP server for github-core-clone-01',
    _meta: {
      'io.modelcontextprotocol/serverInfo': { name: 'entry-forge', version: '1.0.0' },
      'io.modelcontextprotocol/protocolVersion': MCP_REVISION,
    },
  };
}

function initializationPayload(version: string): unknown {
  return {
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: { name: 'entry-forge', version: '1.0.0' },
  };
}

function catalogPayload(): unknown {
  return { tools: TOOL_CATALOG.map(entry => ({ ...entry })) };
}

async function doCreateRepository(args: Record<string, unknown>, store: Store): Promise<unknown> {
  const name = String(args.name);
  const description = String(args.description ?? '');
  const visibility = args.private === true;
  const created = store.create(name, description, visibility);
  if ('error' in created) throw new Error(created.error);
  const repo: Repo = created.repo;
  return {
    id: `gid://entry-forge/Repository/${repo.id}`,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: `gid://entry-forge/User/1001` },
    url: `http://localhost/${repo.owner}/${repo.name}`,
    isPrivate: repo.isPrivate,
    description: repo.description,
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: repo.iso(),
    updatedAt: repo.iso(),
  };
}

async function doGetRepository(args: Record<string, unknown>, store: Store): Promise<unknown> {
  const owner = String(args.owner);
  const name = String(args.repo);
  const repo = store.get(owner, name);
  if (!repo) throw new Error('Repository not found');
  return {
    id: `gid://entry-forge/Repository/${repo.id}`,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: `gid://entry-forge/User/1001` },
    url: `http://localhost/${owner}/${name}`,
    isPrivate: repo.isPrivate,
    description: repo.description,
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: repo.iso(),
    updatedAt: repo.iso(),
  };
}

async function doCreateIssue(args: Record<string, unknown>, store: Store): Promise<unknown> {
  const owner = String(args.owner);
  const name = String(args.repo);
  const repo = store.get(owner, name);
  if (!repo) throw new Error('Repository not found');
  const title = String(args.title);
  const body = String(args.body ?? '');
  repo.tick();
  const issue: Issue = {
    id: repo.issueSeq++,
    number: repo.issueSeq,
    title,
    body,
    state: 'open',
    labels: [],
    createdAt: repo.iso(),
    updatedAt: repo.iso(),
    closedAt: null,
    user: repo.owner,
    comments: [],
  };
  issue.id = 9000 + issue.number;
  repo.issues.push(issue);
  return {
    issue: {
      id: `gid://entry-forge/Issue/${issue.id}`,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      url: `http://localhost/${owner}/${name}/issues/${issue.number}`,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      author: { login: issue.user },
    },
  };
}

async function doListIssues(args: Record<string, unknown>, store: Store): Promise<unknown> {
  const owner = String(args.owner);
  const name = String(args.repo);
  const repo = store.get(owner, name);
  if (!repo) throw new Error('Repository not found');
  const wanted = String(args.state ?? 'open').toLowerCase();
  let matches = [...repo.issues];
  if (wanted !== 'all') matches = matches.filter(entry => entry.state === wanted);
  return {
    issues: matches.map(issue => ({
      id: `gid://entry-forge/Issue/${issue.id}`,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      url: `http://localhost/${owner}/${name}/issues/${issue.number}`,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      author: { login: issue.user },
    })),
  };
}

async function doCreatePullRequest(args: Record<string, unknown>, store: Store): Promise<unknown> {
  const owner = String(args.owner);
  const name = String(args.repo);
  const repo = store.get(owner, name);
  if (!repo) throw new Error('Repository not found');
  const head = String(args.head);
  const base = String(args.base);
  const title = String(args.title);
  const body = String(args.body ?? '');
  const headRef = `refs/heads/${head}`;
  const baseRef = `refs/heads/${base}`;
  const headSha = repo.refs.get(headRef);
  const baseSha = repo.refs.get(baseRef);
  if (!headSha || !baseSha) throw new Error('Branch not found');
  const changedFiles = repo.diffTree(baseSha, headSha);
  repo.tick();
  const pull: Pull = {
    id: 80_000 + ++repo.pullSeq,
    number: repo.pullSeq,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    closedAt: null,
    mergeCommitSha: null,
    headRef: head,
    headSha,
    baseRef: base,
    baseSha,
    files: changedFiles,
    createdAt: repo.iso(),
    user: repo.owner,
  };
  repo.pulls.push(pull);
  return {
    pullRequest: {
      id: `gid://entry-forge/PullRequest/${pull.id}`,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: 'OPEN',
      headRefName: pull.headRef,
      baseRefName: pull.baseRef,
      url: `http://localhost/${owner}/${name}/pull/${pull.number}`,
      mergeable: 'MERGEABLE',
      createdAt: pull.createdAt,
      updatedAt: pull.createdAt,
      author: { login: pull.user },
    },
  };
}

async function doMergePullRequest(args: Record<string, unknown>, store: Store): Promise<unknown> {
  const owner = String(args.owner);
  const name = String(args.repo);
  const pullNumber = Number(args.pull_number);
  const repo = store.get(owner, name);
  if (!repo) throw new Error('Repository not found');
  const pull = repo.pullByNumber(pullNumber);
  if (!pull) throw new Error('Pull request not found');
  if (pull.merged) throw new Error('Already merged');
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  if (!baseTip || !headTip || !repo.isAncestor(baseTip, headTip)) throw new Error('Pull Request is not mergeable');
  const mergeSha = `merge_${pull.id}_${Date.now()}`;
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = repo.iso();
  pull.mergeCommitSha = mergeSha;
  pull.closedAt = pull.mergedAt;
  return {
    pullRequest: {
      id: `gid://entry-forge/PullRequest/${pull.id}`,
      number: pull.number,
      merged: true,
      state: 'MERGED',
      mergedAt: pull.mergedAt,
      mergeCommitSha: pull.mergeCommitSha,
    },
  };
}

const TOOL_IMPLEMENTATIONS: Record<string, (args: Record<string, unknown>, store: Store) => Promise<unknown>> = {
  create_repo: doCreateRepository,
  get_repo: doGetRepository,
  create_issue: doCreateIssue,
  list_issues: doListIssues,
  create_pull_request: doCreatePullRequest,
  merge_pull_request: doMergePullRequest,
};

function locateTool(name: string): ToolDefinition | undefined {
  return TOOL_CATALOG.find(entry => entry.name === name);
}

export interface McpRequestOptions {
  body: string;
  headers: Record<string, string>;
  method: string;
  store: Store;
  viewer: string;
  baseUrl: string;
  hasAuth: boolean;
}

export interface McpResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  isSSE: boolean;
}

export async function handleMCP(options: McpRequestOptions): Promise<McpResult> {
  const { body, method, store, hasAuth } = options;
  const replyHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'mcp-protocol-version': MCP_REVISION,
  };

  if (method !== 'POST') {
    return {
      status: 405,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed' } }),
      headers: replyHeaders,
      isSSE: false,
    };
  }

  let incoming: RpcCall[];
  try {
    const parsed = JSON.parse(body);
    incoming = Array.isArray(parsed) ? parsed as RpcCall[] : [parsed as RpcCall];
  } catch {
    return { status: 400, body: JSON.stringify(failReply(null, -32700, 'Parse error')), headers: replyHeaders, isSSE: false };
  }

  const replies: RpcReply[] = [];

  for (const call of incoming) {
    const callId = call.id ?? null;
    if (call.jsonrpc !== '2.0') {
      replies.push(failReply(callId, -32600, 'Invalid Request'));
      continue;
    }

    if (call.method !== 'server/discover' && call.method !== 'initialize' && !hasAuth) {
      return {
        status: 401,
        body: JSON.stringify({ message: 'Unauthorized' }),
        headers: { ...replyHeaders, 'www-authenticate': 'Bearer' },
        isSSE: false,
      };
    }

    try {
      let payload: unknown;
      switch (call.method) {
        case 'server/discover': {
          payload = discoveryPayload();
          break;
        }
        case 'initialize': {
          const parameters = call.params ?? {};
          const requested = String(parameters.protocolVersion ?? '');
          let agreed = MCP_REVISION;
          if (requested && OLDER_REVISIONS.includes(requested)) {
            agreed = requested;
          } else if (requested && requested !== MCP_REVISION) {
            replies.push(failReply(callId, -32022, 'Unsupported protocol version', { supported: [MCP_REVISION, ...OLDER_REVISIONS] }));
            continue;
          }
          payload = initializationPayload(agreed);
          break;
        }
        case 'notifications/initialized': {
          replies.push(okReply(callId, {}));
          continue;
        }
        case 'tools/list': {
          payload = catalogPayload();
          break;
        }
        case 'tools/call': {
          const parameters = call.params ?? {};
          const toolName = String(parameters.name ?? '');
          const toolArgs = (parameters.arguments ?? {}) as Record<string, unknown>;
          const tool = locateTool(toolName);
          if (!tool) {
            replies.push(failReply(callId, -32601, `Method not found: tool '${toolName}' not found`));
            continue;
          }
          const missing = tool.inputSchema.required.filter(field => !(field in toolArgs));
          if (missing.length > 0) {
            replies.push(failReply(callId, -32602, `Invalid params: missing required arguments: ${missing.join(', ')}`));
            continue;
          }
          const implementation = TOOL_IMPLEMENTATIONS[toolName];
          if (!implementation) {
            replies.push(failReply(callId, -32601, `Method not found: no handler for '${toolName}'`));
            continue;
          }
          const value = await implementation(toolArgs, store);
          payload = {
            content: [{ type: 'text', text: JSON.stringify(value) }],
            structuredContent: value,
          };
          break;
        }
        default: {
          replies.push(failReply(callId, -32601, `Method not found: ${call.method}`));
          continue;
        }
      }
      replies.push(okReply(callId, payload));
    } catch (problem) {
      replies.push(failReply(callId, -32603, (problem as Error).message));
    }
  }

  const isNotice = replies.some(reply => reply.id === null && reply.error === undefined);
  const status = isNotice && replies.length === 1 ? 202 : 200;
  const serialized = replies.length === 1 ? JSON.stringify(replies[0]) : JSON.stringify(replies);

  return { status, body: serialized, headers: { ...replyHeaders }, isSSE: false };
}
