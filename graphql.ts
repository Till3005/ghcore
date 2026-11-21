// GitHub GraphQL v4 at /api/graphql. A small document parser plus type-directed executor, with the
// schema surface required by the conformance checks.

import type { Store, Repo, Issue, Pull, PullFile, GitObjectType } from './store.ts';
import { isObjectId } from './store.ts';
import { mergePullRequest } from './rest.ts';

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
}

export interface GraphQLResponse {
  data?: unknown;
  errors?: Array<{ message: string }>;
}

// ---------------------------------------------------------------- Lexer

type LexemeKind =
  | 'STRING' | 'INT' | 'FLOAT' | 'NAME' | 'VARIABLE' | 'PUNCTUATION'
  | 'EOF' | 'SPREAD' | 'ON';

interface Lexeme {
  type: LexemeKind;
  value: string;
  line: number;
  col: number;
}

const RESERVED_WORDS = new Set(['query', 'mutation', 'fragment', 'on', 'true', 'false', 'null']);

function scanTokens(source: string): Lexeme[] {
  const found: Lexeme[] = [];
  let cursor = 0;
  let line = 1;
  let col = 1;
  const look = (offset = 0) => source[cursor + offset];
  const step = (count = 1) => {
    for (let n = 0; n < count; n += 1) {
      if (source[cursor + n] === '\n') {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
    }
    cursor += count;
  };
  const startsName = (ch: string) => /[A-Za-z_]/.test(ch);
  const continuesName = (ch: string) => /[A-Za-z0-9_]/.test(ch);

  while (cursor < source.length) {
    const ch = source[cursor];

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      step();
      continue;
    }
    if (ch === '#') {
      while (cursor < source.length && source[cursor] !== '\n') step();
      continue;
    }
    if (ch === '"') {
      step();
      let value = '';
      const atLine = line;
      const atCol = col;
      while (cursor < source.length && source[cursor] !== '"') {
        if (source[cursor] === '\\') {
          step();
          const escaped = look();
          if (escaped === 'n') value += '\n';
          else if (escaped === 't') value += '\t';
          else if (escaped === 'r') value += '\r';
          else if (escaped === '"') value += '"';
          else if (escaped === '\\') value += '\\';
          else value += escaped;
          step();
        } else {
          value += source[cursor];
          step();
        }
      }
      step();
      found.push({ type: 'STRING', value, line: atLine, col: atCol });
      continue;
    }
    if (ch === '$') {
      step();
      let value = '';
      const atLine = line;
      const atCol = col;
      while (continuesName(look())) {
        value += look();
        step();
      }
      found.push({ type: 'VARIABLE', value, line: atLine, col: atCol });
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const atLine = line;
      const atCol = col;
      let value = '';
      let fractional = false;
      if (ch === '-') {
        value += '-';
        step();
      }
      while (cursor < source.length && source[cursor] >= '0' && source[cursor] <= '9') {
        value += source[cursor];
        step();
      }
      if (look() === '.') {
        fractional = true;
        value += '.';
        step();
        while (cursor < source.length && source[cursor] >= '0' && source[cursor] <= '9') {
          value += source[cursor];
          step();
        }
      }
      found.push({ type: fractional ? 'FLOAT' : 'INT', value, line: atLine, col: atCol });
      continue;
    }
    if (startsName(ch)) {
      const atLine = line;
      const atCol = col;
      let value = '';
      while (continuesName(look())) {
        value += look();
        step();
      }
      found.push({ type: RESERVED_WORDS.has(value) ? 'NAME' : 'NAME', value, line: atLine, col: atCol });
      continue;
    }
    if (ch === '.' && look(1) === '.' && look(2) === '.') {
      const atLine = line;
      const atCol = col;
      step(3);
      found.push({ type: 'SPREAD', value: '...', line: atLine, col: atCol });
      continue;
    }
    if (':!()[]{},=@|&'.includes(ch)) {
      const atLine = line;
      const atCol = col;
      step();
      found.push({ type: 'PUNCTUATION', value: ch, line: atLine, col: atCol });
      continue;
    }
    throw new Error(`Unexpected character ${ch} at ${line}:${col}`);
  }

  found.push({ type: 'EOF', value: '', line, col });
  return found;
}

// ---------------------------------------------------------------- AST shapes

type DefinitionAst = OperationAst | FragmentAst;
type SelectionAst = FieldAst | SpreadAst | InlineFragmentAst;

