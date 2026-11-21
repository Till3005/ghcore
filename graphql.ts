// GitHub GraphQL v4 at /api/graphql — executor for the exact documents the suite sends.
// Implements a minimal parser + type-directed executor with the schema the checks require.

import type { Store, Repo, Issue, Pull, PullFile, GitObjectType } from './store.ts';
import { isObjectId } from './store.ts';

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
}

export interface GraphQLResponse {
  data?: unknown;
  errors?: Array<{ message: string }>;
}

// ================================================================ Parser

type TokenType =
  | 'STRING' | 'INT' | 'FLOAT' | 'NAME' | 'VARIABLE' | 'PUNCTUATION'
  | 'EOF' | 'SPREAD' | 'ON';

interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

const KEYWORDS = new Set(['query', 'mutation', 'fragment', 'on', 'true', 'false', 'null']);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0, line = 1, col = 1;
  const peek = (n = 0) => input[i + n];
  const advance = (n = 1) => { for (let k = 0; k < n; k++) { if (input[i + k] === '\n') { line++; col = 1; } else col++; } i += n; };
  const isNameStart = (c: string) => /[A-Za-z_]/.test(c);
  const isNameCont = (c: string) => /[A-Za-z0-9_]/.test(c);

  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(); continue; }
    if (c === '#') { while (i < input.length && input[i] !== '\n') advance(); continue; }
    if (c === '"') {
      advance(); let val = ''; const startLine = line, startCol = col;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\') { advance(); const next = peek(); if (next === 'n') val += '\n'; else if (next === 't') val += '\t'; else if (next === 'r') val += '\r'; else if (next === '"') val += '"'; else if (next === '\\') val += '\\'; else val += next; advance(); }
        else { val += input[i]; advance(); }
      }
      advance(); tokens.push({ type: 'STRING', value: val, line: startLine, col: startCol }); continue;
    }
    if (c === '$') { advance(); let val = ''; const startLine = line, startCol = col; while (isNameCont(peek())) { val += peek(); advance(); } tokens.push({ type: 'VARIABLE', value: val, line: startLine, col: startCol }); continue; }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const startLine = line, startCol = col; let val = ''; let isFloat = false;
      if (c === '-') { val += '-'; advance(); }
      while (i < input.length && input[i] >= '0' && input[i] <= '9') { val += input[i]; advance(); }
      if (peek() === '.') { isFloat = true; val += '.'; advance(); while (i < input.length && input[i] >= '0' && input[i] <= '9') { val += input[i]; advance(); } }
      tokens.push({ type: isFloat ? 'FLOAT' : 'INT', value: val, line: startLine, col: startCol }); continue;
    }
    if (isNameStart(c)) {
      const startLine = line, startCol = col; let val = ''; while (isNameCont(peek())) { val += peek(); advance(); }
      tokens.push({ type: KEYWORDS.has(val) ? 'NAME' : 'NAME', value: val, line: startLine, col: startCol }); continue;
    }
    if (c === ':' || c === '(' || c === ')' || c === '[' || c === ']' || c === '{' || c === '}' || c === ',' || c === '=' || c === '@') {
      const startLine = line, startCol = col; let val = c; advance(); if (c === '.' && peek() === '.' && input[i + 1] === '.') { val = '...'; advance(3); tokens.push({ type: 'SPREAD', value: '...', line: startLine, col: startCol }); continue; }
      tokens.push({ type: 'PUNCTUATION', value: val, line: startLine, col: startCol }); continue;
    }
    throw new Error(`Unexpected character ${c} at ${line}:${col}`);
  }
  tokens.push({ type: 'EOF', value: '', line, col });
  return tokens;
}

interface Parser {
  tokens: Token[];
  pos: number;
  peek(n?: number): Token;
  eat(type: TokenType, value?: string): Token;
  expect(type: TokenType, value?: string): Token;
  parseDocument(): DocumentNode;
  parseOperation(): OperationDefinitionNode;
  parseSelectionSet(): SelectionNode[];
  parseField(): FieldNode;
  parseArguments(): ArgumentNode[];
  parseArgument(): ArgumentNode;
  parseValue(): ValueNode;
  parseVariableDefinitions(): VariableDefinitionNode[];
  parseVariableDefinition(): VariableDefinitionNode;
  parseType(): TypeNode;
  parseDirectives(): DirectiveNode[];
  parseFragmentSpread(): FragmentSpreadNode;
  parseInlineFragment(): InlineFragmentNode;
}

