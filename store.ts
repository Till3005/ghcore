// The forge's in-memory store: repositories, refs, git objects, issues, labels, comments and
// pulls, plus the commit machinery the REST contents API and the merge path build on.
//
// Everything lives in memory; a trial runs one fresh process per suite, so nothing persists.
// All object ids are real git SHA-1 ids computed exactly as git computes them, so objects built
// over REST read back over smart HTTP and vice versa.

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
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\u0000`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const inflated = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: inflated.buffer, next: offset + inflated.engine.bytesWritten };
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry truncated');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Uint8Array): { object: string; type: string; tag: string } {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, blank < 0 ? buffer.length : blank).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
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
  const timestamp = fields.timestamp ?? 1_700_000_000;
  const who = `${fields.author ?? COMMIT_IDENTITY} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------- the pack codec

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas); trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<{ type: GitObjectType; data: Uint8Array }>): Buffer {
  const parts: Buffer[] = [];
  const list = [...objects];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

interface RawEntry {
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

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  count: number;
}

/** Read a packfile (v2) and resolve every object, including OFS_DELTA and REF_DELTA. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
      if (entry.baseOffset < 0) throw new Error('ofs-delta names an invalid base');
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved };
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is unavailable`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    return { type, data };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    const oid = entry.oid ?? hashObject(entry.resolvedType!, entry.resolved!);
    if (!objects.has(oid)) objects.set(oid, { type: entry.resolvedType!, data: entry.resolved! });
  }
  return { objects, count: declaredCount };
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
  /** A monotonic clock so created/updated timestamps order without reading the wall clock. */
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

  /** Every ref sorted HEAD-first then by name, for advertisements and listings. */
  sortedRefs(): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    const head = this.refs.get(this.headRefName());
    if (head !== undefined) out.push({ name: 'HEAD', oid: head });
    const names = [...this.refs.keys()].sort();
    for (const name of names) out.push({ name, oid: this.refs.get(name)! });
    return out;
  }

  /** Peel an object through tag objects down to a non-tag; null when the oid is unknown. */
  peel(oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type !== 'tag') return current;
      current = parseTag(object.data).object;
      if (!isObjectId(current)) return null;
    }
    return null;
  }

  /** Every object reachable from `roots`: commit -> tree+parents, tag -> target, tree -> entries. */
  reachable(roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) if (isObjectId(root)) queue.push(root);
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (isObjectId(target)) queue.push(target);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue;
          queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /** Whether `descendant` has `ancestor` in its commit ancestry (equal counts as true). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid) || !isObjectId(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /**
   * Commit a path change onto `refName`: build the new tree with `data` at `path`
   * (data === null removes it), then a commit on top of the ref's current tip, then move the ref.
   */
  commitTreeChange(refName: string, path: string, data: Buffer | null, message: string): { commitSha: string; blobSha: string | null } {
    let tip = this.refs.get(refName) ?? null;
    if (tip !== null && this.objects.get(tip) === undefined) tip = null;
    let rootTree = '';
    if (tip !== null) rootTree = parseCommit(this.objects.get(tip)!.data).tree;

    const setEntry = (treeOid: string, segments: readonly string[], index: number): string => {
      const entries: TreeEntry[] = treeOid === '' ? [] : parseTree(this.objects.get(treeOid)!.data);
      const name = segments[index]!;
      const remaining = index + 1;
      const existing = entries.find((entry) => entry.name === name);
      let entryOid: string;
      if (remaining === segments.length) {
        if (data === null) {
          entryOid = '';
        } else {
          entryOid = this.put('blob', data);
        }
      } else {
        const childOid = existing !== undefined && existing.mode === '40000' ? existing.oid : '';
        entryOid = setEntry(childOid, segments, remaining);
        if (entryOid === '') {
          entryOid = '';
        }
      }
      const without = entries.filter((entry) => entry.name !== name);
      if (entryOid === '') {
        const rebuilt = this.put('tree', buildTree(without));
        return rebuilt;
      }
      const mode = remaining === segments.length ? '100644' : '40000';
      const merged = [...without, { mode, name, oid: entryOid }];
      return this.put('tree', buildTree(merged));
    };

    const segments = path.split('/').filter((segment) => segment !== '');
    const newRoot = setEntry(rootTree, segments, 0);
    let blobSha: string | null = null;
    if (data !== null) {
      blobSha = hashObject('blob', data);
    }
    const commitData = buildCommit({
      tree: newRoot,
      parents: tip === null ? [] : [tip],
      message: message.endsWith('\n') ? message : `${message}\n`,
      timestamp: this.tick(),
    });
    const commitSha = this.put('commit', commitData);
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

  /** The entries directly under `dirPath` (or the root when dirPath is empty) on `refName`. */
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

  /** All commits reachable from a ref tip, newest first (first-parent-ish walk). */
  commitLog(refName: string): Array<{ sha: string; commit: CommitView }> {
    const tip = this.refs.get(refName);
    if (tip === undefined) return [];
    const out: Array<{ sha: string; commit: CommitView }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid) || !isObjectId(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, commit });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  /** One file's line-count diff between two tree paths, as pull-request file stats. */
  diffTree(baseTip: string | null, headTip: string): PullFile[] {
    const flatten = (tip: string | null): Map<string, string> => {
      const files = new Map<string, string>();
      if (tip === null) return files;
      const object = this.objects.get(tip);
      if (object === undefined) return files;
      const walk = (treeOid: string, prefix: string): void => {
        const tree = this.objects.get(treeOid);
        if (tree === undefined || tree.type !== 'tree') return;
        for (const entry of parseTree(tree.data)) {
          if (entry.mode === '40000') {
            walk(entry.oid, prefix === '' ? entry.name : `${prefix}/${entry.name}`);
          } else if (entry.mode !== '160000') {
            files.set(prefix === '' ? entry.name : `${prefix}/${entry.name}`, entry.oid);
          }
        }
      };
      if (object.type === 'commit') walk(parseCommit(object.data).tree, '');
      else if (object.type === 'tree') walk(object === this.objects.get(tip) ? tip : tip, '');
      return files;
    };
    const before = flatten(baseTip);
    const after = flatten(headTip);
    const paths = new Set([...before.keys(), ...after.keys()]);
    const files: PullFile[] = [];
    for (const path of [...paths].sort()) {
      const oldOid = before.get(path);
      const newOid = after.get(path);
      if (oldOid === newOid) continue;
      const oldBlob = oldOid === undefined ? null : this.objects.get(oldOid);
      const newBlob = newOid === undefined ? null : this.objects.get(newOid);
      const oldLines = oldBlob === null || oldBlob === undefined ? [] : oldBlob.data.toString('utf8').split('\n');
      const newLines = newBlob === null || newBlob === undefined ? [] : newBlob.data.toString('utf8').split('\n');
      const oldSet = new Map<string, number>();
      for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
      const newSet = new Map<string, number>();
      for (const line of newLines) newSet.set(line, (newSet.get(line) ?? 0) + 1);
      let additions = 0;
      let deletions = 0;
      for (const [line, count] of newSet) additions += Math.max(0, count - (oldSet.get(line) ?? 0));
      for (const [line, count] of oldSet) deletions += Math.max(0, count - (newSet.get(line) ?? 0));
      const status: PullFile['status'] = oldBlob === null || oldBlob === undefined ? 'added' : newBlob === null || newBlob === undefined ? 'removed' : 'modified';
      if (status === 'removed') {
        additions = 0;
      }
      files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return files;
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

  /** The viewer's repos in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner.toLowerCase() === this.viewer.toLowerCase());
  }
}