interface DocumentAst { kind: 'Document'; definitions: DefinitionAst[] }
interface OperationAst {
  kind: 'OperationDefinition';
  operation: 'query' | 'mutation';
  name?: string;
  variableDefinitions: VariableAst[];
  directives: DirectiveAst[];
  selectionSet: SelectionAst[];
}
interface FragmentAst {
  kind: 'FragmentDefinition';
  name: string;
  typeCondition: string;
  directives: DirectiveAst[];
  selectionSet: SelectionAst[];
}
interface FieldAst {
  kind: 'Field';
  alias?: string;
  name: string;
  arguments: ArgumentAst[];
  directives: DirectiveAst[];
  selectionSet?: SelectionAst[];
}
interface ArgumentAst { kind: 'Argument'; name: string; value: ValueAst }
interface VariableAst {
  kind: 'VariableDefinition';
  name: string;
  type: TypeAst;
  defaultValue?: ValueAst;
  directives: DirectiveAst[];
}
interface DirectiveAst { kind: 'Directive'; name: string; arguments: ArgumentAst[] }
interface SpreadAst { kind: 'FragmentSpread'; name: string; directives: DirectiveAst[] }
interface InlineFragmentAst {
  kind: 'InlineFragment';
  typeCondition: string;
  directives: DirectiveAst[];
  selectionSet: SelectionAst[];
}
type TypeAst =
  | { kind: 'NamedType'; name: string }
  | { kind: 'ListType'; type: TypeAst }
  | { kind: 'NonNullType'; type: TypeAst };
type ValueAst =
  | { kind: 'Variable'; name: string }
  | { kind: 'IntValue'; value: number }
  | { kind: 'FloatValue'; value: number }
  | { kind: 'StringValue'; value: string }
  | { kind: 'BooleanValue'; value: boolean }
  | { kind: 'NullValue' }
  | { kind: 'EnumValue'; value: string }
  | { kind: 'ListValue'; values: ValueAst[] }
  | { kind: 'ObjectValue'; fields: ObjectFieldAst[] };
interface ObjectFieldAst { kind: 'ObjectField'; name: string; value: ValueAst }

// ---------------------------------------------------------------- Parser

interface DocumentParser {
  tokens: Lexeme[];
  pos: number;
  peek(n?: number): Lexeme;
  eat(type: LexemeKind, value?: string): Lexeme;
  expect(type: LexemeKind, value?: string): Lexeme;
  parseDocument(): DocumentAst;
  parseOperation(): OperationAst;
  parseSelectionSet(): SelectionAst[];
  parseField(): FieldAst;
  parseArguments(): ArgumentAst[];
  parseArgument(): ArgumentAst;
  parseValue(): ValueAst;
  parseVariableDefinitions(): VariableAst[];
  parseVariableDefinition(): VariableAst;
  parseType(): TypeAst;
  parseDirectives(): DirectiveAst[];
  parseFragmentSpread(): SpreadAst;
  parseInlineFragment(): InlineFragmentAst;
}

