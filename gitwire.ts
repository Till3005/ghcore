// Git smart HTTP at /{owner}/{repo}.git — upload-pack (v0 + v2) and receive-pack (v0).
// Implements pkt-line framing, capability advertisements, fetch/push negotiation, and pack handling.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Repo, GitObject, GitObjectType, TreeEntry } from './store.ts';
import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTree,
  buildTree,
  writePack,
  readPack,
  isObjectId,
} from './store.ts';

export const PKT_LINE_MAX = 65520;
const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type GitPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

function asBuffer(value: string | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export function encodePktLines(
  items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>,
): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

export class PktLineDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;

  constructor(initial?: Uint8Array) {
    if (initial && initial.length) this.push(initial);
  }

  push(chunk: Uint8Array): void {
    if (this.ended) throw new Error('decoder received bytes after finish()');
    if (!chunk.length) return;
    this.chunks.push(asBuffer(chunk));
    this.buffered += chunk.length;
  }

  finish(): void {
    this.ended = true;
  }

  get complete(): boolean {
    return this.ended && this.buffered === 0;
  }

  private peek(n: number): Buffer | null {
    if (this.buffered < n) return null;
    const first = this.chunks[0];
    if (first.length >= n) return first.subarray(0, n);
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    for (const chunk of this.chunks) {
      const need = n - filled;
      if (need <= 0) break;
      const take = Math.min(need, chunk.length);
      chunk.copy(out, filled, 0, take);
      filled += take;
    }
    return out;
  }

  private take(n: number): Buffer {
    if (this.buffered < n) throw new Error('decoder underrun');
    const first = this.chunks[0];
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0];
      const need = n - filled;
      if (chunk.length <= need) {
        chunk.copy(out, filled);
        filled += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(out, filled, 0, need);
        this.chunks[0] = chunk.subarray(need);
        filled = n;
      }
    }
    this.buffered -= n;
    return out;
  }

  next(): GitPacket | null {
    if (this.buffered < 4) {
      if (this.ended && this.buffered > 0) throw new Error('truncated pkt-line');
      return null;
    }
    const header = this.peek(4)!;
    if (!HEX4.test(header.toString('ascii'))) throw new Error('invalid pkt-line length');
    const length = Number.parseInt(header.toString('ascii'), 16);
    if (length === 0) { this.take(4); return { kind: 'flush' }; }
    if (length === 1) { this.take(4); return { kind: 'delim' }; }
    if (length === 2) { this.take(4); return { kind: 'response-end' }; }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error('pkt-line length exceeds max');
    if (this.buffered < length) {
      if (this.ended) throw new Error('truncated pkt-line');
      return null;
    }
    const raw = this.take(length);
    return { kind: 'data', payload: raw.subarray(4), raw };
  }

  nextIsRaw(): boolean {
    if (this.buffered < 4) return false;
    return !HEX4.test(this.peek(4)!.toString('ascii'));
  }

  takeBuffered(): Buffer {
    if (!this.buffered) return Buffer.alloc(0);
    const out = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;
    return out;
  }
}

export function decodePktLines(bytes: Uint8Array, options: { allowTrailing?: boolean } = {}): GitPacket[] {
  const decoder = new PktLineDecoder(bytes);
  decoder.finish();
  const packets: GitPacket[] = [];
  for (;;) {
    if (options.allowTrailing && decoder.nextIsRaw()) break;
    const packet = decoder.next();
    if (packet === null) break;
    packets.push(packet);
  }
  return packets;
}

// ---------------------------------------------------------------- capability advertisement

interface AdvertisedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

interface AdvertisementV0 {
  protocol: 0;
  service: 'git-upload-pack' | 'git-receive-pack';
  refs: AdvertisedRef[];
  capabilities: Map<string, string>;
  headSymref: string | null;
}

interface AdvertisementV2 {
  protocol: 2;
  service: 'git-upload-pack' | 'git-receive-pack';
  capabilities: Map<string, string>;
}