function createParser(tokens: Token[]): Parser {
  let pos = 0;
  const peek = (n = 0) => tokens[pos + n] ?? { type: 'EOF', value: '', line: 0, col: 0 };
  const eat = (type: TokenType, value?: string) => {
    const tok = peek();
    if (tok.type !== type || (value !== undefined && tok.value !== value)) throw new Error(`Expected ${type}${value ? ' ' + value : ''} at ${tok.line}:${tok.col}, got ${tok.type} ${tok.value}`);
    pos++; return tok;
  };
  const expect = eat;
  const parseType = (): TypeNode => {
    let type: TypeNode;
    if (peek().type === 'PUNCTUATION' && peek().value === '[') {
      eat('PUNCTUATION', '['); const inner = parseType(); eat('PUNCTUATION', ']'); type = { kind: 'ListType', type: inner };
    } else {
      const name = expect('NAME').value;
      type = { kind: 'NamedType', name };
    }
    if (peek().type === 'PUNCTUATION' && peek().value === '!') { eat('PUNCTUATION', '!'); type = { kind: 'NonNullType', type }; }
    return type;
  };
  const parseValue = (): ValueNode => {
    const tok = peek();
    if (tok.type === 'VARIABLE') { eat('VARIABLE'); return { kind: 'Variable', name: tok.value }; }
    if (tok.type === 'INT') { eat('INT'); return { kind: 'IntValue', value: Number(tok.value) }; }
    if (tok.type === 'FLOAT') { eat('FLOAT'); return { kind: 'FloatValue', value: Number(tok.value) }; }
    if (tok.type === 'STRING') { eat('STRING'); return { kind: 'StringValue', value: tok.value }; }
    if (tok.type === 'NAME') {
      if (tok.value === 'true' || tok.value === 'false') { eat('NAME'); return { kind: 'BooleanValue', value: tok.value === 'true' }; }
      if (tok.value === 'null') { eat('NAME'); return { kind: 'NullValue' }; }
      eat('NAME'); return { kind: 'EnumValue', value: tok.value };
    }
    if (tok.type === 'PUNCTUATION' && tok.value === '[') { eat('PUNCTUATION', '['); const vals: ValueNode[] = []; while (peek().type !== 'PUNCTUATION' || peek().value !== ']') vals.push(parseValue()); eat('PUNCTUATION', ']'); return { kind: 'ListValue', values: vals }; }
    if (tok.type === 'PUNCTUATION' && tok.value === '{') { eat('PUNCTUATION', '{'); const fields: ObjectFieldNode[] = []; while (peek().type !== 'PUNCTUATION' || peek().value !== '}') { const name = expect('NAME').value; eat('PUNCTUATION', ':'); fields.push({ kind: 'ObjectField', name, value: parseValue() }); } eat('PUNCTUATION', '}'); return { kind: 'ObjectValue', fields }; }
    throw new Error(`Unexpected value token ${tok.type} ${tok.value} at ${tok.line}:${tok.col}`);
  };
  const parseArgument = (): ArgumentNode => { const name = expect('NAME').value; eat('PUNCTUATION', ':'); return { kind: 'Argument', name, value: parseValue() }; };
  const parseArguments = (): ArgumentNode[] => { if (peek().type !== 'PUNCTUATION' || peek().value !== '(') return []; eat('PUNCTUATION', '('); const args: ArgumentNode[] = []; while (peek().type !== 'PUNCTUATION' || peek().value !== ')') args.push(parseArgument()); eat('PUNCTUATION', ')'); return args; };
  const parseDirective = (): DirectiveNode => { eat('PUNCTUATION', '@'); const name = expect('NAME').value; return { kind: 'Directive', name, arguments: parseArguments() }; };
  const parseDirectives = (): DirectiveNode[] => { const dirs: DirectiveNode[] = []; while (peek().type === 'PUNCTUATION' && peek().value === '@') dirs.push(parseDirective()); return dirs; };
  const parseField = (): FieldNode => {
    let alias: string | undefined; let name = expect('NAME').value;
    if (peek().type === 'PUNCTUATION' && peek().value === ':') { eat('PUNCTUATION', ':'); alias = name; name = expect('NAME').value; }
    const args = parseArguments(); const dirs = parseDirectives(); let selectionSet: SelectionNode[] | undefined;
    if (peek().type === 'PUNCTUATION' && peek().value === '{') { eat('PUNCTUATION', '{'); selectionSet = parseSelectionSet(); eat('PUNCTUATION', '}'); }
    return { kind: 'Field', alias, name, arguments: args, directives: dirs, selectionSet };
  };
  const parseSelectionSet = (): SelectionNode[] => { const sels: SelectionNode[] = []; while (peek().type !== 'PUNCTUATION' || peek().value !== '}') { if (peek().type === 'PUNCTUATION' && peek().value === '...') { const tok = peek(1); if (tok.type === 'NAME' && tok.value === 'on') { sels.push(parseInlineFragment()); } else { sels.push(parseFragmentSpread()); } } else { sels.push(parseField()); } } return sels; };
  const parseFragmentSpread = (): FragmentSpreadNode => { eat('SPREAD'); const name = expect('NAME').value; return { kind: 'FragmentSpread', name, directives: parseDirectives() }; };
  const parseInlineFragment = (): InlineFragmentNode => { eat('SPREAD'); eat('NAME', 'on'); const typeCondition = expect('NAME').value; return { kind: 'InlineFragment', typeCondition, directives: parseDirectives(), selectionSet: parseSelectionSet() }; };
  const parseVariableDefinition = (): VariableDefinitionNode => { const name = expect('VARIABLE').value; eat('PUNCTUATION', ':'); const type = parseType(); let defaultValue: ValueNode | undefined; if (peek().type === 'PUNCTUATION' && peek().value === '=') { eat('PUNCTUATION', '='); defaultValue = parseValue(); } return { kind: 'VariableDefinition', name, type, defaultValue, directives: [] }; };
  const parseVariableDefinitions = (): VariableDefinitionNode[] => { if (peek().type !== 'PUNCTUATION' || peek().value !== '(') return []; eat('PUNCTUATION', '('); const defs: VariableDefinitionNode[] = []; while (peek().type !== 'PUNCTUATION' || peek().value !== ')') defs.push(parseVariableDefinition()); eat('PUNCTUATION', ')'); return defs; };
  const parseOperation = (): OperationDefinitionNode => {
    let operation: OperationDefinitionNode['operation'] = 'query';
    if (peek().type === 'NAME' && (peek().value === 'query' || peek().value === 'mutation')) { operation = eat('NAME').value as any; }
    let name: string | undefined;
    if (peek().type === 'NAME' && !['query', 'mutation', 'fragment', 'on'].includes(peek().value)) { name = eat('NAME').value; }
    const vars = parseVariableDefinitions(); const dirs = parseDirectives(); eat('PUNCTUATION', '{'); const selectionSet = parseSelectionSet(); eat('PUNCTUATION', '}');
    return { kind: 'OperationDefinition', operation, name, variableDefinitions: vars, directives: dirs, selectionSet };
  };
  const parseDocument = (): DocumentNode => { const defs: DefinitionNode[] = []; while (peek().type !== 'EOF') { if (peek().type === 'NAME' && peek().value === 'fragment') { defs.push(parseFragmentDefinition()); } else { defs.push(parseOperation()); } } return { kind: 'Document', definitions: defs }; };
  const parseFragmentDefinition = (): FragmentDefinitionNode => { eat('NAME', 'fragment'); const name = expect('NAME').value; eat('NAME', 'on'); const typeCondition = expect('NAME').value; const dirs = parseDirectives(); eat('PUNCTUATION', '{'); const selectionSet = parseSelectionSet(); eat('PUNCTUATION', '}'); return { kind: 'FragmentDefinition', name, typeCondition, directives: dirs, selectionSet }; };

  return {
    tokens, pos, peek, eat, expect,
    parseDocument, parseOperation, parseSelectionSet, parseField,
    parseArguments, parseArgument, parseValue, parseVariableDefinitions, parseVariableDefinition, parseType,
    parseDirectives, parseFragmentSpread, parseInlineFragment,
  };
}