function makeParser(tokens: Lexeme[]): DocumentParser {
  let cursor = 0;
  const peek = (offset = 0): Lexeme => tokens[cursor + offset] ?? { type: 'EOF', value: '', line: 0, col: 0 };
  const eat = (type: LexemeKind, expected?: string): Lexeme => {
    const current = peek();
    if (current.type !== type || (expected !== undefined && current.value !== expected)) {
      throw new Error(`Expected ${type}${expected ? ' ' + expected : ''} at ${current.line}:${current.col}, got ${current.type} ${current.value}`);
    }
    cursor += 1;
    return current;
  };
  const expect = eat;

  const parseType = (): TypeAst => {
    let parsed: TypeAst;
    if (peek().type === 'PUNCTUATION' && peek().value === '[') {
      eat('PUNCTUATION', '[');
      const inner = parseType();
      eat('PUNCTUATION', ']');
      parsed = { kind: 'ListType', type: inner };
    } else {
      parsed = { kind: 'NamedType', name: expect('NAME').value };
    }
    if (peek().type === 'PUNCTUATION' && peek().value === '!') {
      eat('PUNCTUATION', '!');
      parsed = { kind: 'NonNullType', type: parsed };
    }
    return parsed;
  };

  const parseValue = (): ValueAst => {
    const current = peek();
    if (current.type === 'VARIABLE') {
      eat('VARIABLE');
      return { kind: 'Variable', name: current.value };
    }
    if (current.type === 'INT') {
      eat('INT');
      return { kind: 'IntValue', value: Number(current.value) };
    }
    if (current.type === 'FLOAT') {
      eat('FLOAT');
      return { kind: 'FloatValue', value: Number(current.value) };
    }
    if (current.type === 'STRING') {
      eat('STRING');
      return { kind: 'StringValue', value: current.value };
    }
    if (current.type === 'NAME') {
      if (current.value === 'true' || current.value === 'false') {
        eat('NAME');
        return { kind: 'BooleanValue', value: current.value === 'true' };
      }
      if (current.value === 'null') {
        eat('NAME');
        return { kind: 'NullValue' };
      }
      eat('NAME');
      return { kind: 'EnumValue', value: current.value };
    }
    if (current.type === 'PUNCTUATION' && current.value === '[') {
      eat('PUNCTUATION', '[');
      const members: ValueAst[] = [];
      while (peek().type !== 'PUNCTUATION' || peek().value !== ']') {
        if (peek().type === 'PUNCTUATION' && peek().value === ',') {
          eat('PUNCTUATION', ',');
          continue;
        }
        members.push(parseValue());
      }
      eat('PUNCTUATION', ']');
      return { kind: 'ListValue', values: members };
    }
    if (current.type === 'PUNCTUATION' && current.value === '{') {
      eat('PUNCTUATION', '{');
      const members: ObjectFieldAst[] = [];
      while (peek().type !== 'PUNCTUATION' || peek().value !== '}') {
        if (peek().type === 'PUNCTUATION' && peek().value === ',') {
          eat('PUNCTUATION', ',');
          continue;
        }
        const key = expect('NAME').value;
        eat('PUNCTUATION', ':');
        members.push({ kind: 'ObjectField', name: key, value: parseValue() });
      }
      eat('PUNCTUATION', '}');
      return { kind: 'ObjectValue', fields: members };
    }
    throw new Error(`Unexpected value token ${current.type} ${current.value} at ${current.line}:${current.col}`);
  };

  const parseArgument = (): ArgumentAst => {
    const key = expect('NAME').value;
    eat('PUNCTUATION', ':');
    return { kind: 'Argument', name: key, value: parseValue() };
  };

  const dropCommas = (): void => {
    while (peek().type === 'PUNCTUATION' && peek().value === ',') cursor += 1;
  };

  const parseArguments = (): ArgumentAst[] => {
    if (peek().type !== 'PUNCTUATION' || peek().value !== '(') return [];
    eat('PUNCTUATION', '(');
    const argumentsFound: ArgumentAst[] = [];
    for (dropCommas(); !(peek().type === 'PUNCTUATION' && peek().value === ')'); dropCommas()) {
      argumentsFound.push(parseArgument());
    }
    eat('PUNCTUATION', ')');
    return argumentsFound;
  };

  const parseDirective = (): DirectiveAst => {
    eat('PUNCTUATION', '@');
    return { kind: 'Directive', name: expect('NAME').value, arguments: parseArguments() };
  };

  const parseDirectives = (): DirectiveAst[] => {
    const directives: DirectiveAst[] = [];
    while (peek().type === 'PUNCTUATION' && peek().value === '@') directives.push(parseDirective());
    return directives;
  };

  const parseField = (): FieldAst => {
    let alias: string | undefined;
    let name = expect('NAME').value;
    if (peek().type === 'PUNCTUATION' && peek().value === ':') {
      eat('PUNCTUATION', ':');
      alias = name;
      name = expect('NAME').value;
    }
    const args = parseArguments();
    const directives = parseDirectives();
    let selectionSet: SelectionAst[] | undefined;
    if (peek().type === 'PUNCTUATION' && peek().value === '{') {
      eat('PUNCTUATION', '{');
      selectionSet = parseSelectionSet();
      eat('PUNCTUATION', '}');
    }
    return { kind: 'Field', alias, name, arguments: args, directives, selectionSet };
  };

  const parseSelectionSet = (): SelectionAst[] => {
    const selections: SelectionAst[] = [];
    while (peek().type !== 'PUNCTUATION' || peek().value !== '}') {
      if (peek().type === 'PUNCTUATION' && peek().value === ',') {
        eat('PUNCTUATION', ',');
        continue;
      }
      if (peek().type === 'SPREAD') {
        const following = peek(1);
        if (following.type === 'NAME' && following.value === 'on') selections.push(parseInlineFragment());
        else selections.push(parseFragmentSpread());
      } else {
        selections.push(parseField());
      }
    }
    return selections;
  };

  const parseFragmentSpread = (): SpreadAst => {
    eat('SPREAD');
    return { kind: 'FragmentSpread', name: expect('NAME').value, directives: parseDirectives() };
  };

  const parseInlineFragment = (): InlineFragmentAst => {
    eat('SPREAD');
    eat('NAME', 'on');
    const typeCondition = expect('NAME').value;
    eat('PUNCTUATION', '{');
    const selectionSet = parseSelectionSet();
    eat('PUNCTUATION', '}');
    return { kind: 'InlineFragment', typeCondition, directives: parseDirectives(), selectionSet };
  };

  const parseVariableDefinition = (): VariableAst => {
    const name = expect('VARIABLE').value;
    eat('PUNCTUATION', ':');
    const type = parseType();
    let defaultValue: ValueAst | undefined;
    if (peek().type === 'PUNCTUATION' && peek().value === '=') {
      eat('PUNCTUATION', '=');
      defaultValue = parseValue();
    }
    return { kind: 'VariableDefinition', name, type, defaultValue, directives: [] };
  };

  const parseVariableDefinitions = (): VariableAst[] => {
    if (peek().type !== 'PUNCTUATION' || peek().value !== '(') return [];
    eat('PUNCTUATION', '(');
    const declarations: VariableAst[] = [];
    while (peek().type !== 'PUNCTUATION' || peek().value !== ')') {
      if (peek().type === 'PUNCTUATION' && peek().value === ',') {
        eat('PUNCTUATION', ',');
        continue;
      }
      declarations.push(parseVariableDefinition());
    }
    eat('PUNCTUATION', ')');
    return declarations;
  };

  const parseOperation = (): OperationAst => {
    let operation: OperationAst['operation'] = 'query';
    if (peek().type === 'NAME' && (peek().value === 'query' || peek().value === 'mutation')) {
      operation = eat('NAME').value as OperationAst['operation'];
    }
    let name: string | undefined;
    if (peek().type === 'NAME' && !['query', 'mutation', 'fragment', 'on'].includes(peek().value)) {
      name = eat('NAME').value;
    }
    const variableDefinitions = parseVariableDefinitions();
    const directives = parseDirectives();
    eat('PUNCTUATION', '{');
    const selectionSet = parseSelectionSet();
    eat('PUNCTUATION', '}');
    return { kind: 'OperationDefinition', operation, name, variableDefinitions, directives, selectionSet };
  };

  const parseFragmentDefinition = (): FragmentAst => {
    eat('NAME', 'fragment');
    const name = expect('NAME').value;
    eat('NAME', 'on');
    const typeCondition = expect('NAME').value;
    const directives = parseDirectives();
    eat('PUNCTUATION', '{');
    const selectionSet = parseSelectionSet();
    eat('PUNCTUATION', '}');
    return { kind: 'FragmentDefinition', name, typeCondition, directives, selectionSet };
  };

  const parseDocument = (): DocumentAst => {
    const definitions: DefinitionAst[] = [];
    while (peek().type !== 'EOF') {
      if (peek().type === 'NAME' && peek().value === 'fragment') definitions.push(parseFragmentDefinition());
      else definitions.push(parseOperation());
    }
    return { kind: 'Document', definitions };
  };

  return {
    tokens, pos: cursor, peek, eat, expect,
    parseDocument, parseOperation, parseSelectionSet, parseField,
    parseArguments, parseArgument, parseValue, parseVariableDefinitions, parseVariableDefinition, parseType,
    parseDirectives, parseFragmentSpread, parseInlineFragment,
  };
}