type Advertisement = AdvertisementV0 | AdvertisementV2;

function parseCapabilityList(text: string): Map<string, string> {
  const capabilities = new Map<string, string>();
  for (const token of text.split(' ')) {
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq < 0) capabilities.set(token, '');
    else capabilities.set(token.slice(0, eq), token.slice(eq + 1));
  }
  return capabilities;
}

export function parseAdvertisement(packets: readonly GitPacket[], service: 'git-upload-pack' | 'git-receive-pack'): {
  advertisement: Advertisement;
  hadServiceHeader: boolean;
} {
  const lines: string[] = [];
  let hadServiceHeader = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (lines.length === 0 && !hadServiceHeader && text.startsWith('# service=')) {
      hadServiceHeader = true;
      continue;
    }
    lines.push(text);
  }
  const first = (lines[0] ?? '').replace(/\n$/, '');
  if (first === 'version 2' || first.startsWith('version 2 ')) {
    const capabilities = new Map<string, string>();
    for (const line of lines) {
      const text = line.replace(/\n$/, '');
      if (!text || text === 'version 2') continue;
      const eq = text.indexOf('=');
      if (eq < 0) capabilities.set(text, '');
      else capabilities.set(text.slice(0, eq), text.slice(eq + 1));
    }
    return { hadServiceHeader, advertisement: { protocol: 2, service, capabilities, versionLine: first } };
  }
  const refs: AdvertisedRef[] = [];
  let capabilities = new Map<string, string>();
  let headSymref: string | null = null;
  const rawRefs: Array<{ oid: string; name: string; peeled?: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].replace(/\n$/, '');
    if (!line) continue;
    if (index === 0) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        capabilities = parseCapabilityList(line.slice(nul + 1));
        line = line.slice(0, nul);
      }
    }
    const space = line.indexOf(' ');
    if (space < 0) throw new Error('v0 advertisement line has no ref');
    const oid = line.slice(0, space);
    const name = line.slice(space + 1);
    if (!isObjectId(oid)) throw new Error('v0 advertisement bad oid');
    if (name.trim() === 'capabilities^{}') continue;
    if (name.endsWith('^{}')) {
      const base = name.slice(0, -3);
      const existing = rawRefs.find((ref) => ref.name === base);
      if (existing) existing.peeled = oid;
      else rawRefs.push({ oid, name: base, peeled: oid });
      continue;
    }
    rawRefs.push({ oid, name });
  }
  for (const ref of rawRefs) {
    if (ref.oid === ZERO_OID) {
      refs.push({ oid: ref.oid, name: ref.name, unborn: true, peeled: ref.peeled });
      continue;
    }
    const entry: AdvertisedRef = { oid: ref.oid, name: ref.name, peeled: ref.peeled };
    if (ref.name === 'HEAD') {
      const symref = capabilities.get('symref');
      if (symref && symref.startsWith('HEAD:')) {
        entry.symrefTarget = symref.slice(5);
        headSymref = entry.symrefTarget;
      }
    }
    refs.push(entry);
  }
  return {
    hadServiceHeader,
    advertisement: { protocol: 0, service, refs, capabilities, headSymref },
  };
}

// ---------------------------------------------------------------- upload-pack

interface FetchRequestV2 {
  wants: string[];
  haves: string[];
  depth?: number;
  shallow?: string[];
  deepenSince?: number;
  deepenNot?: string[];
  done: boolean;
  thinPack: boolean;
  noProgress: boolean;
  filter?: string;
}

function parseV2Command(packets: readonly GitPacket[]): FetchRequestV2 | null {
  let command = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    command = packet.payload.toString('utf8').trim();
    break;
  }
  if (!command.startsWith('command=fetch')) return null;
  const request: FetchRequestV2 = { wants: [], haves: [], shallow: [], deepenNot: [], done: true, thinPack: true, noProgress: true };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5));
    else if (line.startsWith('have ')) request.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7));
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice(13));
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11));
    else if (line === 'done') request.done = true;
    else if (line === 'thin-pack') request.thinPack = true;
    else if (line === 'no-progress') request.noProgress = true;
    else if (line.startsWith('filter ')) request.filter = line.slice(7);
  }
  return request;
}