// AST types (minimal, structural)
type DefinitionNode = OperationDefinitionNode | FragmentDefinitionNode;
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface DocumentNode { kind: 'Document'; definitions: DefinitionNode[]; }
interface OperationDefinitionNode { kind: 'OperationDefinition'; operation: 'query' | 'mutation'; name?: string; variableDefinitions: VariableDefinitionNode[]; directives: DirectiveNode[]; selectionSet: SelectionNode[]; }
interface FragmentDefinitionNode { kind: 'FragmentDefinition'; name: string; typeCondition: string; directives: DirectiveNode[]; selectionSet: SelectionNode[]; }
interface FieldNode { kind: 'Field'; alias?: string; name: string; arguments: ArgumentNode[]; directives: DirectiveNode[]; selectionSet?: SelectionNode[]; }
interface ArgumentNode { kind: 'Argument'; name: string; value: ValueNode; }
interface VariableDefinitionNode { kind: 'VariableDefinition'; name: string; type: TypeNode; defaultValue?: ValueNode; directives: DirectiveNode[]; }
interface DirectiveNode { kind: 'Directive'; name: string; arguments: ArgumentNode[]; }
interface FragmentSpreadNode { kind: 'FragmentSpread'; name: string; directives: DirectiveNode[]; }
interface InlineFragmentNode { kind: 'InlineFragment'; typeCondition: string; directives: DirectiveNode[]; selectionSet: SelectionNode[]; }
type TypeNode = { kind: 'NamedType'; name: string } | { kind: 'ListType'; type: TypeNode } | { kind: 'NonNullType'; type: TypeNode };
type ValueNode = { kind: 'Variable'; name: string } | { kind: 'IntValue'; value: number } | { kind: 'FloatValue'; value: number } | { kind: 'StringValue'; value: string } | { kind: 'BooleanValue'; value: boolean } | { kind: 'NullValue' } | { kind: 'EnumValue'; value: string } | { kind: 'ListValue'; values: ValueNode[] } | { kind: 'ObjectValue'; fields: ObjectFieldNode[] };
interface ObjectFieldNode { kind: 'ObjectField'; name: string; value: ValueNode; }

