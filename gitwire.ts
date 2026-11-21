// Git smart HTTP under /{owner}/{repo}.git: upload-pack (v0 and v2) and receive-pack (v0),
// including pkt-line framing, capability ads, fetch negotiation and pack handling.

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
const MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type GitPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

function toBytes(value: string | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const bytes = toBytes(payload);
  if (bytes.length > MAX_PAYLOAD) throw new Error('pkt-line payload too long');
  const prefix = Buffer.allocUnsafe(4);
  prefix.write((bytes.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([prefix, bytes]);
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
  const frames: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') frames.push(pktLineFlush());
    else if (item === 'delim') frames.push(pktLineDelim());
    else if (item === 'response-end') frames.push(pktLineResponseEnd());
    else frames.push(encodePktLine(item));
  }
  return Buffer.concat(frames);
}

const HEX_DIGITS = /^[0-9a-fA-F]{4}$/;

export class PktLineDecoder {
  private queued: Buffer[] = [];
  private byteCount = 0;
  private closed = false;

  constructor(initial?: Uint8Array) {
    if (initial && initial.length) this.push(initial);
  }

  push(chunk: Uint8Array): void {
    if (this.closed) throw new Error('decoder received bytes after finish()');
    if (!chunk.length) return;
    this.queued.push(toBytes(chunk));
    this.byteCount += chunk.length;
  }

  finish(): void {
    this.closed = true;
  }

  get complete(): boolean {
    return this.closed && this.byteCount === 0;
  }

  private lookAhead(count: number): Buffer | null {
    if (this.byteCount < count) return null;
    const head = this.queued[0];
    if (head.length >= count) return head.subarray(0, count);
    const assembled = Buffer.allocUnsafe(count);
    let filled = 0;
    for (const piece of this.queued) {
      const missing = count - filled;
      if (missing <= 0) break;
      const portion = Math.min(missing, piece.length);
      piece.copy(assembled, filled, 0, portion);
      filled += portion;
    }
    return assembled;
  }

  private consume(count: number): Buffer {
    if (this.byteCount < count) throw new Error('decoder underrun');
    const head = this.queued[0];
    if (head.length >= count) {
      if (head.length === count) this.queued.shift();
      else this.queued[0] = head.subarray(count);
      this.byteCount -= count;
      return head.subarray(0, count);
    }
    const assembled = Buffer.allocUnsafe(count);
    let filled = 0;
    while (filled < count) {
      const piece = this.queued[0];
      const missing = count - filled;
      if (piece.length <= missing) {
        piece.copy(assembled, filled);
        filled += piece.length;
        this.queued.shift();
      } else {
        piece.copy(assembled, filled, 0, missing);
        this.queued[0] = piece.subarray(missing);
        filled = count;
      }
    }
    this.byteCount -= count;
    return assembled;
  }

  next(): GitPacket | null {
    if (this.byteCount < 4) {
      if (this.closed && this.byteCount > 0) throw new Error('truncated pkt-line');
      return null;
    }
    const head = this.lookAhead(4)!;
    if (!HEX_DIGITS.test(head.toString('ascii'))) throw new Error('invalid pkt-line length');
    const length = Number.parseInt(head.toString('ascii'), 16);
    if (length === 0) {
      this.consume(4);
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.consume(4);
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.consume(4);
      return { kind: 'response-end' };
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error('pkt-line length exceeds max');
    if (this.byteCount < length) {
      if (this.closed) throw new Error('truncated pkt-line');
      return null;
    }
    const raw = this.consume(length);
    return { kind: 'data', payload: raw.subarray(4), raw };
  }

  nextIsRaw(): boolean {
    if (this.byteCount < 4) return false;
    return !HEX_DIGITS.test(this.lookAhead(4)!.toString('ascii'));
  }

  takeBuffered(): Buffer {
    if (!this.byteCount) return Buffer.alloc(0);
    const rest = Buffer.concat(this.queued, this.byteCount);
    this.queued = [];
    this.byteCount = 0;
    return rest;
  }
}

export function decodePktLines(bytes: Uint8Array, options: { allowTrailing?: boolean } = {}): GitPacket[] {
  const reader = new PktLineDecoder(bytes);
  reader.finish();
  const decoded: GitPacket[] = [];
  for (;;) {
    if (options.allowTrailing && reader.nextIsRaw()) break;
    const frame = reader.next();
    if (frame === null) break;
    decoded.push(frame);
  }
  return decoded;
}

// ---------------------------------------------------------------- capability advertisement

interface RefAdvertisement {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

interface AdV0 {
  protocol: 0;
  service: 'git-upload-pack' | 'git-receive-pack';
  refs: RefAdvertisement[];
  capabilities: Map<string, string>;
  headSymref: string | null;
}

interface AdV2 {
  protocol: 2;
  service: 'git-upload-pack' | 'git-receive-pack';
  capabilities: Map<string, string>;
}

type Advertisement = AdV0 | AdV2;

function decodeCapabilities(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const token of text.split(' ')) {
    if (!token) continue;
    const separator = token.indexOf('=');
    if (separator < 0) result.set(token, '');
    else result.set(token.slice(0, separator), token.slice(separator + 1));
  }
  return result;
}

export function parseAdvertisement(packets: readonly GitPacket[], service: 'git-upload-pack' | 'git-receive-pack'): {
  advertisement: Advertisement;
  hadServiceHeader: boolean;
} {
  const rows: string[] = [];
  let hasServicePrefix = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (rows.length === 0 && !hasServicePrefix && text.startsWith('# service=')) {
      hasServicePrefix = true;
      continue;
    }
    rows.push(text);
  }
  const first = (rows[0] ?? '').replace(/\n$/, '');
  if (first === 'version 2' || first.startsWith('version 2 ')) {
    const capabilities = new Map<string, string>();
    for (const row of rows) {
      const text = row.replace(/\n$/, '');
      if (!text || text === 'version 2') continue;
      const separator = text.indexOf('=');
      if (separator < 0) capabilities.set(text, '');
      else capabilities.set(text.slice(0, separator), text.slice(separator + 1));
    }
    return { hadServiceHeader: hasServicePrefix, advertisement: { protocol: 2, service, capabilities, versionLine: first } };
  }
  const refs: RefAdvertisement[] = [];
  let capabilities = new Map<string, string>();
  let symbolicHead: string | null = null;
  const collected: Array<{ oid: string; name: string; peeled?: string }> = [];
  for (let index = 0; index < rows.length; index += 1) {
    let row = rows[index].replace(/\n$/, '');
    if (!row) continue;
    if (index === 0) {
      const nul = row.indexOf('\u0000');
      if (nul >= 0) {
        capabilities = decodeCapabilities(row.slice(nul + 1));
        row = row.slice(0, nul);
      }
    }
    const separator = row.indexOf(' ');
    if (separator < 0) throw new Error('v0 advertisement line has no ref');
    const oid = row.slice(0, separator);
    const name = row.slice(separator + 1);
    if (!isObjectId(oid)) throw new Error('v0 advertisement bad oid');
    if (name.trim() === 'capabilities^{}') continue;
    if (name.endsWith('^{}')) {
      const base = name.slice(0, -3);
      const earlier = collected.find(ref => ref.name === base);
      if (earlier) earlier.peeled = oid;
      else collected.push({ oid, name: base, peeled: oid });
      continue;
    }
    collected.push({ oid, name });
  }
  for (const original of collected) {
    if (original.oid === ZERO_OID) {
      refs.push({ oid: original.oid, name: original.name, unborn: true, peeled: original.peeled });
      continue;
    }
    const advertised: RefAdvertisement = { oid: original.oid, name: original.name, peeled: original.peeled };
    if (original.name === 'HEAD') {
      const symref = capabilities.get('symref');
      if (symref && symref.startsWith('HEAD:')) {
        advertised.symrefTarget = symref.slice(5);
        symbolicHead = advertised.symrefTarget;
      }
    }
    refs.push(advertised);
  }
  return {
    hadServiceHeader: hasServicePrefix,
    advertisement: { protocol: 0, service, refs, capabilities, headSymref: symbolicHead },
  };
}

// ---------------------------------------------------------------- upload-pack

interface V2FetchRequest {
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

function readV2Command(packets: readonly GitPacket[]): V2FetchRequest | null {
  let command = '';
  for (const frame of packets) {
    if (frame.kind !== 'data') continue;
    command = frame.payload.toString('utf8').trim();
    break;
  }
  if (!command.startsWith('command=fetch')) return null;
  const request: V2FetchRequest = {
    wants: [], haves: [], shallow: [], deepenNot: [], done: true, thinPack: true, noProgress: true,
  };
  for (const frame of packets) {
    if (frame.kind !== 'data') continue;
    const line = frame.payload.toString('utf8').replace(/\n$/, '');
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

interface FetchOutcome {
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

/** Objects reachable from wants minus those reachable from haves/shallow, plus the want tips. */
function chooseObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[] = [],
): { objects: GitObject[]; tips: string[] } {
  const haveIds = new Set<string>();
  for (const have of haves) if (isObjectId(have)) haveIds.add(have);
  for (const boundary of shallowBoundaries) if (isObjectId(boundary)) haveIds.add(boundary);
  const coveredByHave = repo.reachable(haveIds);
  const wantedTips: string[] = [];
  for (const want of wants) if (isObjectId(want)) wantedTips.push(want);
  const coveredByWant = repo.reachable(wantedTips);
  const payload: GitObject[] = [];
  for (const oid of coveredByWant) {
    if (coveredByHave.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) payload.push(object);
  }
  return { objects: payload, tips: wantedTips };
}

/** Commits exactly `depth` generations away from the wants (kept for shallow diagnostics). */
function findShallowBoundary(repo: Repo, wants: readonly string[], depth: number): string[] {
  if (depth <= 0) return [];
  const result: string[] = [];
  const pending: Array<{ oid: string; d: number }> = [];
  const seen = new Set<string>();
  for (const want of wants) if (isObjectId(want)) pending.push({ oid: want, d: 1 });
  while (pending.length) {
    const { oid, d } = pending.shift()!;
    if (seen.has(oid) || !isObjectId(oid)) continue;
    seen.add(oid);
    if (d === depth) {
      result.push(oid);
      continue;
    }
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) if (isObjectId(parent)) pending.push({ oid: parent, d: d + 1 });
  }
  return result;
}

/** A v2 fetch response with its ack, shallow-info, wanted-refs and packfile sections. */
function makeV2Fetch(repo: Repo, request: V2FetchRequest): FetchOutcome {
  const haveClosure = repo.reachable([...request.haves, ...(request.shallow ?? [])]);
  let sendIds: Set<string>;
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const depth = request.depth ?? 0;
  if (depth > 0) {
    // Walk generation by generation and cut at `depth`; cut commits become shallow boundaries.
    const generations = new Map<string, number>();
    const pending: Array<{ oid: string; gen: number }> = [];
    for (const want of request.wants) if (isObjectId(want)) pending.push({ oid: want, gen: 1 });
    const boundary: string[] = [];
    while (pending.length) {
      const { oid, gen } = pending.shift()!;
      if (generations.has(oid) || !isObjectId(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      generations.set(oid, gen);
      const parents = parseCommit(object.data).parents;
      if (gen >= depth) {
        if (parents.length > 0) boundary.push(oid);
        continue;
      }
      for (const parent of parents) if (isObjectId(parent)) pending.push({ oid: parent, gen: gen + 1 });
    }
    const beyondBoundary: string[] = [];
    for (const oid of boundary) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') beyondBoundary.push(...parseCommit(object.data).parents);
    }
    const excluded = repo.reachable(beyondBoundary);
    sendIds = new Set([...repo.reachable(generations.keys())].filter(oid => !excluded.has(oid)));
    for (const oid of boundary) shallow.push(oid);
    for (const prior of request.shallow ?? []) {
      if (generations.has(prior) && !boundary.includes(prior)) unshallow.push(prior);
    }
  } else {
    sendIds = new Set([...repo.reachable(request.wants)].filter(oid => !haveClosure.has(oid)));
  }
  const payload: GitObject[] = [];
  for (const oid of sendIds) {
    const object = repo.objects.get(oid);
    if (object !== undefined) payload.push(object);
  }
  const packed = payload.length > 0 ? writePack(payload) : Buffer.alloc(0);
  const objects = new Map<string, GitObject>();
  for (const object of payload) objects.set(hashObject(object.type, object.data), object);
  return {
    protocol: 2,
    pack: packed,
    packBytes: packed.length,
    checksumOk: true,
    objects,
    deltaCount: 0,
    shallow,
    unshallow,
    acks: request.done ? ['NAK'] : [],
    nak: request.done,
    ready: false,
    wantedRefs: [],
    progress: '',
  };
}

/** A v0 fetch result; the caller applies sideband framing. */
function makeV0Fetch(repo: Repo, wants: string[], haves: string[]): { pack: Buffer; progress: string } {
  const { objects: payload } = chooseObjects(repo, wants, haves);
  return { pack: payload.length > 0 ? writePack(payload) : Buffer.alloc(0), progress: '' };
}

// ---------------------------------------------------------------- receive-pack

interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface PushStatusReport {
  unpackOk: boolean;
  unpackDetail: string;
  refs: Array<{ ref: string; ok: boolean; reason: string }>;
}

function decodePushCommands(packets: readonly GitPacket[], caps: Map<string, string>): {
  commands: RefUpdate[];
  capabilities: string[];
} {
  const commands: RefUpdate[] = [];
  let firstLine = true;
  for (const frame of packets) {
    if (frame.kind !== 'data') continue;
    const line = frame.payload.toString('utf8').replace(/\n$/, '');
    if (!line) continue;
    if (firstLine) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        for (const cap of line.slice(nul + 1).split(' ')) if (cap) caps.set(cap, '');
        const plain = line.slice(0, nul);
        const fields = plain.split(' ');
        if (fields.length >= 3) commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
        firstLine = false;
        continue;
      }
    }
    const fields = line.split(' ');
    if (fields.length >= 3) commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
  }
  const capabilities: string[] = [];
  if (caps.has('report-status-v2')) capabilities.push('report-status-v2');
  else if (caps.has('report-status')) capabilities.push('report-status');
  if (caps.has('side-band-64k')) capabilities.push('side-band-64k');
  if (caps.has('ofs-delta')) capabilities.push('ofs-delta');
  if (caps.has('delete-refs')) capabilities.push('delete-refs');
  return { commands, capabilities };
}

function isFastForwardUpdate(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  if (newOid === ZERO_OID) return true;
  if (oldOid === newOid) return true;
  return repo.isAncestor(oldOid, newOid);
}

function performPush(repo: Repo, command: RefUpdate): { ok: boolean; reason: string } {
  if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) return { ok: false, reason: 'no-op' };
  const current = repo.refs.get(command.ref);
  if (command.oldOid !== ZERO_OID) {
    if (current === undefined) return { ok: false, reason: 'ref does not exist' };
    if (current !== command.oldOid) return { ok: false, reason: 'non-fast-forward' };
    if (!isFastForwardUpdate(repo, current, command.newOid)) return { ok: false, reason: 'non-fast-forward' };
  } else if (current !== undefined) {
    return { ok: false, reason: 'ref already exists' };
  }
  if (command.newOid === ZERO_OID) {
    if (!repo.refs.has(command.ref)) return { ok: false, reason: 'ref does not exist' };
    repo.refs.delete(command.ref);
    // HEAD keeps pointing at the deleted branch, as GitHub does.
    return { ok: true, reason: '' };
  }
  if (!repo.objects.has(command.newOid)) return { ok: false, reason: 'missing commit object' };
  repo.refs.set(command.ref, command.newOid);
  return { ok: true, reason: '' };
}

function encodePushReport(report: PushStatusReport, sideband: boolean): Buffer {
  const lines: string[] = [`unpack ${report.unpackOk ? 'ok' : report.unpackDetail}`];
  for (const ref of report.refs) {
    lines.push(ref.ok ? `ok ${ref.ref}` : `ng ${ref.ref} ${ref.reason}`);
  }
  lines.push('');
  // The report-status payload is itself pkt-lined, ending with a flush.
  const reportFrames = encodePktLines([lines.join('\n'), 'flush']);
  if (!sideband) return reportFrames;
  // With side-band-64k each packet carries a band byte ahead of its report chunk.
  const frames: Buffer[] = [];
  let at = 0;
  const maxChunk = MAX_PAYLOAD - 1;
  while (at < reportFrames.length) {
    const piece = reportFrames.subarray(at, Math.min(at + maxChunk, reportFrames.length));
    at += piece.length;
    const framed = Buffer.allocUnsafe(piece.length + 1);
    framed[0] = 1;
    piece.copy(framed, 1);
    frames.push(encodePktLine(framed));
  }
  frames.push(pktLineFlush());
  return Buffer.concat(frames);
}

// ---------------------------------------------------------------- public handlers

interface GitHandlerOptions {
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

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = new Map<string, string>([
    ['multi_ack_detailed', ''],
    ['side-band-64k', ''],
    ['thin-pack', ''],
    ['ofs-delta', ''],
    ['shallow', ''],
    ['symref', `HEAD:refs/heads/${repo.defaultBranch}`],
    ['object-format', 'sha1'],
    ['agent', 'entry-forge/1.0'],
  ]);
  if (service === 'git-receive-pack') {
    caps.set('report-status', '');
    caps.set('report-status-v2', '');
    caps.set('delete-refs', '');
  }
  const pieces: Buffer[] = [encodePktLine(`# service=${service}\n`), pktLineFlush()];
  if (repo.refs.size === 0) {
    pieces.push(encodePktLine(`0000000000000000000000000000000000000000 capabilities^{}\0${[...caps.keys()].join(' ')}\n`));
    pieces.push(pktLineFlush());
    return Buffer.concat(pieces);
  }
  for (const { name, oid } of repo.sortedRefs()) {
    if (name === 'HEAD') continue;
    const peeled = repo.peel(oid);
    pieces.push(encodePktLine(`${oid} ${name}\0${[...caps.keys()].join(' ')}\n`));
    if (peeled && peeled !== oid) pieces.push(encodePktLine(`${peeled} ${name}^{}\n`));
  }
  const headTip = repo.refs.get(repo.headRefName()) ?? ZERO_OID;
  pieces.push(encodePktLine(`${headTip} HEAD\0${[...caps.keys()].join(' ')}\n`), pktLineFlush());
  return Buffer.concat(pieces);
}

function v2Advertisement(service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = new Map<string, string>([
    ['agent', 'entry-forge/1.0'],
    ['object-format', 'sha1'],
    ['ls-refs', ''],
    ['fetch', 'shallow'],
  ]);
  const pieces: Buffer[] = [encodePktLine('version 2\n')];
  for (const [name, value] of caps) pieces.push(encodePktLine(value ? `${name}=${value}\n` : `${name}\n`));
  pieces.push(pktLineFlush());
  return Buffer.concat(pieces);
}

function answerLsRefs(repo: Repo, packets: readonly GitPacket[]): { refs: RefAdvertisement[]; caps: Map<string, string> } {
  let peeled = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const frame of packets) {
    if (frame.kind !== 'data') continue;
    const line = frame.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peeled = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const included = (name: string) => prefixes.length === 0 || prefixes.some(prefix => name.startsWith(prefix));
  const refs: RefAdvertisement[] = [];
  const headTip = repo.refs.get(repo.headRefName()) ?? ZERO_OID;
  if (included('HEAD')) {
    refs.push({ oid: headTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  }
  for (const { name, oid } of repo.sortedRefs()) {
    if (!name.startsWith('refs/') || !included(name)) continue;
    const entry: RefAdvertisement = { oid, name };
    if (peeled) entry.peeled = repo.peel(oid) ?? undefined;
    refs.push(entry);
  }
  return { refs, caps: new Map([['object-format', 'sha1'], ['agent', 'entry-forge/1.0']]) };
}

function sidebandFrames(payload: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let at = 0;
  const maxChunk = MAX_PAYLOAD - 1;
  while (at < payload.length) {
    const piece = payload.subarray(at, Math.min(at + maxChunk, payload.length));
    at += piece.length;
    const framed = Buffer.allocUnsafe(piece.length + 1);
    framed[0] = 1;
    piece.copy(framed, 1);
    frames.push(encodePktLine(framed));
  }
  return frames;
}

export function handleGitRequest(opts: GitHandlerOptions): HandlerResult {
  const { repo, service, method, query, body, gitProtocol, acceptSideband } = opts;
  const isV2 = gitProtocol === '2' && service === 'git-upload-pack';

  if (method === 'GET' && query.get('service') === service) {
    const advertisement = isV2 ? v2Advertisement(service) : v0Advertisement(repo, service);
    return {
      status: 200,
      body: advertisement,
      contentType: `application/x-${service}-advertisement`,
      headers: { 'cache-control': 'no-cache' },
    };
  }

  if (method === 'POST' && service === 'git-upload-pack') {
    if (isV2) {
      const packets = decodePktLines(body);
      let command = '';
      for (const frame of packets) {
        if (frame.kind !== 'data') continue;
        command = frame.payload.toString('utf8').trim();
        break;
      }
      if (command.startsWith('command=ls-refs')) {
        const { refs } = answerLsRefs(repo, packets);
        const pieces: Buffer[] = [];
        for (const ref of refs) {
          let row = `${ref.oid} ${ref.name}`;
          if (ref.symrefTarget) row += ` symref-target:${ref.symrefTarget}`;
          if (ref.peeled && ref.peeled !== ref.oid) row += ` peeled:${ref.peeled}`;
          pieces.push(encodePktLine(`${row}\n`));
        }
        pieces.push(pktLineFlush());
        return {
          status: 200,
          body: Buffer.concat(pieces),
          contentType: `application/x-${service}-result`,
          headers: { 'cache-control': 'no-cache' },
        };
      }
      const request = readV2Command(packets);
      if (!request) throw new Error('invalid v2 fetch request');
      const outcome = makeV2Fetch(repo, request);
      const sections: Array<string | 'flush' | 'delim'> = ['acknowledgments\n'];
      for (const ack of outcome.acks) sections.push(`${ack}\n`);
      sections.push('flush');
      if (outcome.shallow.length > 0 || outcome.unshallow.length > 0) {
        sections.push('shallow-info\n');
        for (const oid of outcome.shallow) sections.push(`shallow ${oid}\n`);
        for (const oid of outcome.unshallow) sections.push(`unshallow ${oid}\n`);
        sections.push('flush');
      }
      sections.push('wanted-refs\n', 'flush', 'packfile\n');
      const answer = Buffer.concat([encodePktLines(sections), ...sidebandFrames(outcome.pack ?? Buffer.alloc(0)), pktLineFlush()]);
      return {
        status: 200,
        body: answer,
        contentType: `application/x-${service}-result`,
        headers: { 'cache-control': 'no-cache' },
      };
    }

    const packets = decodePktLines(body);
    const wants: string[] = [];
    const haves: string[] = [];
    for (const frame of packets) {
      if (frame.kind !== 'data') continue;
      const line = frame.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
      else if (line.startsWith('have ')) haves.push(line.slice(5));
    }
    const outcome = makeV0Fetch(repo, wants, haves);
    const frames = sidebandFrames(outcome.pack);
    frames.push(pktLineFlush());
    return {
      status: 200,
      body: Buffer.concat(frames),
      contentType: `application/x-${service}-result`,
      headers: { 'cache-control': 'no-cache' },
    };
  }

  if (method === 'POST' && service === 'git-receive-pack') {
    // Command pkt-lines end at the flush; everything after it is raw pack data.
    const reader = new PktLineDecoder(body);
    const packets: GitPacket[] = [];
    for (;;) {
      const frame = reader.next();
      if (frame === null) break;
      packets.push(frame);
      if (frame.kind === 'flush') break;
    }
    const remainingPack = reader.takeBuffered();

    const caps = new Map<string, string>();
    const { commands, capabilities } = decodePushCommands(packets, caps);
    const sideband = capabilities.includes('side-band-64k');

    if (remainingPack.length > 0) {
      try {
        const parsed = readPack(remainingPack, oid => repo.objects.get(oid));
        for (const [oid, object] of parsed.objects) repo.objects.set(oid, object);
      } catch (problem) {
        return {
          status: 200,
          body: encodePushReport({
            unpackOk: false,
            unpackDetail: `pack parse failed: ${(problem as Error).message}`,
            refs: commands.map(command => ({ ref: command.ref, ok: false, reason: 'unpack error' })),
          }, sideband),
          contentType: `application/x-${service}-result`,
          headers: {},
        };
      }
    }

    const refReports: PushStatusReport['refs'] = [];
    let unpackOk = true;
    let unpackDetail = 'ok';
    for (const command of commands) {
      const verdict = performPush(repo, command);
      if (!verdict.ok && verdict.reason !== 'non-fast-forward') {
        unpackOk = false;
        unpackDetail = verdict.reason;
      }
      refReports.push({ ref: command.ref, ok: verdict.ok, reason: verdict.reason });
    }
    return {
      status: 200,
      body: encodePushReport({ unpackOk, unpackDetail, refs: refReports }, sideband),
      contentType: `application/x-${service}-result`,
      headers: { 'cache-control': 'no-cache' },
    };
  }

  throw new Error('unsupported git request');
}