interface FetchResult {
  protocol: 0 | 2;
  pack: Buffer | null;
  packBytes: number;
  checksumOk: boolean;
  objects: Map<string, GitObject>;
  deltaCount: number;
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
  ready: boolean;
  wantedRefs: ReadonlyArray<{ oid: string; ref: string }>;
  progress: string;
}

/** Build the set of objects reachable from wants, excluding those reachable from haves/shallow. */
function objectsToSend(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallow: readonly string[] = [],
): { objects: GitObject[]; tips: string[] } {
  const haveSet = new Set<string>();
  for (const have of haves) if (isObjectId(have)) haveSet.add(have);
  for (const boundary of shallow) if (isObjectId(boundary)) haveSet.add(boundary);
  const reachableFromHave = repo.reachable(haveSet);
  const wantTips: string[] = [];
  for (const want of wants) if (isObjectId(want)) wantTips.push(want);
  const reachableFromWant = repo.reachable(wantTips);
  const toSend: GitObject[] = [];
  for (const oid of reachableFromWant) {
    if (reachableFromHave.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) toSend.push(object);
  }
  return { objects: toSend, tips: wantTips };
}

/** Compute shallow boundary: commits at exactly `depth` from wants, not including parents beyond. */
function computeShallowInfo(repo: Repo, wants: readonly string[], depth: number): string[] {
  if (depth <= 0) return [];
  const shallow: string[] = [];
  const queue: Array<{ oid: string; d: number }> = [];
  const seen = new Set<string>();
  for (const want of wants) if (isObjectId(want)) queue.push({ oid: want, d: 1 });
  while (queue.length) {
    const { oid, d } = queue.shift()!;
    if (seen.has(oid) || !isObjectId(oid)) continue;
    seen.add(oid);
    if (d === depth) {
      shallow.push(oid);
      continue;
    }
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) if (isObjectId(parent)) queue.push({ oid: parent, d: d + 1 });
  }
  return shallow;
}