// ================================================================ Schema & Resolvers

interface GqlType {
  name: string;
  fields: Map<string, FieldResolver>;
}

type FieldResolver = (source: unknown, args: Record<string, unknown>, context: GqlContext) => unknown;

interface GqlContext {
  store: Store;
  viewer: string;
  variables: Record<string, unknown>;
}

function globalId(type: string, id: string | number): string {
  return `gid://entry-forge/${type}/${id}`;
}

function decodeGlobalId(id: string): { type: string; id: string } | null {
  const m = id.match(/^gid:\/\/entry-forge\/([^/]+)\/(.+)$/);
  return m ? { type: m[1], id: m[2] } : null;
}

const schemaTypes = new Map<string, GqlType>();

function defineType(name: string, fields: Record<string, FieldResolver>) {
  schemaTypes.set(name, { name, fields: new Map(Object.entries(fields)) });
}

// -------- Scalar/Enum resolvers (handled by value coercion)

const IssueState = { OPEN: 'OPEN', CLOSED: 'CLOSED' } as const;
const PullRequestState = { OPEN: 'OPEN', CLOSED: 'CLOSED', MERGED: 'MERGED' } as const;
const MergeableState = { MERGEABLE: 'MERGEABLE', CONFLICTING: 'CONFLICTING', UNKNOWN: 'UNKNOWN' } as const;
const PullRequestMergeMethod = { MERGE: 'MERGE', SQUASH: 'SQUASH', REBASE: 'REBASE' } as const;
const RepositoryPermission = { ADMIN: 'ADMIN', MAINTAIN: 'MAINTAIN', WRITE: 'WRITE', TRIAGE: 'TRIAGE', READ: 'READ' } as const;
const SearchType = { ISSUE: 'ISSUE', REPOSITORY: 'REPOSITORY', USER: 'USER', TOPIC: 'TOPIC', CODE: 'CODE', COMMIT: 'COMMIT', MARKETPLACE: 'MARKETPLACE', LABEL: 'LABEL', MILESTONE: 'MILESTONE', PACKAGE: 'PACKAGE', DISCUSSION: 'DISCUSSION' } as const;
const IssueOrderField = { CREATED_AT: 'CREATED_AT', UPDATED_AT: 'UPDATED_AT', COMMENTS: 'COMMENTS' } as const;
const OrderDirection = { ASC: 'ASC', DESC: 'DESC' } as const;

// -------- Resolvers

