// In-memory forge state: repositories, refs, git objects, issues, labels, comments and pulls,
// with the commit machinery used by the REST contents API and the merge path.
//
// A trial is one fresh process, so nothing is persisted. Object ids are genuine git SHA-1 ids:
// objects written through REST read back over smart HTTP and vice versa.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export const ZERO_OID = '0'.repeat(40);
const OID_PATTERN = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return OID_PATTERN.test(value);
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const digester = createHash('sha1');
  digester.update(Buffer.from(`${type} ${bytes.length}\u0000`, 'utf8'));
  digester.update(bytes);
  return digester.digest('hex');
}

/** Inflate the zlib stream at `offset`, returning its bytes and the first byte after the stream. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const stream = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: stream.buffer, next: offset + stream.engine.bytesWritten };
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const parsed: TreeEntry[] = [];
  let at = 0;
  while (at < bytes.length) {
    const spaceAt = bytes.indexOf(0x20, at);
    if (spaceAt < 0) throw new Error('tree entry has no mode separator');
    const nulAt = bytes.indexOf(0x00, spaceAt + 1);
    if (nulAt < 0 || nulAt + 21 > bytes.length) throw new Error('tree entry truncated');
    parsed.push({
      mode: bytes.subarray(at, spaceAt).toString('ascii'),
      name: bytes.subarray(spaceAt + 1, nulAt).toString('utf8'),
      oid: bytes.subarray(nulAt + 1, nulAt + 21).toString('hex'),
    });
    at = nulAt + 21;
  }
  return parsed;
}

// Directories sort as though their names ended with a slash, matching git's tree ordering.
function treeOrder(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const ordered = [...entries].sort(treeOrder);
  const chunks: Buffer[] = [];
  for (const item of ordered) {
    chunks.push(Buffer.from(`${item.mode} ${item.name}\u0000`, 'utf8'));
    chunks.push(Buffer.from(item.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const breakAt = bytes.indexOf('\n\n');
  const headerEnd = breakAt < 0 ? bytes.length : breakAt;
  const message = breakAt < 0 ? '' : bytes.subarray(breakAt + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const row of bytes.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!row) continue;
    const splitAt = row.indexOf(' ');
    const field = splitAt < 0 ? row : row.slice(0, splitAt);
    const value = splitAt < 0 ? '' : row.slice(splitAt + 1);
    if (field === 'tree') tree = value;
    else if (field === 'parent') parents.push(value);
    else if (field === 'author') author = value;
    else if (field === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Uint8Array): { object: string; type: string; tag: string } {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const breakAt = bytes.indexOf('\n\n');
  const headerLines = bytes.subarray(0, breakAt < 0 ? bytes.length : breakAt).toString('utf8').split('\n');
  const fields = new Map<string, string>();
  for (const row of headerLines) {
    if (!row) continue;
    const splitAt = row.indexOf(' ');
    if (splitAt < 0) continue;
    fields.set(row.slice(0, splitAt), row.slice(splitAt + 1));
  }
  return {
    object: fields.get('object') ?? '',
    type: fields.get('type') ?? '',
    tag: fields.get('tag') ?? '',
  };
}

export const COMMIT_IDENTITY = 'entry-forge <forge@entry.invalid>';

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  timestamp?: number;
}): Buffer {
  const moment = fields.timestamp ?? 1_700_000_000;
  const signature = `${fields.author ?? COMMIT_IDENTITY} ${moment} +0000`;
  const rows = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) rows.push(`parent ${parent}`);
  rows.push(`author ${signature}`, `committer ${signature}`, '');
  return Buffer.from(`${rows.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------- pack codec

const TYPE_TO_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_TO_CODE[type];
  const bytes: number[] = [];
  let rest = size;
  let current = (code << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(current | 0x80);
    current = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

/** Pack plain objects with no deltas; the trailer is SHA-1 of all preceding bytes. */
export function writePack(objects: Iterable<{ type: GitObjectType; data: Uint8Array }>): Buffer {
  const pieces: Buffer[] = [];
  const list = [...objects];
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  pieces.push(head);
  for (const object of list) {
    const bytes = Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
    pieces.push(packHeader(object.type, bytes.length));
    pieces.push(deflateSync(bytes));
  }
  const body = Buffer.concat(pieces);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

interface PackedEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: GitObjectType;
  resolved?: Buffer;
  oid?: string;
}