/** v2 fetch response with sections. */
function buildV2FetchResponse(
  repo: Repo,
  request: FetchRequestV2,
): FetchResult {
  const haveClosure = repo.reachable([...request.haves, ...(request.shallow ?? [])]);
  let sendOids: Set<string>;
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const depth = request.depth ?? 0;
  if (depth > 0) {
    // Walk commits generation by generation, cut off at `depth`; the boundary commits are shallow.
    const included = new Map<string, number>();
    const queue: Array<{ oid: string; gen: number }> = [];
    for (const want of request.wants) if (isObjectId(want)) queue.push({ oid: want, gen: 1 });
    const boundary: string[] = [];
    while (queue.length) {
      const { oid, gen } = queue.shift()!;
      if (included.has(oid) || !isObjectId(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      included.set(oid, gen);
      const parents = parseCommit(object.data).parents;
      if (gen >= depth) {
        if (parents.length > 0) boundary.push(oid);
        continue;
      }
      for (const parent of parents) if (isObjectId(parent)) queue.push({ oid: parent, gen: gen + 1 });
    }
    // Never send anything below the boundary: exclude the boundary parents' closure.
    const boundaryParents: string[] = [];
    for (const oid of boundary) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') boundaryParents.push(...parseCommit(object.data).parents);
    }
    const excluded = repo.reachable(boundaryParents);
    sendOids = new Set([...repo.reachable(included.keys())].filter((oid) => !excluded.has(oid)));
    for (const oid of boundary) shallow.push(oid);
    // Commits the client previously treated as shallow that are now interior become unshallow.
    for (const s of request.shallow ?? []) if (included.has(s) && !boundary.includes(s)) unshallow.push(s);
  } else {
    sendOids = new Set([...repo.reachable(request.wants)].filter((oid) => !haveClosure.has(oid)));
  }
  const toSend: GitObject[] = [];
  for (const oid of sendOids) {
    const object = repo.objects.get(oid);
    if (object !== undefined) toSend.push(object);
  }
  const pack = toSend.length > 0 ? writePack(toSend) : Buffer.alloc(0);
  const objects = new Map<string, GitObject>();
  for (const obj of toSend) objects.set(hashObject(obj.type, obj.data), obj);
  const acks = request.done ? ['NAK'] : [];
  return {
    protocol: 2,
    pack,
    packBytes: pack.length,
    checksumOk: true,
    objects,
    deltaCount: 0,
    shallow,
    unshallow,
    acks,
    nak: request.done,
    ready: false,
    wantedRefs: [],
    progress: '',
  };
}

/** v0 fetch response (sideband-64k framed). */
function buildV0FetchResponse(
  repo: Repo,
  wants: string[],
  haves: string[],
): { pack: Buffer; progress: string } {
  const { objects: toSend } = objectsToSend(repo, wants, haves);
  const pack = toSend.length > 0 ? writePack(toSend) : Buffer.alloc(0);
  return { pack, progress: '' };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface PushReport {
  unpackOk: boolean;
  unpackDetail: string;
  refs: Array<{ ref: string; ok: boolean; reason: string }>;
}

function parsePushCommandList(packets: readonly GitPacket[], caps: Map<string, string>): {
  commands: PushCommand[];
  capabilities: string[];
} {
  const commands: PushCommand[] = [];
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!line) continue;
    if (first) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        const capsText = line.slice(nul + 1);
        for (const cap of capsText.split(' ')) if (cap) caps.set(cap, '');
        const line2 = line.slice(0, nul);
        const parts = line2.split(' ');
        if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
        first = false;
        continue;
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const capabilities: string[] = [];
  if (caps.has('report-status-v2')) capabilities.push('report-status-v2');
  else if (caps.has('report-status')) capabilities.push('report-status');
  if (caps.has('side-band-64k')) capabilities.push('side-band-64k');
  if (caps.has('ofs-delta')) capabilities.push('ofs-delta');
  if (caps.has('delete-refs')) capabilities.push('delete-refs');
  return { commands, capabilities };
}

function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true; // create
  if (newOid === ZERO_OID) return true; // delete
  if (oldOid === newOid) return true; // no-op
  return repo.isAncestor(oldOid, newOid);
}

function applyPush(repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const ref = command.ref;
  if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
    return { ok: false, reason: 'no-op' };
  }
  const current = repo.refs.get(ref);
  if (command.oldOid !== ZERO_OID) {
    if (current === undefined) return { ok: false, reason: 'ref does not exist' };
    if (current !== command.oldOid) return { ok: false, reason: 'non-fast-forward' };
    if (!isFastForward(repo, current, command.newOid)) {
      return { ok: false, reason: 'non-fast-forward' };
    }
  } else {
    if (current !== undefined) return { ok: false, reason: 'ref already exists' };
  }
  if (command.newOid === ZERO_OID) {
    if (!repo.refs.has(ref)) return { ok: false, reason: 'ref does not exist' };
    repo.refs.delete(ref);
    // Update HEAD symref if deleting default branch
    if (ref === repo.headRefName()) {
      // keep HEAD pointing to the now-deleted branch (github does this)
    }
    return { ok: true, reason: '' };
  }
  // Verify the new commit exists in our store (it should from the pack)
  if (!repo.objects.has(command.newOid)) return { ok: false, reason: 'missing commit object' };
  repo.refs.set(ref, command.newOid);
  return { ok: true, reason: '' };
}