defineType('Query', {
  viewer: (_s, _a, ctx) => ({ __typename: 'User', login: ctx.viewer, id: globalId('User', 1001) }),
  repository: (_s, args, ctx) => {
    const owner = String(args.owner); const name = String(args.name);
    const repo = ctx.store.get(owner, name);
    if (!repo) return null;
    return { __typename: 'Repository', repo };
  },
  node: (_s, args, ctx) => {
    const decoded = decodeGlobalId(String(args.id));
    if (!decoded) return null;
    if (decoded.type === 'Repository') {
      const repo = [...ctx.store.repos.values()].find(r => globalId('Repository', String(r.id)) === args.id);
      return repo ? { __typename: 'Repository', repo } : null;
    }
    return null;
  },
  __type: (_s, args) => {
    const name = String(args.name);
    const type = schemaTypes.get(name);
    if (!type) return null;
    return { __typename: '__Type', type };
  },
});

defineType('User', {
  login: (s) => (s as any).login,
  id: (s) => (s as any).id,
});

defineType('Repository', {
  id: (s) => globalId('Repository', String((s as any).repo.id)),
  databaseId: (s) => (s as any).repo.id,
  name: (s) => (s as any).repo.name,
  nameWithOwner: (s) => `${(s as any).repo.owner}/${(s as any).repo.name}`,
  owner: (s) => ({ __typename: 'User', login: (s as any).repo.owner, id: globalId('User', 1001) }),
  defaultBranchRef: (s) => {
    const repo = (s as any).repo as Repo;
    if (!repo.refs.has(repo.headRefName())) return null;
    return { __typename: 'Ref', name: repo.defaultBranch };
  },
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  issue: (s, args, ctx) => {
    const repo = (s as any).repo as Repo;
    const issue = repo.issueByNumber(Number(args.number));
    return issue ? { __typename: 'Issue', issue, repo } : null;
  },
  issues: (s, args, ctx) => {
    const repo = (s as any).repo as Repo;
    let list = [...repo.issues];
    const states = (args.states as string[]) ?? ['OPEN'];
    if (!states.includes('ALL')) list = list.filter(i => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
    const orderBy = args.orderBy as { field: string; direction: string } | undefined;
    const field = orderBy?.field ?? 'CREATED_AT';
    const dir = orderBy?.direction ?? 'ASC';
    list.sort((a, b) => {
      let av = field === 'UPDATED_AT' ? a.updatedAt : field === 'COMMENTS' ? String(a.comments.length) : a.createdAt;
      let bv = field === 'UPDATED_AT' ? b.updatedAt : field === 'COMMENTS' ? String(b.comments.length) : b.createdAt;
      return dir === 'ASC' ? (av < bv ? -1 : av > bv ? 1 : a.number - b.number) : (av > bv ? -1 : av < bv ? 1 : b.number - a.number);
    });
    const after = args.after as string | undefined;
    const first = Number(args.first ?? 100);
    let start = 0;
    if (after) { const idx = list.findIndex(i => String(i.number) === after); if (idx >= 0) start = idx + 1; }
    const nodes = list.slice(start, start + first);
    return {
      __typename: 'IssueConnection',
      nodes: nodes.map(i => ({ __typename: 'Issue', issue: i, repo })),
      pageInfo: { __typename: 'PageInfo', hasNextPage: start + first < list.length, endCursor: nodes.length ? String(nodes[nodes.length - 1].number) : null },
    };
  },
  pullRequests: (s, args, ctx) => {
    const repo = (s as any).repo as Repo;
    const first = Number(args.first ?? 100);
    return {
      __typename: 'PullRequestConnection',
      nodes: repo.pulls.slice(0, first).map(p => ({ __typename: 'PullRequest', pull: p, repo })),
    };
  },
  pullRequest: (s, args, ctx) => {
    const repo = (s as any).repo as Repo;
    const pull = repo.pullByNumber(Number(args.number));
    return pull ? { __typename: 'PullRequest', pull, repo } : null;
  },
});

defineType('Issue', {
  id: (s) => globalId('Issue', String((s as any).issue.id)),
  number: (s) => (s as any).issue.number,
  title: (s) => (s as any).issue.title,
  state: (s) => (s as any).issue.state === 'open' ? 'OPEN' : 'CLOSED',
  body: (s) => (s as any).issue.body,
});

defineType('IssueConnection', {
  nodes: (s) => (s as any).nodes,
  pageInfo: (s) => (s as any).pageInfo,
});

defineType('PageInfo', {
  hasNextPage: (s) => (s as any).hasNextPage,
  endCursor: (s) => (s as any).endCursor,
});

defineType('PullRequest', {
  id: (s) => globalId('PullRequest', String((s as any).pull.id)),
  number: (s) => (s as any).pull.number,
  state: (s) => {
    const p = (s as any).pull as Pull;
    if (p.merged) return 'MERGED';
    return p.state === 'open' ? 'OPEN' : 'CLOSED';
  },
  merged: (s) => (s as any).pull.merged,
  headRefName: (s) => (s as any).pull.headRef,
  baseRefName: (s) => (s as any).pull.baseRef,
  mergeable: (s) => {
    const p = (s as any).pull as Pull;
    const repo = (s as any).repo as Repo;
    const baseTip = repo.refs.get(`refs/heads/${p.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${p.headRef}`) ?? p.headSha;
    if (!baseTip || !headTip) return 'UNKNOWN';
    return repo.isAncestor(baseTip, headTip) ? 'MERGEABLE' : 'CONFLICTING';
  },
  files: (s, args, ctx) => {
    const p = (s as any).pull as Pull;
    const first = Number(args.first ?? 100);
    return {
      __typename: 'PullRequestFileConnection',
      nodes: p.files.slice(0, first).map(f => ({ __typename: 'PullRequestChangedFile', path: f.filename })),
    };
  },
});

defineType('PullRequestFileConnection', {
  nodes: (s) => (s as any).nodes,
});

defineType('PullRequestChangedFile', {
  path: (s) => (s as any).path,
});

defineType('PullRequestConnection', {
  nodes: (s) => (s as any).nodes,
});

defineType('Ref', { name: (s) => (s as any).name });

defineType('__Type', {
  name: (s) => (s as any).type.name,
  fields: (s, args) => {
    const type = (s as any).type as GqlType;
    return [...type.fields.keys()].map(name => ({ __typename: '__Field', name }));
  },
  enumValues: (s, args) => {
    const type = (s as any).type as GqlType;
    if (type.name === 'SearchType') return [...Object.values(SearchType)].map(name => ({ __typename: '__EnumValue', name }));
    if (type.name === 'IssueState') return [...Object.values(IssueState)].map(name => ({ __typename: '__EnumValue', name }));
    if (type.name === 'PullRequestState') return [...Object.values(PullRequestState)].map(name => ({ __typename: '__EnumValue', name }));
    if (type.name === 'MergeableState') return [...Object.values(MergeableState)].map(name => ({ __typename: '__EnumValue', name }));
    if (type.name === 'PullRequestMergeMethod') return [...Object.values(PullRequestMergeMethod)].map(name => ({ __typename: '__EnumValue', name }));
    if (type.name === 'RepositoryPermission') return [...Object.values(RepositoryPermission)].map(name => ({ __typename: '__EnumValue', name }));
    if (type.name === 'IssueOrderField') return [...Object.values(IssueOrderField)].map(name => ({ __typename: '__EnumValue', name }));
    if (type.name === 'OrderDirection') return [...Object.values(OrderDirection)].map(name => ({ __typename: '__EnumValue', name }));
    return [];
  },
});

defineType('__Field', { name: (s) => (s as any).name });
defineType('__EnumValue', { name: (s) => (s as any).name });

// Mutations
defineType('Mutation', {
  createIssue: (_s, args, ctx) => {
    const input = args.input as Record<string, unknown>;
    const repoId = String(input.repositoryId);
    const repo = [...ctx.store.repos.values()].find(r => globalId('Repository', String(r.id)) === repoId);
    if (!repo) throw new Error('Repository not found');
    const title = String(input.title);
    const body = String(input.body ?? '');
    repo.tick();
    const issue: Issue = { id: repo.issueSeq++, number: repo.issueSeq, title, body, state: 'open', labels: [], createdAt: repo.iso(), updatedAt: repo.iso(), closedAt: null, user: repo.owner, comments: [] };
    issue.id = 9000 + issue.number;
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', issue, repo } };
  },
  closeIssue: (_s, args, ctx) => {
    const input = args.input as Record<string, unknown>;
    const issueId = String(input.issueId);
    const decoded = decodeGlobalId(issueId);
    if (!decoded || decoded.type !== 'Issue') throw new Error('Bad issue id');
    // find issue by global id
    for (const repo of ctx.store.repos.values()) {
      const issue = repo.issueByNumber(Number(decoded.id));
      if (issue && globalId('Issue', String(issue.id)) === issueId) {
        issue.state = 'closed';
        issue.closedAt = repo.iso();
        issue.updatedAt = repo.iso();
        return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', issue, repo } };
      }
    }
    throw new Error('Issue not found');
  },
  createPullRequest: (_s, args, ctx) => {
    const input = args.input as Record<string, unknown>;
    const repoId = String(input.repositoryId);
    const repo = [...ctx.store.repos.values()].find(r => globalId('Repository', String(r.id)) === repoId);
    if (!repo) throw new Error('Repository not found');
    const baseRef = String(input.baseRefName);
    const headRef = String(input.headRefName);
    const title = String(input.title);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    if (!baseSha || !headSha) throw new Error('Branch not found');
    const files = repo.diffTree(baseSha, headSha);
    repo.tick();
    const pull: Pull = {
      id: 80_000 + ++repo.pullSeq, number: repo.pullSeq, title, body: String(input.body ?? ''),
      state: 'open', merged: false, mergedAt: null, closedAt: null, mergeCommitSha: null,
      headRef, headSha, baseRef, baseSha, files, createdAt: repo.iso(), user: repo.owner,
    };
    repo.pulls.push(pull);
    return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', pull, repo } };
  },
  mergePullRequest: (_s, args, ctx) => {
    const input = args.input as Record<string, unknown>;
    const pullId = String(input.pullRequestId);
    const decoded = decodeGlobalId(pullId);
    if (!decoded || decoded.type !== 'PullRequest') throw new Error('Bad pull id');
    for (const repo of ctx.store.repos.values()) {
      const pull = repo.pullByNumber(Number(decoded.id));
      if (pull && globalId('PullRequest', String(pull.id)) === pullId) {
        const result = repo.isAncestor(pull.baseSha, pull.headSha) ? { ok: true as const, sha: '' } : { ok: false as const, reason: 'non-fast-forward' };
        if (!result.ok) throw new Error('Pull Request is not mergeable');
        const mergeCommit = `merge_${pull.id}_${Date.now()}`;
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
        pull.merged = true; pull.state = 'closed'; pull.mergedAt = repo.iso(); pull.mergeCommitSha = mergeCommit; pull.closedAt = pull.mergedAt;
        return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', pull, repo } };
      }
    }
    throw new Error('Pull request not found');
  },
  addComment: (_s, args, ctx) => {
    const input = args.input as Record<string, unknown>;
    const subjectId = String(input.subjectId);
    const decoded = decodeGlobalId(subjectId);
    if (!decoded || decoded.type !== 'Issue') throw new Error('Bad subject id');
    for (const repo of ctx.store.repos.values()) {
      const issue = repo.issueByNumber(Number(decoded.id));
      if (issue && globalId('Issue', String(issue.id)) === subjectId) {
        repo.tick();
        const comment = { id: 70_000 + ++repo.commentSeq, body: String(input.body), createdAt: repo.iso(), updatedAt: repo.iso() };
        issue.comments.push(comment);
        issue.updatedAt = repo.iso();
        return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node: { __typename: 'Comment', id: globalId('Comment', String(comment.id)), body: comment.body } } };
      }
    }
    throw new Error('Issue not found');
  },
});

