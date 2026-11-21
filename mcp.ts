// Model Context Protocol at /mcp — JSON-RPC 2.0 over Streamable HTTP (revision 2026-07-28).
// Supports server/discover, initialize, tools/list, tools/call with the 6 required tools.

import type { Store, Repo, Issue, Pull } from './store.ts';
import { isObjectId } from './store.ts';

const MCP_REVISION = '2026-07-28';
export { MCP_REVISION };
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

// The 6 required tools (matching github-mcp-server names)
const TOOLS: McpTool[] = [
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

function rpcSuccess(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

function discoverResult(): unknown {
  return {
    resultType: 'DiscoverResult',
    supportedVersions: [MCP_REVISION, ...LEGACY_REVISIONS],
    capabilities: { tools: {} },
    serverInfo: { name: 'entry-forge', version: '1.0.0' },
    instructions: 'GitHub-compatible MCP server for github-core-clone-01',
    _meta: {
      'io.modelcontextprotocol/serverInfo': { name: 'entry-forge', version: '1.0.0' },
      'io.modelcontextprotocol/protocolVersion': MCP_REVISION,
    },
  };
}

function initializeResult(protocolVersion: string): unknown {
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: 'entry-forge', version: '1.0.0' },
  };
}

function toolsListResult(): unknown {
  return { tools: TOOLS.map(t => ({ ...t })) };
}

// Tool implementations
async function callCreateRepo(args: Record<string, unknown>, store: Store): Promise<unknown> {
  const name = String(args.name);
  const description = String(args.description ?? '');
  const isPrivate = args.private === true;
  const result = store.create(name, description, isPrivate);
  if ('error' in result) throw new Error(result.error);
  const repo = result.repo;
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

async function callGetRepo(args: Record<string, unknown>, store: Store): Promise<unknown> {
  const owner = String(args.owner);
  const repoName = String(args.repo);
  const repo = store.get(owner, repoName);
  if (!repo) throw new Error('Repository not found');
  return {
    id: `gid://entry-forge/Repository/${repo.id}`,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: `gid://entry-forge/User/1001` },
    url: `http://localhost/${owner}/${repoName}`,
    isPrivate: repo.isPrivate,
    description: repo.description,
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: repo.iso(),
    updatedAt: repo.iso(),
  };
}

async function callCreateIssue(args: Record<string, unknown>, store: Store): Promise<unknown> {
  const owner = String(args.owner);
  const repoName = String(args.repo);
  const repo = store.get(owner, repoName);
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
      url: `http://localhost/${owner}/${repoName}/issues/${issue.number}`,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      author: { login: issue.user },
    },
  };
}

async function callListIssues(args: Record<string, unknown>, store: Store): Promise<unknown> {
  const owner = String(args.owner);
  const repoName = String(args.repo);
  const repo = store.get(owner, repoName);
  if (!repo) throw new Error('Repository not found');
  const state = (String(args.state ?? 'open')).toLowerCase();
  let list = [...repo.issues];
  if (state !== 'all') list = list.filter(i => i.state === state);
  return {
    issues: list.map(issue => ({
      id: `gid://entry-forge/Issue/${issue.id}`,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      url: `http://localhost/${owner}/${repoName}/issues/${issue.number}`,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      author: { login: issue.user },
    })),
  };
}

async function callCreatePullRequest(args: Record<string, unknown>, store: Store): Promise<unknown> {
  const owner = String(args.owner);
  const repoName = String(args.repo);
  const repo = store.get(owner, repoName);
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
  const files = repo.diffTree(baseSha, headSha);
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
    files,
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
      url: `http://localhost/${owner}/${repoName}/pull/${pull.number}`,
      mergeable: 'MERGEABLE',
      createdAt: pull.createdAt,
      updatedAt: pull.createdAt,
      author: { login: pull.user },
    },
  };
}

async function callMergePullRequest(args: Record<string, unknown>, store: Store): Promise<unknown> {
  const owner = String(args.owner);
  const repoName = String(args.repo);
  const pullNumber = Number(args.pull_number);
  const repo = store.get(owner, repoName);
  if (!repo) throw new Error('Repository not found');
  const pull = repo.pullByNumber(pullNumber);
  if (!pull) throw new Error('Pull request not found');
  if (pull.merged) throw new Error('Already merged');
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  if (!baseTip || !headTip || !repo.isAncestor(baseTip, headTip)) {
    throw new Error('Pull Request is not mergeable');
  }
  const mergeCommit = `merge_${pull.id}_${Date.now()}`;
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = repo.iso();
  pull.mergeCommitSha = mergeCommit;
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

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>, store: Store) => Promise<unknown>> = {
  create_repo: callCreateRepo,
  get_repo: callGetRepo,
  create_issue: callCreateIssue,
  list_issues: callListIssues,
  create_pull_request: callCreatePullRequest,
  merge_pull_request: callMergePullRequest,
};