// ---------------------------------------------------------------- Schema registration

interface SchemaType {
  name: string;
  fields: Map<string, FieldResolver>;
}

type FieldResolver = (source: unknown, args: Record<string, unknown>, context: ExecContext) => unknown;

interface ExecContext {
  store: Store;
  viewer: string;
  variables: Record<string, unknown>;
}

function encodeGlobalId(type: string, id: string | number): string {
  return `gid://entry-forge/${type}/${id}`;
}

function parseGlobalId(gid: string): { type: string; id: string } | null {
  const matched = gid.match(/^gid:\/\/entry-forge\/([^/]+)\/(.+)$/);
  return matched ? { type: matched[1], id: matched[2] } : null;
}

const typeRegistry = new Map<string, SchemaType>();
const enumRegistry = new Map<string, string[]>();

function registerType(name: string, fields: Record<string, FieldResolver>): void {
  typeRegistry.set(name, { name, fields: new Map(Object.entries(fields)) });
}

function registerEnum(name: string, members: readonly string[]): void {
  enumRegistry.set(name, [...members]);
}

const ISSUE_STATES = { OPEN: 'OPEN', CLOSED: 'CLOSED' } as const;
const PULL_STATES = { OPEN: 'OPEN', CLOSED: 'CLOSED', MERGED: 'MERGED' } as const;
const MERGE_STATES = { MERGEABLE: 'MERGEABLE', CONFLICTING: 'CONFLICTING', UNKNOWN: 'UNKNOWN' } as const;
const MERGE_METHODS = { MERGE: 'MERGE', SQUASH: 'SQUASH', REBASE: 'REBASE' } as const;
const PERMISSIONS = { ADMIN: 'ADMIN', MAINTAIN: 'MAINTAIN', WRITE: 'WRITE', TRIAGE: 'TRIAGE', READ: 'READ' } as const;
const SEARCH_KINDS = { ISSUE: 'ISSUE', REPOSITORY: 'REPOSITORY', USER: 'USER', TOPIC: 'TOPIC', CODE: 'CODE', COMMIT: 'COMMIT', MARKETPLACE: 'MARKETPLACE', LABEL: 'LABEL', MILESTONE: 'MILESTONE', PACKAGE: 'PACKAGE', DISCUSSION: 'DISCUSSION' } as const;
const ISSUE_SORT_FIELDS = { CREATED_AT: 'CREATED_AT', UPDATED_AT: 'UPDATED_AT', COMMENTS: 'COMMENTS' } as const;
const SORT_DIRECTIONS = { ASC: 'ASC', DESC: 'DESC' } as const;