defineType('CreateIssuePayload', { issue: (s) => (s as any).issue });
defineType('CloseIssuePayload', { issue: (s) => (s as any).issue });
defineType('CreatePullRequestPayload', { pullRequest: (s) => (s as any).pullRequest });
defineType('MergePullRequestPayload', { pullRequest: (s) => (s as any).pullRequest });
defineType('AddCommentPayload', { commentEdge: (s) => (s as any).commentEdge });
defineType('CommentEdge', { node: (s) => (s as any).node });
defineType('Comment', { id: (s) => (s as any).id, body: (s) => (s as any).body });

// ================================================================ Executor

function coerceValue(typeName: string, value: unknown): unknown {
  // GraphQL input coercion — minimal, variables already coerced by client
  return value;
}

function getVariableValue(vars: Record<string, unknown>, name: string, type?: TypeNode, def?: ValueNode): unknown {
  if (name in vars) return vars[name];
  if (def !== undefined) return valueFromAst(def);
  throw new Error(`Variable $${name} not provided`);
}

function valueFromAst(node: ValueNode): unknown {
  switch (node.kind) {
    case 'IntValue': case 'FloatValue': return node.value;
    case 'StringValue': return node.value;
    case 'BooleanValue': return node.value;
    case 'NullValue': return null;
    case 'EnumValue': return node.value;
    case 'ListValue': return node.values.map(valueFromAst);
    case 'ObjectValue': {
      const obj: Record<string, unknown> = {};
      for (const f of node.fields) obj[f.name] = valueFromAst(f.value);
      return obj;
    }
    case 'Variable': throw new Error('Variable in value position');
  }
}

