// The HTTP server: wires together the REST v3 API, GraphQL v4, MCP, and Git smart HTTP.
// Also handles auth, request IDs, JSON parsing, and the required headers.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { scenarioActors } from './scenario.ts';
import { Store } from './store.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL, handleGraphQLBatch } from './graphql.ts';
import { handleMCP, type McpRequestOptions, MCP_REVISION } from './mcp.ts';
import { handleGitRequest, type HandlerResult } from './gitwire.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';

const { viewer } = scenarioActors();
const store = new Store(viewer.login);
let requestIdCounter = 0;

function nextRequestId(): string {
  requestIdCounter += 1;
  return createHash('sha256').update(`req-${requestIdCounter}-${process.hrtime.bigint()}`).digest('hex').slice(0, 20);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...extraHeaders,
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string, extraHeaders: Record<string, string> = {}): void {
  sendJson(res, status, { message }, extraHeaders);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
}

function pathSegments(req: IncomingMessage): string[] {
  const url = parseUrl(req);
  return url.pathname.split('/').filter(s => s !== '');
}

function checkAuth(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  const [scheme, token] = auth.split(' ');
  return scheme.toLowerCase() === 'bearer' && token === TOKEN;
}

function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('malformed');
  }
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const startTime = process.hrtime.bigint();
    const segments = pathSegments(req);
    const method = req.method ?? 'GET';

    // Health check (no auth)
    if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    if (segments.length >= 2 && segments[1]?.endsWith('.git')) {
      const owner = segments[0];
      const repoName = segments[1]!.slice(0, -4); // remove .git
      const repo = store.get(owner, repoName);
      if (!repo) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (!checkAuth(req)) {
        sendError(res, 401, 'Bad credentials');
        return;
      }
      const url = parseUrl(req);
      const query = url.searchParams;
      const body = await readBody(req);
      const gitProtocol = req.headers['git-protocol']?.toString() ?? '';
      const isV2 = gitProtocol.includes('version=2');
      // For GET /info/refs the service comes from ?service=; for POST it is the last path segment.
      const serviceParam = method === 'GET'
        ? (query.get('service') === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack')
        : (url.pathname.endsWith('git-receive-pack') ? 'git-receive-pack' : 'git-upload-pack');
      try {
        const result = await handleGitRequest({
          repo,
          service: serviceParam,
          method,
          query,
          body,
          gitProtocol: isV2 ? '2' : '0',
          acceptSideband: true,
        });
        res.writeHead(result.status, {
          'content-type': result.contentType,
          'content-length': result.body.length,
          'cache-control': 'no-cache',
          'x-github-request-id': nextRequestId(),
          ...result.headers,
        });
        res.end(result.body);
      } catch (e) {
        sendError(res, 500, `Internal Server Error: ${(e as Error).message}`);
      }
      return;
    }

    // Auth required for everything else
    const hasAuth = checkAuth(req);
    if (!hasAuth) {
      sendError(res, 401, 'Bad credentials', { 'www-authenticate': 'Bearer' });
      return;
    }

    const url = parseUrl(req);
    const body = await readBody(req);
    const baseUrl = `${url.protocol}//${url.host}`;

    // MCP: /mcp — gets the RAW body so a malformed body becomes JSON-RPC -32700 (HTTP 400)
    if (url.pathname === '/mcp') {
      try {
        const result = await handleMCP({
          body: body.toString('utf8'),
          headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => v !== undefined) as [string, string][]),
          method,
          store,
          viewer: viewer.login,
          baseUrl,
          hasAuth,
        });
        res.writeHead(result.status, {
          'content-type': result.isSSE ? 'text/event-stream' : 'application/json',
          'content-length': Buffer.byteLength(result.body),
          'mcp-protocol-version': MCP_REVISION,
          'x-github-request-id': nextRequestId(),
          ...result.headers,
        });
        res.end(result.body);
      } catch (e) {
        sendError(res, 500, `Internal Server Error: ${(e as Error).message}`);
      }
      return;
    }

    // Everything else parses JSON; malformed body is a 400.
    let parsedBody: unknown;
    try {
      parsedBody = parseJsonBody(body);
    } catch {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }

    // GraphQL: /api/graphql
    if (url.pathname === '/api/graphql') {
      try {
        // Check if batched (array body)
        if (Array.isArray(parsedBody)) {
          const results = await handleGraphQLBatch(parsedBody as Array<{ query: string; variables?: Record<string, unknown> }>, store, viewer.login);
          sendJson(res, 200, results);
        } else {
          const result = await handleGraphQL(parsedBody as { query: string; variables?: Record<string, unknown> }, store, viewer.login, baseUrl);
          const status = result.errors ? 200 : 200;
          sendJson(res, status, result);
        }
      } catch (e) {
        sendError(res, 500, `Internal Server Error: ${(e as Error).message}`);
      }
      return;
    }

    // REST v3: /api/v3/...
    if (url.pathname.startsWith('/api/v3')) {
      const restPath = url.pathname.slice('/api/v3'.length);
      const restSegments = restPath.split('/').filter(s => s !== '');
      const query = url.searchParams;
      const restReq: RestRequest = {
        method,
        segments: ['v3', ...restSegments],
        query,
        body: parsedBody,
        store,
        baseUrl,
      };
      try {
        const result = handleRest(restReq);
        const headers: Record<string, string> = { 'x-github-request-id': nextRequestId() };
        if (result.headers) Object.assign(headers, result.headers);
        // 204 has no body
        if (result.status === 204) {
          res.writeHead(204, headers);
          res.end();
        } else {
          sendJson(res, result.status, result.body ?? { message: 'Not Found' }, headers);
        }
      } catch (e) {
        sendError(res, 500, `Internal Server Error: ${(e as Error).message}`);
      }
      return;
    }

    // Unknown route
    sendError(res, 404, 'Not Found');
  });
}