registerType('Query', {
  viewer: (_source, _args, ctx) => ({ __typename: 'User', login: ctx.viewer, id: encodeGlobalId('User', 1001) }),
  repository: (_source, args, ctx) => {
    const owner = String(args.owner);
    const name = String(args.name);
    const repo = ctx.store.get(owner, name);
    return repo ? { __typename: 'Repository', repo } : null;
  },
  node: (_source, args, ctx) => {
    const decoded = parseGlobalId(String(args.id));
    if (!decoded) return null;
    if (decoded.type === 'Repository') {
      const match = [...ctx.store.repos.values()].find(candidate => encodeGlobalId('Repository', String(candidate.id)) === args.id);
      return match ? { __typename: 'Repository', repo: match } : null;
    }
    return null;
  },
  __type: (_source, args) => {
    const name = String(args.name);
    const objectType = typeRegistry.get(name);
    if (objectType) return { __typename: '__Type', type: objectType };
    const members = enumRegistry.get(name);
    if (members) return { __typename: '__Type', enumTypeName: name, enumValuesList: members };
    return null;
  },
});

registerType('User', {
  login: (source) => (source as any).login,
  id: (source) => (source as any).id,
});

registerType('Repository', {
  id: (source) => encodeGlobalId('Repository', String((source as any).repo.id)),
  databaseId: (source) => (source as any).repo.id,
  name: (source) => (source as any).repo.name,
  nameWithOwner: (source) => `${(source as any).repo.owner}/${(source as any).repo.name}`,
  owner: (source) => ({ __typename: 'User', login: (source as any).repo.owner, id: encodeGlobalId('User', 1001) }),
  defaultBranchRef: (source) => {
    const repo = (source as any).repo as Repo;
    if (!repo.refs.has(repo.headRefName())) return null;
    return { __typename: 'Ref', name: repo.defaultBranch };
  },
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  issue: (source, args) => {
    const repo = (source as any).repo as Repo;
    const issue = repo.issueByNumber(Number(args.number));
    return issue ? { __typename: 'Issue', issue, repo } : null;
  },
  issues: (source, args) => {
    const repo = (source as any).repo as Repo;
    let matching = [...repo.issues];
    const wantedStates = (args.states as string[]) ?? ['OPEN'];
    if (!wantedStates.includes('ALL')) {
      matching = matching.filter(issue => wantedStates.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
    }
    const orderBy = args.orderBy as { field: string; direction: string } | undefined;
    const sortField = orderBy?.field ?? 'CREATED_AT';
    const direction = orderBy?.direction ?? 'ASC';
    matching.sort((left, right) => {
      const leftKey = sortField === 'UPDATED_AT' ? left.updatedAt : sortField === 'COMMENTS' ? String(left.comments.length) : left.createdAt;
      const rightKey = sortField === 'UPDATED_AT' ? right.updatedAt : sortField === 'COMMENTS' ? String(right.comments.length) : right.createdAt;
      if (direction === 'ASC') return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : left.number - right.number;
      return leftKey > rightKey ? -1 : leftKey < rightKey ? 1 : right.number - left.number;
    });
    const after = args.after as string | undefined;
    const first = Number(args.first ?? 100);
    let offset = 0;
    if (after) {
      const position = matching.findIndex(issue => String(issue.number) === after);
      if (position >= 0) offset = position + 1;
    }
    const page = matching.slice(offset, offset + first);
    return {
      __typename: 'IssueConnection',
      nodes: page.map(issue => ({ __typename: 'Issue', issue, repo })),
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage: offset + first < matching.length,
        endCursor: page.length ? String(page[page.length - 1].number) : null,
      },
    };
  },
  pullRequests: (source, args) => {
    const repo = (source as any).repo as Repo;
    const first = Number(args.first ?? 100);
    return {
      __typename: 'PullRequestConnection',
      nodes: repo.pulls.slice(0, first).map(pull => ({ __typename: 'PullRequest', pull, repo })),
    };
  },
  pullRequest: (source, args) => {
    const repo = (source as any).repo as Repo;
    const pull = repo.pullByNumber(Number(args.number));
    return pull ? { __typename: 'PullRequest', pull, repo } : null;
  },
});