function decodeSizeHeader(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let at = start + 1;
  while (byte & 0x80) {
    byte = buf[at++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: at, first };
}

function decodeOfsDistance(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start]!;
  let at = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[at++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: at };
}

function patchWithDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const output = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (at < delta.length) {
    const opcode = delta[at++]!;
    if (opcode & 0x80) {
      let copyFrom = 0;
      let copyLength = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (opcode & (1 << bit)) copyFrom += delta[at++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (opcode & (1 << bit)) copyLength += delta[at++]! * 2 ** shift;
        shift += 8;
      }
      if (copyLength === 0) copyLength = 0x10000;
      base.copy(output, written, copyFrom, copyFrom + copyLength);
      written += copyLength;
    } else if (opcode !== 0) {
      const literalLength = opcode & 0x7f;
      delta.copy(output, written, at, at + literalLength);
      at += literalLength;
      written += literalLength;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return output;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  count: number;
}

/** Read a v2/v3 pack, resolving OFS_DELTA and REF_DELTA entries via `resolveBase` when needed. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = pack.readUInt32BE(8);
  const endOfEntries = pack.length - 20;
  const trailer = pack.subarray(endOfEntries).toString('hex');
  const calculated = createHash('sha1').update(pack.subarray(0, endOfEntries)).digest('hex');
  if (trailer !== calculated) throw new Error('pack trailer checksum mismatch');

  const entries: PackedEntry[] = [];
  const byOffset = new Map<number, PackedEntry>();
  let at = 12;
  for (let index = 0; index < declared; index += 1) {
    const entryStart = at;
    const header = decodeSizeHeader(pack, at);
    at = header.next;
    const code = (header.first >> 4) & 0x07;
    const item: PackedEntry = { offset: entryStart, typeCode: code, size: header.size, data: Buffer.alloc(0) };
    if (code === 6) {
      const base = decodeOfsDistance(pack, at);
      at = base.next;
      item.baseOffset = entryStart - base.baseOffset;
      if (item.baseOffset < 0) throw new Error('ofs-delta names an invalid base');
    } else if (code === 7) {
      item.baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
    } else if (!CODE_TO_TYPE[code]) {
      throw new Error(`unknown pack type code ${code}`);
    }
    const inflated = inflateAt(pack.subarray(0, endOfEntries), at);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    item.data = inflated.data;
    at = inflated.next;
    entries.push(item);
    byOffset.set(entryStart, item);
  }
  if (at !== endOfEntries) throw new Error('pack has stray bytes before its trailer');

  const resolvedObjects = new Map<string, GitObject>();
  const resolvedEntries = new Map<string, PackedEntry>();
  const materialize = (item: PackedEntry): { type: GitObjectType; data: Buffer } => {
    if (item.resolved && item.resolvedType && item.oid) return { type: item.resolvedType, data: item.resolved };
    let kind: GitObjectType;
    let content: Buffer;
    if (item.typeCode === 6) {
      const parent = byOffset.get(item.baseOffset!);
      if (!parent) throw new Error('ofs-delta base is not in the pack');
      const base = materialize(parent);
      kind = base.type;
      content = patchWithDelta(base.data, item.data);
    } else if (item.typeCode === 7) {
      const wanted = item.baseOid!;
      const inPack = resolvedEntries.get(wanted);
      if (inPack) {
        const base = materialize(inPack);
        kind = base.type;
        content = patchWithDelta(base.data, item.data);
      } else {
        const outside = resolveBase?.(wanted);
        if (!outside) throw new Error(`ref-delta base ${wanted} is unavailable`);
        kind = outside.type;
        content = patchWithDelta(outside.data, item.data);
      }
    } else {
      kind = CODE_TO_TYPE[item.typeCode]!;
      content = item.data;
    }
    const oid = hashObject(kind, content);
    item.resolved = content;
    item.resolvedType = kind;
    item.oid = oid;
    resolvedEntries.set(oid, item);
    return { type: kind, data: content };
  };

  for (const item of entries) {
    materialize(item);
    const oid = item.oid ?? hashObject(item.resolvedType!, item.resolved!);
    if (!resolvedObjects.has(oid)) resolvedObjects.set(oid, { type: item.resolvedType!, data: item.resolved! });
  }
  return { objects: resolvedObjects, count: declared };
}

// ---------------------------------------------------------------- entities

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  user: string;
  comments: Comment[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  closedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  files: PullFile[];
  createdAt: string;
  user: string;
}

export class Repo {
  readonly name: string;
  readonly owner: string;
  id: number;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch = 'main';
  readonly refs = new Map<string, string>();
  readonly objects = new Map<string, GitObject>();
  readonly labels = new Map<string, Label>();
  readonly issues: Issue[] = [];
  issueSeq = 0;
  commentSeq = 0;
  readonly pulls: Pull[] = [];
  pullSeq = 0;
  /** Monotonic clock keeps created/updated timestamps ordered without reading wall time. */
  clock = 0;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.clock = 1_735_689_600;
  }

  tick(): number {
    this.clock += 1;
    return this.clock;
  }

  iso(): string {
    return new Date(this.clock * 1000).toISOString().replace('Z', 'Z');
  }

  refSha(ref: string): string | null {
    return this.refs.get(ref) ?? null;
  }

  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  lookup(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  headRefName(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  /** HEAD first, then all refs by name: the order used by advertisements and listings. */
  sortedRefs(): Array<{ name: string; oid: string }> {
    const listed: Array<{ name: string; oid: string }> = [];
    const tip = this.refs.get(this.headRefName());
    if (tip !== undefined) listed.push({ name: 'HEAD', oid: tip });
    for (const name of [...this.refs.keys()].sort()) listed.push({ name, oid: this.refs.get(name)! });
    return listed;
  }

  /** Follow tag objects until a non-tag object is reached; null for unknown ids. */
  peel(oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const item = this.objects.get(current);
      if (item === undefined) return null;
      if (item.type !== 'tag') return current;
      current = parseTag(item.data).object;
      if (!isObjectId(current)) return null;
    }
    return null;
  }

  /** Object ids reachable from `roots`: commits contribute tree and parents, trees their entries. */
  reachable(roots: Iterable<string>): Set<string> {
    const visited = new Set<string>();
    const pending: string[] = [];
    for (const root of roots) if (isObjectId(root)) pending.push(root);
    while (pending.length) {
      const oid = pending.pop()!;
      if (visited.has(oid)) continue;
      const item = this.objects.get(oid);
      if (item === undefined) continue;
      visited.add(oid);
      if (item.type === 'commit') {
        const commit = parseCommit(item.data);
        pending.push(commit.tree);
        for (const parent of commit.parents) pending.push(parent);
      } else if (item.type === 'tag') {
        const target = parseTag(item.data).object;
        if (isObjectId(target)) pending.push(target);
      } else if (item.type === 'tree') {
        for (const entry of parseTree(item.data)) {
          if (entry.mode === '160000') continue;
          pending.push(entry.oid);
        }
      }
    }
    return visited;
  }

  /** True when `descendant` has `ancestor` in its commit history (equality counts). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const visited = new Set<string>();
    const pending = [descendant];
    while (pending.length) {
      const oid = pending.pop()!;
      if (visited.has(oid) || !isObjectId(oid)) continue;
      visited.add(oid);
      const item = this.objects.get(oid);
      if (item === undefined || item.type !== 'commit') continue;
      const commit = parseCommit(item.data);
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        pending.push(parent);
      }
    }
    return false;
  }

  // Put `data` at `path` on `refName` (null deletes it) and advance the ref with a new commit.
  commitTreeChange(refName: string, path: string, data: Buffer | null, message: string): { commitSha: string; blobSha: string | null } {
    let tip = this.refs.get(refName) ?? null;
    if (tip !== null && this.objects.get(tip) === undefined) tip = null;
    let rootTree = '';
    if (tip !== null) rootTree = parseCommit(this.objects.get(tip)!.data).tree;

    const placeAt = (treeOid: string, segments: readonly string[], index: number): string => {
      const here: TreeEntry[] = treeOid === '' ? [] : parseTree(this.objects.get(treeOid)!.data);
      const name = segments[index]!;
      const nextIndex = index + 1;
      const existing = here.find((entry) => entry.name === name);
      let childOid: string;
      if (nextIndex === segments.length) {
        childOid = data === null ? '' : this.put('blob', data);
      } else {
        const nested = existing !== undefined && existing.mode === '40000' ? existing.oid : '';
        childOid = placeAt(nested, segments, nextIndex);
      }
      const rest = here.filter((entry) => entry.name !== name);
      if (childOid === '') return this.put('tree', buildTree(rest));
      const mode = nextIndex === segments.length ? '100644' : '40000';
      return this.put('tree', buildTree([...rest, { mode, name, oid: childOid }]));
    };

    const segments = path.split('/').filter((segment) => segment !== '');
    const newRoot = placeAt(rootTree, segments, 0);
    const blobSha = data === null ? null : hashObject('blob', data);
    const commitBytes = buildCommit({
      tree: newRoot,
      parents: tip === null ? [] : [tip],
      message: message.endsWith('\n') ? message : `${message}\n`,
      timestamp: this.tick(),
    });
    const commitSha = this.put('commit', commitBytes);
    this.refs.set(refName, commitSha);
    return { commitSha, blobSha };
  }

  /** The blob at `path` on `refName`, or null. */
  blobAtPath(refName: string, path: string): { oid: string; data: Buffer } | null {
    const tip = this.refs.get(refName);
    if (tip === undefined) return null;
    const commit = this.objects.get(tip);
    if (commit === undefined || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    const segments = path.split('/').filter((segment) => segment !== '');
    for (let index = 0; index < segments.length; index += 1) {
      const tree = this.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return null;
      if (index === segments.length - 1) {
        if (entry.mode === '40000') return null;
        const blob = this.objects.get(entry.oid);
        if (blob === undefined || blob.type !== 'blob') return null;
        return { oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  /** Direct children of `dirPath` (or the root when empty) on `refName`. */
  listDir(refName: string, dirPath: string): Array<{ type: 'file' | 'dir'; name: string; path: string; oid: string }> {
    const tip = this.refs.get(refName);
    if (tip === undefined) return [];
    const commit = this.objects.get(tip);
    if (commit === undefined || commit.type !== 'commit') return [];
    let treeOid = parseCommit(commit.data).tree;
    for (const segment of dirPath.split('/').filter((part) => part !== '')) {
      const tree = this.objects.get(treeOid);
      if (tree === undefined) return [];
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
      if (entry === undefined || entry.mode !== '40000') return [];
      treeOid = entry.oid;
    }
    const tree = this.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return [];
    return parseTree(tree.data).map((entry) => ({
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      name: entry.name,
      path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
      oid: entry.oid,
    }));
  }

  /** Reachable commits from a ref tip, newest first (breadth-leaning walk). */
  commitLog(refName: string): Array<{ sha: string; commit: CommitView }> {
    const tip = this.refs.get(refName);
    if (tip === undefined) return [];
    const log: Array<{ sha: string; commit: CommitView }> = [];
    const visited = new Set<string>();
    const pending = [tip];
    while (pending.length) {
      const oid = pending.shift()!;
      if (visited.has(oid) || !isObjectId(oid)) continue;
      visited.add(oid);
      const item = this.objects.get(oid);
      if (item === undefined || item.type !== 'commit') continue;
      const commit = parseCommit(item.data);
      log.push({ sha: oid, commit });
      for (const parent of commit.parents) pending.push(parent);
    }
    return log;
  }

  /** Line-count file stats for one diff between two tree-ish tips. */
  diffTree(baseTip: string | null, headTip: string): PullFile[] {
    const flatten = (tip: string | null): Map<string, string> => {
      const files = new Map<string, string>();
      if (tip === null) return files;
      const item = this.objects.get(tip);
      if (item === undefined) return files;
      const walk = (treeOid: string, prefix: string): void => {
        const tree = this.objects.get(treeOid);
        if (tree === undefined || tree.type !== 'tree') return;
        for (const entry of parseTree(tree.data)) {
          const fullPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
          if (entry.mode === '40000') walk(entry.oid, fullPath);
          else if (entry.mode !== '160000') files.set(fullPath, entry.oid);
        }
      };
      if (item.type === 'commit') walk(parseCommit(item.data).tree, '');
      else if (item.type === 'tree') walk(item === this.objects.get(tip) ? tip : tip, '');
      return files;
    };
    const before = flatten(baseTip);
    const after = flatten(headTip);
    const allPaths = new Set([...before.keys(), ...after.keys()]);
    const changes: PullFile[] = [];
    for (const path of [...allPaths].sort()) {
      const oldOid = before.get(path);
      const newOid = after.get(path);
      if (oldOid === newOid) continue;
      const oldBlob = oldOid === undefined ? null : this.objects.get(oldOid);
      const newBlob = newOid === undefined ? null : this.objects.get(newOid);
      const oldLines = oldBlob === null || oldBlob === undefined ? [] : oldBlob.data.toString('utf8').split('\n');
      const newLines = newBlob === null || newBlob === undefined ? [] : newBlob.data.toString('utf8').split('\n');
      const oldCount = new Map<string, number>();
      for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
      const newCount = new Map<string, number>();
      for (const line of newLines) newCount.set(line, (newCount.get(line) ?? 0) + 1);
      let insertions = 0;
      let deletions = 0;
      for (const [line, count] of newCount) insertions += Math.max(0, count - (oldCount.get(line) ?? 0));
      for (const [line, count] of oldCount) deletions += Math.max(0, count - (newCount.get(line) ?? 0));
      const status: PullFile['status'] = oldBlob === null || oldBlob === undefined ? 'added' : newBlob === null || newBlob === undefined ? 'removed' : 'modified';
      if (status === 'removed') insertions = 0;
      changes.push({ filename: path, status, additions: insertions, deletions, changes: insertions + deletions });
    }
    return changes;
  }

  issueByNumber(number: number): Issue | undefined {
    return this.issues.find((issue) => issue.number === number);
  }

  pullByNumber(number: number): Pull | undefined {
    return this.pulls.find((pull) => pull.number === number);
  }
}

export class Store {
  readonly viewer: string;
  readonly repos = new Map<string, Repo>();
  nextRepoId: number;

  constructor(viewer: string) {
    this.viewer = viewer;
    this.nextRepoId = 10_000;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`.toLowerCase();
  }

  get(owner: string, name: string): Repo | undefined {
    if (owner.toLowerCase() !== this.viewer.toLowerCase()) return undefined;
    return this.repos.get(this.key(owner, name));
  }

  create(name: string, description: string, isPrivate: boolean): { repo: Repo } | { error: string } {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return { error: 'the repository name is invalid' };
    const key = this.key(this.viewer, name);
    if (this.repos.has(key)) return { error: `name already exists on this account` };
    const repo = new Repo(this.nextRepoId++, this.viewer, name, description, isPrivate);
    this.repos.set(key, repo);
    return { repo };
  }

  delete(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** The viewer's repositories in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner.toLowerCase() === this.viewer.toLowerCase());
  }
}