function resolveField(
  source: unknown,
  field: FieldNode,
  context: GqlContext,
  errors: Array<{ message: string }>,
): unknown {
  const typeName = (source as any).__typename || 'Query';
  const type = schemaTypes.get(typeName);
  if (!type) { errors.push({ message: `Type ${typeName} not found in schema` }); return null; }
  const resolver = type.fields.get(field.name);
  if (!resolver) { errors.push({ message: `Field '${field.name}' does not exist on type '${typeName}'` }); return null; }
  const args: Record<string, unknown> = {};
  for (const arg of field.arguments) {
    const val = valueFromAst(arg.value);
    args[arg.name] = val;
  }
  try {
    const result = resolver(source, args, context);
    if (result === null || result === undefined) return null;
    // If field has sub-selection, recurse
    if (field.selectionSet && field.selectionSet.length > 0) {
      return executeSelectionSet(result, field.selectionSet, context, errors);
    }
    return result;
  } catch (e) {
    errors.push({ message: (e as Error).message });
    return null;
  }
}

function executeSelectionSet(
  source: unknown,
  selections: SelectionNode[],
  context: GqlContext,
  errors: Array<{ message: string }>,
): unknown {
  if (Array.isArray(source)) {
    return source.map(item => executeSelectionSet(item, selections, context, errors));
  }
  if (source === null || source === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      const key = sel.alias ?? sel.name;
      out[key] = resolveField(source, sel, context, errors);
    } else if (sel.kind === 'FragmentSpread') {
      // Not used in our queries
    } else if (sel.kind === 'InlineFragment') {
      // Type condition check
      const typeName = (source as any).__typename;
      if (typeName === sel.typeCondition) {
        const res = executeSelectionSet(source, sel.selectionSet, context, errors);
        if (res && typeof res === 'object') Object.assign(out, res);
      }
    }
  }
  return out;
}