registerType('Issue', {
  id: (source) => encodeGlobalId('Issue', String((source as any).issue.id)),
  number: (source) => (source as any).issue.number,
  title: (source) => (source as any).issue.title,
  state: (source) => ((source as any).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
  body: (source) => (source as any).issue.body,
});

registerType('IssueConnection', {
  nodes: (source) => (source as any).nodes,
  pageInfo: (source) => (source as any).pageInfo,
});

registerType('PageInfo', {
  hasNextPage: (source) => (source as any).hasNextPage,
  endCursor: (source) => (source as any).endCursor,
});

registerType('PullRequest', {
  id: (source) => encodeGlobalId('PullRequest', String((source as any).pull.id)),
  number: (source) => (source as any).pull.number,
  state: (source) => {
    const pull = (source as any).pull as Pull;
    if (pull.merged) return 'MERGED';
    return pull.state === 'open' ? 'OPEN' : 'CLOSED';
  },
  merged: (source) => (source as any).pull.merged,
  headRefName: (source) => (source as any).pull.headRef,
  baseRefName: (source) => (source as any).pull.baseRef,
  mergeable: (source) => {
    const pull = (source as any).pull as Pull;
    const repo = (source as any).repo as Repo;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    if (!baseTip || !headTip) return 'UNKNOWN';
    return repo.isAncestor(baseTip, headTip) ? 'MERGEABLE' : 'CONFLICTING';
  },
  files: (source, args) => {
    const pull = (source as any).pull as Pull;
    const first = Number(args.first ?? 100);
    return {
      __typename: 'PullRequestFileConnection',
      nodes: pull.files.slice(0, first).map((file: PullFile) => ({ __typename: 'PullRequestChangedFile', path: file.filename })),
    };
  },
});

registerType('PullRequestFileConnection', { nodes: (source) => (source as any).nodes });
registerType('PullRequestChangedFile', { path: (source) => (source as any).path });
registerType('PullRequestConnection', { nodes: (source) => (source as any).nodes });
registerType('Ref', { name: (source) => (source as any).name });

registerType('__Type', {
  name: (source) => (source as any).type?.name ?? (source as any).enumTypeName ?? null,
  fields: (source) => {
    const objectType = (source as any).type as SchemaType | undefined;
    if (!objectType) return [];
    return [...objectType.fields.keys()].map(fieldName => ({ __typename: '__Field', name: fieldName }));
  },
  enumValues: (source) => {
    const names = (source as any).enumValuesList as string[] | undefined;
    if (names) return names.map(name => ({ __typename: '__EnumValue', name }));
    const objectType = (source as any).type as SchemaType | undefined;
    if (!objectType) return [];
    return (enumRegistry.get(objectType.name) ?? []).map(name => ({ __typename: '__EnumValue', name }));
  },
});

registerType('__Field', { name: (source) => (source as any).name });
registerType('__EnumValue', { name: (source) => (source as any).name });

registerType('Mutation', {
  createIssue: (_source, args, ctx) => {
    const input = args.input as Record<string, unknown>;
    const repositoryId = String(input.repositoryId);
    const repo = [...ctx.store.repos.values()].find(candidate => encodeGlobalId('Repository', String(candidate.id)) === repositoryId);
    if (!repo) throw new Error('Repository not found');
    const title = String(input.title);
    const body = String(input.body ?? '');
    repo.tick();
    const issue: Issue = {
      id: repo.issueSeq++, number: repo.issueSeq, title, body, state: 'open', labels: [],
      createdAt: repo.iso(), updatedAt: repo.iso(), closedAt: null, user: repo.owner, comments: [],
    };
    issue.id = 9000 + issue.number;
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', issue, repo } };
  },
  closeIssue: (_source, args, ctx) => {
    const input = args.input as Record<string, unknown>;
    const issueId = String(input.issueId);
    const decoded = parseGlobalId(issueId);
    if (!decoded || decoded.type !== 'Issue') throw new Error('Bad issue id');
    for (const repo of ctx.store.repos.values()) {
      const issue = repo.issues.find(candidate => String(candidate.id) === decoded.id);
      if (issue && encodeGlobalId('Issue', String(issue.id)) === issueId) {
        issue.state = 'closed';
        issue.closedAt = repo.iso();
        issue.updatedAt = repo.iso();
        return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', issue, repo } };
      }
    }
    throw new Error('Issue not found');
  },
  createPullRequest: (_source, args, ctx) => {
    const input = args.input as Record<string, unknown>;
    const repositoryId = String(input.repositoryId);
    const repo = [...ctx.store.repos.values()].find(candidate => encodeGlobalId('Repository', String(candidate.id)) === repositoryId);
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
  mergePullRequest: (_source, args, ctx) => {
    const input = args.input as Record<string, unknown>;
    const pullId = String(input.pullRequestId);
    const decoded = parseGlobalId(pullId);
    if (!decoded || decoded.type !== 'PullRequest') throw new Error('Bad pull id');
    for (const repo of ctx.store.repos.values()) {
      const pull = repo.pulls.find(candidate => String(candidate.id) === decoded.id);
      if (pull && encodeGlobalId('PullRequest', String(pull.id)) === pullId) {
        const outcome = mergePullRequest(repo, pull);
        if (!outcome.ok) throw new Error(outcome.message);
        return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', pull, repo } };
      }
    }
    throw new Error('Pull request not found');
  },
  addComment: (_source, args, ctx) => {
    const input = args.input as Record<string, unknown>;
    const subjectId = String(input.subjectId);
    const decoded = parseGlobalId(subjectId);
    if (!decoded || decoded.type !== 'Issue') throw new Error('Bad subject id');
    for (const repo of ctx.store.repos.values()) {
      const issue = repo.issues.find(candidate => String(candidate.id) === decoded.id);
      if (issue && encodeGlobalId('Issue', String(issue.id)) === subjectId) {
        repo.tick();
        const comment = {
          id: 70_000 + ++repo.commentSeq, body: String(input.body), createdAt: repo.iso(), updatedAt: repo.iso(),
        };
        issue.comments.push(comment);
        issue.updatedAt = repo.iso();
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'CommentEdge',
            node: { __typename: 'Comment', id: encodeGlobalId('Comment', String(comment.id)), body: comment.body },
          },
        };
      }
    }
    throw new Error('Issue not found');
  },
});

