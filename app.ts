// HTTP entry point: routes the v3 REST API, v4 GraphQL, MCP and Git smart HTTP, and centralizes
// authentication, request identifiers, JSON decoding and the headers every reply must carry.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { scenarioActors } from './scenario.ts';
import { Store } from './store.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL, handleGraphQLBatch } from './graphql.ts';
import { handleMCP, type McpRequestOptions, MCP_REVISION } from './mcp.ts';
import { handleGitRequest, type HandlerResult } from './gitwire.ts';

const JSON_MEDIA_TYPE = 'application/json; charset=utf-8';
const ACCESS_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';
const { viewer: actingUser } = scenarioActors();
const forgeStore = new Store(actingUser.login);
let idSerial = 0;

function freshRequestId(): string {
  idSerial += 1;
  return createHash('sha256').update(`req-${idSerial}-${process.hrtime.bigint()}`).digest('hex').slice(0, 20);
}

function decodeBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((accept, reject) => {
    const pieces: Buffer[] = [];
    request.on('data', piece => pieces.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece)));
    request.on('end', () => accept(Buffer.concat(pieces)));
    request.on('error', reject);
  });
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
}

function urlSegments(request: IncomingMessage): string[] {
  return requestUrl(request).pathname.split('/').filter(part => part !== '');
}

function isAuthorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization;
  if (!header) return false;
  const [kind, presented] = header.split(' ');
  return kind.toLowerCase() === 'bearer' && presented === ACCESS_TOKEN;
}

function decodeJson(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('malformed');
  }
}

function emitJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const serialized = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    'content-type': JSON_MEDIA_TYPE,
    'content-length': Buffer.byteLength(serialized),
    'x-github-request-id': freshRequestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...headers,
  });
  response.end(serialized);
}

function emitError(response: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  emitJson(response, status, { message }, headers);
}

export function createApp(): Server {
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const begunAt = process.hrtime.bigint();
    const parts = urlSegments(request);
    const httpMethod = request.method ?? 'GET';

    // Unauthenticated liveness probe.
    if (httpMethod === 'GET' && parts.length === 1 && parts[0] === 'healthz') {
      emitJson(response, 200, { ok: true });
      return;
    }

    // Git smart HTTP lives under /{owner}/{repo}.git/...
    if (parts.length >= 2 && parts[1]?.endsWith('.git')) {
      const owner = parts[0]!;
      const repositoryName = parts[1]!.slice(0, -4);
      const repository = forgeStore.get(owner, repositoryName);
      if (!repository) {
        emitError(response, 404, 'Not Found');
        return;
      }
      if (!isAuthorized(request)) {
        emitError(response, 401, 'Bad credentials');
        return;
      }
      const address = requestUrl(request);
      const parameters = address.searchParams;
      const bodyBytes = await decodeBody(request);
      const protocolHint = request.headers['git-protocol']?.toString() ?? '';
      const protocol = protocolHint.includes('version=2') ? '2' : '0';
      // GET /info/refs names the service in ?service=; POST names it in the trailing path segment.
      const service = httpMethod === 'GET'
        ? (parameters.get('service') === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack')
        : (address.pathname.endsWith('git-receive-pack') ? 'git-receive-pack' : 'git-upload-pack');
      try {
        const outcome: HandlerResult = await handleGitRequest({
          repo: repository,
          service,
          method: httpMethod,
          query: parameters,
          body: bodyBytes,
          gitProtocol: protocol,
          acceptSideband: true,
        });
        response.writeHead(outcome.status, {
          'content-type': outcome.contentType,
          'content-length': outcome.body.length,
          'cache-control': 'no-cache',
          'x-github-request-id': freshRequestId(),
          ...outcome.headers,
        });
        response.end(outcome.body);
      } catch (problem) {
        emitError(response, 500, `Internal Server Error: ${(problem as Error).message}`);
      }
      return;
    }

    // Every remaining route needs a bearer token.
    if (!isAuthorized(request)) {
      emitError(response, 401, 'Bad credentials', { 'www-authenticate': 'Bearer' });
      return;
    }

    const address = requestUrl(request);
    const rawBody = await decodeBody(request);
    const serviceOrigin = `${address.protocol}//${address.host}`;

    // MCP receives the untouched text: a broken body must become JSON-RPC -32700 (HTTP 400).
    if (address.pathname === '/mcp') {
      try {
        const options: McpRequestOptions = {
          body: rawBody.toString('utf8'),
          headers: Object.fromEntries(Object.entries(request.headers).filter(([, value]) => value !== undefined) as [string, string][]),
          method: httpMethod,
          store: forgeStore,
          viewer: actingUser.login,
          baseUrl: serviceOrigin,
          hasAuth: true,
        };
        const answer = await handleMCP(options);
        response.writeHead(answer.status, {
          'content-type': answer.isSSE ? 'text/event-stream' : 'application/json',
          'content-length': Buffer.byteLength(answer.body),
          'mcp-protocol-version': MCP_REVISION,
          'x-github-request-id': freshRequestId(),
          ...answer.headers,
        });
        response.end(answer.body);
      } catch (problem) {
        emitError(response, 500, `Internal Server Error: ${(problem as Error).message}`);
      }
      return;
    }

    let jsonBody: unknown;
    try {
      jsonBody = decodeJson(rawBody);
    } catch {
      emitError(response, 400, 'Problems parsing JSON');
      return;
    }

    if (address.pathname === '/api/graphql') {
      try {
        if (Array.isArray(jsonBody)) {
          const perQuery = await handleGraphQLBatch(jsonBody as Array<{ query: string; variables?: Record<string, unknown> }>, forgeStore, actingUser.login);
          emitJson(response, 200, perQuery);
        } else {
          const answer = await handleGraphQL(jsonBody as { query: string; variables?: Record<string, unknown> }, forgeStore, actingUser.login, serviceOrigin);
          emitJson(response, 200, answer);
        }
      } catch (problem) {
        emitError(response, 500, `Internal Server Error: ${(problem as Error).message}`);
      }
      return;
    }

    if (address.pathname.startsWith('/api/v3')) {
      const remainder = address.pathname.slice('/api/v3'.length);
      const restParts = remainder.split('/').filter(part => part !== '');
      const restCall: RestRequest = {
        method: httpMethod,
        segments: ['v3', ...restParts],
        query: address.searchParams,
        body: jsonBody,
        store: forgeStore,
        baseUrl: serviceOrigin,
      };
      try {
        const answer = handleRest(restCall);
        const headers: Record<string, string> = { 'x-github-request-id': freshRequestId() };
        if (answer.headers) Object.assign(headers, answer.headers);
        if (answer.status === 204) {
          response.writeHead(204, headers);
          response.end();
        } else {
          emitJson(response, answer.status, answer.body ?? { message: 'Not Found' }, headers);
        }
      } catch (problem) {
        emitError(response, 500, `Internal Server Error: ${(problem as Error).message}`);
      }
      return;
    }

    emitError(response, 404, 'Not Found');
  });
}