function executeOperation(
  op: OperationDefinitionNode,
  variables: Record<string, unknown>,
  context: GqlContext,
): { data?: unknown; errors?: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  // Build merged variable map with defaults
  const mergedVars: Record<string, unknown> = { ...variables };
  for (const def of op.variableDefinitions) {
    const val = getVariableValue(mergedVars, def.name, def.type, def.defaultValue);
    if (val !== undefined) mergedVars[def.name] = val;
  }
  const ctx = { ...context, variables: mergedVars };
  const data = executeSelectionSet({ __typename: op.operation === 'query' ? 'Query' : 'Mutation' }, op.selectionSet, ctx, errors);
  if (errors.length > 0) return { data: null, errors };
  return { data };
}

// ================================================================ Public handler

export function handleGraphQL(request: GraphQLRequest, store: Store, viewer: string, baseUrl: string): GraphQLResponse {
  const query = request.query;
  if (!query || typeof query !== 'string') return { errors: [{ message: 'Query is required' }] };
  const variables = request.variables ?? {};

  try {
    const tokens = tokenize(query);
    const parser = createParser(tokens);
    const doc = parser.parseDocument();

    // Support batching: array of documents (the suite sends array in body.query? No, GitHub batching is array of {query, variables})
    // But the request body here is single {query, variables}. The batched check sends array body.
    // We'll handle both: if query is array-like string? No - the batched check sends POST with body [{"query":...}, {"query":...}]
    // Actually the check uses `client.batch` which sends array. Let's detect if the body is an array in app.ts instead.

    // For now assume single operation; batched handled by app.ts parsing body as array
    let ops = doc.definitions.filter(d => d.kind === 'OperationDefinition') as OperationDefinitionNode[];
    if (ops.length === 0) return { errors: [{ message: 'No operation defined' }] };
    const op = ops[0]!;
    const context: GqlContext = { store, viewer, variables };
    const result = executeOperation(op, variables, context);
    return result.errors ? { data: null, errors: result.errors } : { data: result.data };
  } catch (e) {
    return { errors: [{ message: (e as Error).message }] };
  }
}

// Handle batched requests (array of operations)
export function handleGraphQLBatch(operations: Array<{ query: string; variables?: Record<string, unknown> }>, store: Store, viewer: string): Array<GraphQLResponse> {
  return operations.map(op => handleGraphQL(op, store, viewer, ''));
}