registerType('CreateIssuePayload', { issue: (source) => (source as any).issue });
registerType('CloseIssuePayload', { issue: (source) => (source as any).issue });
registerType('CreatePullRequestPayload', { pullRequest: (source) => (source as any).pullRequest });
registerType('MergePullRequestPayload', { pullRequest: (source) => (source as any).pullRequest });
registerType('AddCommentPayload', { commentEdge: (source) => (source as any).commentEdge });
registerType('CommentEdge', { node: (source) => (source as any).node });
registerType('Comment', { id: (source) => (source as any).id, body: (source) => (source as any).body });

registerEnum('SearchType', Object.values(SEARCH_KINDS));
registerEnum('IssueState', Object.values(ISSUE_STATES));
registerEnum('PullRequestState', Object.values(PULL_STATES));
registerEnum('MergeableState', Object.values(MERGE_STATES));
registerEnum('PullRequestMergeMethod', Object.values(MERGE_METHODS));
registerEnum('RepositoryPermission', Object.values(PERMISSIONS));
registerEnum('IssueOrderField', Object.values(ISSUE_SORT_FIELDS));
registerEnum('OrderDirection', Object.values(SORT_DIRECTIONS));

// ---------------------------------------------------------------- Executor

function coerceAstValue(node: ValueAst, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'IntValue':
    case 'FloatValue':
      return node.value;
    case 'StringValue':
      return node.value;
    case 'BooleanValue':
      return node.value;
    case 'NullValue':
      return null;
    case 'EnumValue':
      return node.value;
    case 'Variable':
      return Object.prototype.hasOwnProperty.call(variables, node.name) ? variables[node.name] : undefined;
    case 'ListValue':
      return node.values.map(entry => coerceAstValue(entry, variables));
    case 'ObjectValue': {
      const object: Record<string, unknown> = {};
      for (const field of node.fields) object[field.name] = coerceAstValue(field.value, variables);
      return object;
    }
  }
}