function findTool(name: string): McpTool | undefined {
  return TOOLS.find(t => t.name === name);
}

// ================================================================ Public handler

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

export async function handleMCP(opts: McpRequestOptions): Promise<McpResult> {
  const { body, headers, method, store, viewer, baseUrl, hasAuth } = opts;
  const responseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'mcp-protocol-version': MCP_REVISION,
  };

  if (method !== 'POST') {
    return { status: 405, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed' } }), headers: responseHeaders, isSSE: false };
  }

  // Parse JSON-RPC request(s)
  let requests: JsonRpcRequest[];
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      requests = parsed as JsonRpcRequest[];
    } else {
      requests = [parsed as JsonRpcRequest];
    }
  } catch {
    return {
      status: 400,
      body: JSON.stringify(rpcError(null, -32700, 'Parse error')),
      headers: responseHeaders,
      isSSE: false,
    };
  }

  const responses: JsonRpcResponse[] = [];

  for (const req of requests) {
    const id = req.id ?? null;
    if (req.jsonrpc !== '2.0') {
      responses.push(rpcError(id, -32600, 'Invalid Request'));
      continue;
    }

    // Check auth for methods that require it (all except discover/initialize)
    const needsAuth = req.method !== 'server/discover' && req.method !== 'initialize';
    if (needsAuth && !hasAuth) {
      // Return HTTP 401 for the whole request per spec
      return {
        status: 401,
        body: JSON.stringify({ message: 'Unauthorized' }),
        headers: { ...responseHeaders, 'www-authenticate': 'Bearer' },
        isSSE: false,
      };
    }

    try {
      let result: unknown;
      switch (req.method) {
        case 'server/discover': {
          result = discoverResult();
          break;
        }
        case 'initialize': {
          const params = req.params ?? {};
          const clientVersion = String(params.protocolVersion ?? '');
          let negotiated = MCP_REVISION;
          if (clientVersion && LEGACY_REVISIONS.includes(clientVersion)) negotiated = clientVersion;
          else if (clientVersion && clientVersion !== MCP_REVISION && !LEGACY_REVISIONS.includes(clientVersion)) {
            // Unsupported version
            responses.push(rpcError(id, -32022, 'Unsupported protocol version', { supported: [MCP_REVISION, ...LEGACY_REVISIONS] }));
            continue;
          }
          result = initializeResult(negotiated);
          break;
        }
        case 'notifications/initialized': {
          // Notification - no response needed
          responses.push(rpcSuccess(id, {}));
          continue;
        }
        case 'tools/list': {
          result = toolsListResult();
          break;
        }
        case 'tools/call': {
          const params = req.params ?? {};
          const toolName = String(params.name ?? '');
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const tool = findTool(toolName);
          if (!tool) {
            responses.push(rpcError(id, -32601, `Method not found: tool '${toolName}' not found`));
            continue;
          }
          // Validate required args
          const missing = tool.inputSchema.required.filter(r => !(r in args));
          if (missing.length > 0) {
            responses.push(rpcError(id, -32602, `Invalid params: missing required arguments: ${missing.join(', ')}`));
            continue;
          }
          const handler = TOOL_HANDLERS[toolName];
          if (!handler) {
            responses.push(rpcError(id, -32601, `Method not found: no handler for '${toolName}'`));
            continue;
          }
          const value = await handler(args, store);
          // MCP tool results carry the payload as a text block plus structured content.
          result = {
            content: [{ type: 'text', text: JSON.stringify(value) }],
            structuredContent: value,
          };
          break;
        }
        default: {
          responses.push(rpcError(id, -32601, `Method not found: ${req.method}`));
          continue;
        }
      }
      responses.push(rpcSuccess(id, result));
    } catch (e) {
      responses.push(rpcError(id, -32603, (e as Error).message));
    }
  }

  // For notifications (id === null), GitHub returns 202 Accepted
  const hasNotification = responses.some(r => r.id === null && r.error === undefined);
  const status = hasNotification && responses.length === 1 ? 202 : 200;
  const responseBody = responses.length === 1 ? JSON.stringify(responses[0]) : JSON.stringify(responses);

  return {
    status,
    body: responseBody,
    headers: { ...responseHeaders },
    isSSE: false,
  };
}