function buildPushReport(report: PushReport, sideband: boolean): Buffer {
  const lines: string[] = [];
  lines.push(`unpack ${report.unpackOk ? 'ok' : report.unpackDetail}`);
  for (const ref of report.refs) {
    if (ref.ok) lines.push(`ok ${ref.ref}`);
    else lines.push(`ng ${ref.ref} ${ref.reason}`);
  }
  lines.push('');
  const text = lines.join('\n');
  // The report-status stream is itself pkt-lined ("unpack ok", "ok/ng <ref>", flush).
  const reportStream = encodePktLines([text, 'flush']);
  if (!sideband) return reportStream;
  // side-band-64k: each pkt-line's payload = band byte + a chunk of the report stream.
  const frames: Buffer[] = [];
  let offset = 0;
  const maxChunk = PKT_LINE_MAX_PAYLOAD - 1;
  while (offset < reportStream.length) {
    const chunk = reportStream.subarray(offset, Math.min(offset + maxChunk, reportStream.length));
    offset += chunk.length;
    const frame = Buffer.allocUnsafe(chunk.length + 1);
    frame[0] = 1; // band 1 = data
    chunk.copy(frame, 1);
    frames.push(encodePktLine(frame));
  }
  frames.push(pktLineFlush());
  return Buffer.concat(frames);
}

// ---------------------------------------------------------------- public handlers

interface HandlerOptions {
  repo: Repo;
  service: 'git-upload-pack' | 'git-receive-pack';
  method: 'GET' | 'POST';
  query: URLSearchParams;
  body: Buffer;
  gitProtocol?: '2' | '0';
  acceptSideband: boolean;
}

export interface HandlerResult {
  status: number;
  body: Buffer;
  contentType: string;
  headers: Record<string, string>;
}