function evaluateField(
  source: unknown,
  field: FieldAst,
  context: ExecContext,
  problems: Array<{ message: string }>,
): unknown {
  const typeName = (source as any).__typename || 'Query';
  const registered = typeRegistry.get(typeName);
  if (!registered) {
    problems.push({ message: `Type ${typeName} not found in schema` });
    return null;
  }
  const resolver = registered.fields.get(field.name);
  if (!resolver) {
    problems.push({ message: `Field '${field.name}' does not exist on type '${typeName}'` });
    return null;
  }
  const args: Record<string, unknown> = {};
  for (const argument of field.arguments) {
    const resolved = coerceAstValue(argument.value, context.variables);
    if (resolved !== undefined) args[argument.name] = resolved;
  }
  try {
    const value = resolver(source, args, context);
    if (value === null || value === undefined) return null;
    if (field.selectionSet && field.selectionSet.length > 0) {
      return runSelectionSet(value, field.selectionSet, context, problems);
    }
    return value;
  } catch (problem) {
    problems.push({ message: (problem as Error).message });
    return null;
  }
}

function runSelectionSet(
  source: unknown,
  selections: SelectionAst[],
  context: ExecContext,
  problems: Array<{ message: string }>,
): unknown {
  if (Array.isArray(source)) {
    return source.map(item => runSelectionSet(item, selections, context, problems));
  }
  if (source === null || source === undefined) return null;
  const result: Record<string, unknown> = {};
  for (const chosen of selections) {
    if (chosen.kind === 'Field') {
      const key = chosen.alias ?? chosen.name;
      result[key] = evaluateField(source, chosen, context, problems);
    } else if (chosen.kind === 'InlineFragment') {
      const typeName = (source as any).__typename;
      if (typeName === chosen.typeCondition) {
        const expanded = runSelectionSet(source, chosen.selectionSet, context, problems);
        if (expanded && typeof expanded === 'object') Object.assign(result, expanded);
      }
    }
  }
  return result;
}

function runOperation(
  operation: OperationAst,
  supplied: Record<string, unknown>,
  context: ExecContext,
): { data?: unknown; errors?: Array<{ message: string }> } {
  const problems: Array<{ message: string }> = [];
  const mergedVariables: Record<string, unknown> = { ...supplied };
  for (const definition of operation.variableDefinitions) {
    if (!(definition.name in mergedVariables) && definition.defaultValue !== undefined) {
      mergedVariables[definition.name] = coerceAstValue(definition.defaultValue, mergedVariables);
    }
  }
  const executionContext: ExecContext = { ...context, variables: mergedVariables };
  const root = { __typename: operation.operation === 'query' ? 'Query' : 'Mutation' };
  const data = runSelectionSet(root, operation.selectionSet, executionContext, problems);
  if (problems.length > 0) return { data: null, errors: problems };
  return { data };
}

// ---------------------------------------------------------------- Public handler

export function handleGraphQL(request: GraphQLRequest, store: Store, viewer: string, baseUrl: string): GraphQLResponse {
  const query = request.query;
  if (!query || typeof query !== 'string') return { errors: [{ message: 'Query is required' }] };
  const variables = request.variables ?? {};

  try {
    const document = makeParser(scanTokens(query)).parseDocument();
    const operations = document.definitions.filter(entry => entry.kind === 'OperationDefinition') as OperationAst[];
    if (operations.length === 0) return { errors: [{ message: 'No operation defined' }] };
    const result = runOperation(operations[0]!, variables, { store, viewer, variables });
    return result.errors ? { data: null, errors: result.errors } : { data: result.data };
  } catch (problem) {
    return { errors: [{ message: (problem as Error).message }] };
  }
}

// An array body means several independent operations; each gets its own response slot.
export function handleGraphQLBatch(operations: Array<{ query: string; variables?: Record<string, unknown> }>, store: Store, viewer: string): Array<GraphQLResponse> {
  return operations.map(entry => handleGraphQL(entry, store, viewer, ''));
}