function buildV0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = new Map<string, string>();
  caps.set('multi_ack_detailed', '');
  caps.set('side-band-64k', '');
  caps.set('thin-pack', '');
  caps.set('ofs-delta', '');
  caps.set('shallow', '');
  caps.set('symref', `HEAD:refs/heads/${repo.defaultBranch}`);
  caps.set('object-format', 'sha1');
  caps.set('agent', 'entry-forge/1.0');
  if (service === 'git-receive-pack') {
    caps.set('report-status', '');
    caps.set('report-status-v2', '');
    caps.set('delete-refs', '');
  }

  const parts: Buffer[] = [];
  // Service header
  parts.push(encodePktLine(`# service=${service}\n`));
  parts.push(pktLineFlush());

  // For empty repo, just the capabilities pseudo-ref
  if (repo.refs.size === 0) {
    const capLine = `0000000000000000000000000000000000000000 capabilities^{}\0${[...caps.keys()].join(' ')}\n`;
    parts.push(encodePktLine(capLine));
    parts.push(pktLineFlush());
    return Buffer.concat(parts);
  }

  // Ref lines
  for (const { name, oid } of repo.sortedRefs()) {
    if (name === 'HEAD') continue;
    const peeled = repo.peel(oid);
    parts.push(encodePktLine(`${oid} ${name}\0${[...caps.keys()].join(' ')}\n`));
    if (peeled && peeled !== oid) {
      parts.push(encodePktLine(`${peeled} ${name}^{}\n`));
    }
  }
  // HEAD symref
  const headTip = repo.refs.get(repo.headRefName()) ?? ZERO_OID;
  parts.push(encodePktLine(`${headTip} HEAD\0${[...caps.keys()].join(' ')}\n`));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function buildV2Advertisement(service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = new Map<string, string>();
  caps.set('agent', 'entry-forge/1.0');
  caps.set('object-format', 'sha1');
  caps.set('ls-refs', '');
  caps.set('fetch', 'shallow');
  const parts: Buffer[] = [];
  parts.push(encodePktLine('version 2\n'));
  for (const [name, value] of caps) {
    parts.push(encodePktLine(value ? `${name}=${value}\n` : `${name}\n`));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function handleV2LsRefs(
  repo: Repo,
  packets: readonly GitPacket[],
): { refs: AdvertisedRef[]; caps: Map<string, string> } {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const filter = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const refs: AdvertisedRef[] = [];
  // HEAD
  const headTip = repo.refs.get(repo.headRefName()) ?? ZERO_OID;
  if (filter('HEAD')) {
    refs.push({
      oid: headTip,
      name: 'HEAD',
      symrefTarget: `refs/heads/${repo.defaultBranch}`,
    });
  }
  for (const { name, oid } of repo.sortedRefs()) {
    if (!name.startsWith('refs/') || !filter(name)) continue;
    const entry: AdvertisedRef = { oid, name };
    if (peel) entry.peeled = repo.peel(oid) ?? undefined;
    refs.push(entry);
  }
  return { refs, caps: new Map([['object-format', 'sha1'], ['agent', 'entry-forge/1.0']]) };
}

export function handleGitRequest(opts: HandlerOptions): HandlerResult {
  const { repo, service, method, query, body, gitProtocol, acceptSideband } = opts;
  const isV2 = gitProtocol === '2' && service === 'git-upload-pack';

  // GET /info/refs
  if (method === 'GET' && query.get('service') === service) {
    const advertisement = isV2 ? buildV2Advertisement(service) : buildV0Advertisement(repo, service);
    return {
      status: 200,
      body: advertisement,
      contentType: `application/x-${service}-advertisement`,
      headers: { 'cache-control': 'no-cache' },
    };
  }

  // POST /git-upload-pack (ls-refs or fetch)
  if (method === 'POST' && service === 'git-upload-pack') {
    if (isV2) {
      const packets = decodePktLines(body);
      let command = '';
      for (const packet of packets) {
        if (packet.kind !== 'data') continue;
        command = packet.payload.toString('utf8').trim();
        break;
      }
      if (command.startsWith('command=ls-refs')) {
        const { refs } = handleV2LsRefs(repo, packets);
        const parts: Buffer[] = [];
        for (const ref of refs) {
          let line = `${ref.oid} ${ref.name}`;
          if (ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
          if (ref.peeled && ref.peeled !== ref.oid) line += ` peeled:${ref.peeled}`;
          parts.push(encodePktLine(`${line}\n`));
        }
        parts.push(pktLineFlush());
        return {
          status: 200,
          body: Buffer.concat(parts),
          contentType: `application/x-${service}-result`,
          headers: { 'cache-control': 'no-cache' },
        };
      }
      const request = parseV2Command(packets);
      if (!request) throw new Error('invalid v2 fetch request');
      const result = buildV2FetchResponse(repo, request);
      // Build response packets
      const out: Array<string | 'flush' | 'delim'> = [];
      // acknowledgments section
      out.push('acknowledgments\n');
      for (const ack of result.acks) out.push(`${ack}\n`);
      out.push('flush');
      // shallow-info section
      if (result.shallow.length > 0 || result.unshallow.length > 0) {
        out.push('shallow-info\n');
        for (const s of result.shallow) out.push(`shallow ${s}\n`);
        for (const s of result.unshallow) out.push(`unshallow ${s}\n`);
        out.push('flush');
      }
      // wanted-refs section (empty for us)
      out.push('wanted-refs\n');
      out.push('flush');
      // packfile section
      out.push('packfile\n');
      const packFrames: Buffer[] = [];
      if (result.pack.length > 0) {
        // Sideband frame the pack
        let offset = 0;
        const maxChunk = PKT_LINE_MAX_PAYLOAD - 1;
        while (offset < result.pack.length) {
          const chunk = result.pack.subarray(offset, Math.min(offset + maxChunk, result.pack.length));
          offset += chunk.length;
          const frame = Buffer.allocUnsafe(chunk.length + 1);
          frame[0] = 1; // band 1 = pack data
          chunk.copy(frame, 1);
          packFrames.push(encodePktLine(frame));
        }
      }
      // Flush after packfile
      const responseBody = Buffer.concat([encodePktLines(out), ...packFrames, pktLineFlush()]);
      return {
        status: 200,
        body: responseBody,
        contentType: `application/x-${service}-result`,
        headers: { 'cache-control': 'no-cache' },
      };
    } else {
      // v0 protocol with sideband-64k
      const packets = decodePktLines(body);
      // Parse v0 command lines (want/have/shallow/deepen/done)
      const wants: string[] = [];
      const haves: string[] = [];
      let depth: number | null = null;
      for (const packet of packets) {
        if (packet.kind !== 'data') continue;
        const line = packet.payload.toString('utf8').replace(/\n$/, '');
        if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
        else if (line.startsWith('have ')) haves.push(line.slice(5));
        else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
      }
      // Check if client sent done (it's the second flush-pkt terminated section)
      // Simplified: if we see a flush then have lines then done, we respond.
      const result = buildV0FetchResponse(repo, wants, haves);
      // Frame as sideband-64k
      const packFrames: Buffer[] = [];
      if (result.pack.length > 0) {
        let offset = 0;
        const maxChunk = PKT_LINE_MAX_PAYLOAD - 1;
        while (offset < result.pack.length) {
          const chunk = result.pack.subarray(offset, Math.min(offset + maxChunk, result.pack.length));
          offset += chunk.length;
          const frame = Buffer.allocUnsafe(chunk.length + 1);
          frame[0] = 1;
          chunk.copy(frame, 1);
          packFrames.push(encodePktLine(frame));
        }
      }
      // Also send an empty flush packet
      packFrames.push(pktLineFlush());
      return {
        status: 200,
        body: Buffer.concat(packFrames),
        contentType: `application/x-${service}-result`,
        headers: { 'cache-control': 'no-cache' },
      };
    }
  }

  // POST /git-receive-pack (push)
  if (method === 'POST' && service === 'git-receive-pack') {
    // Parse the request body: pkt-lines for commands up to the flush, then RAW pack data.
    const decoder = new PktLineDecoder(body);
    const packets: GitPacket[] = [];
    for (;;) {
      const packet = decoder.next();
      if (packet === null) break;
      packets.push(packet);
      if (packet.kind === 'flush') break;
    }
    const remainingPack = decoder.takeBuffered();

    const caps = new Map<string, string>();
    const { commands, capabilities } = parsePushCommandList(packets, caps);
    const sideband = capabilities.includes('side-band-64k');

    // Parse the pack if present (for creates/updates)
    if (remainingPack.length > 0) {
      try {
        const parsed = readPack(remainingPack, (oid) => repo.objects.get(oid));
        for (const [oid, object] of parsed.objects) {
          repo.objects.set(oid, object);
        }
      } catch (e) {
        // Pack parse error - still report unpack error
        return {
          status: 200,
          body: buildPushReport({
            unpackOk: false,
            unpackDetail: `pack parse failed: ${(e as Error).message}`,
            refs: commands.map((cmd) => ({ ref: cmd.ref, ok: false, reason: 'unpack error' })),
          }, sideband),
          contentType: `application/x-${service}-result`,
          headers: {},
        };
      }
    }

    // Apply each command
    const refReports: PushReport['refs'] = [];
    let unpackOk = true;
    let unpackDetail = 'ok';
    for (const command of commands) {
      const result = applyPush(repo, command);
      if (!result.ok && result.reason !== 'non-fast-forward') {
        unpackOk = false;
        unpackDetail = result.reason;
      }
      refReports.push({ ref: command.ref, ok: result.ok, reason: result.reason });
    }

    const report: PushReport = { unpackOk, unpackDetail, refs: refReports };
    return {
      status: 200,
      body: buildPushReport(report, sideband),
      contentType: `application/x-${service}-result`,
      headers: { 'cache-control': 'no-cache' },
    };
  }

  throw new Error('unsupported git request');
}