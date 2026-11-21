// Vendored from the kit's wire.ts: the seeded names the conformance suite expects. One fixed seed
// drives every identity, so generating users with the same pure functions yields the exact viewer
// login the token maps to; POST /user/repos then lands at /repos/<viewer>/<name> as checked.

const UINT64 = 0xffffffffffffffffn;

/** The contest's immutable scenario seed. */
export const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function hashText(text: string): bigint {
  let acc = 0xcbf29ce484222325n;
  for (let pos = 0; pos < text.length; pos += 1) {
    acc ^= BigInt(text.charCodeAt(pos));
    acc = (acc * 0x100000001b3n) & UINT64;
  }
  return acc;
}

function scramble(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & UINT64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & UINT64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & UINT64;
  return (z ^ (z >> 31n)) & UINT64;
}

function seedFor(label: string): bigint {
  return scramble(SCENARIO_SEED ^ hashText(label));
}

const GIVEN_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const FAMILY_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ScenarioUser {
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

class Xoroshiro {
  #state: bigint;

  constructor(seed: bigint) {
    const chopped = seed & UINT64;
    this.#state = chopped === 0n ? SCENARIO_SEED : chopped;
  }

  draw64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & UINT64;
    x = (x ^ (x << 25n)) & UINT64;
    x = (x ^ (x >> 27n)) & UINT64;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & UINT64;
  }

  draw32(): number {
    return Number(this.draw64() >> 32n);
  }

  below(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) return 0;
    if (maxExclusive === 1) return 0;
    const span = 4_294_967_296;
    const ceiling = span - (span % maxExclusive);
    for (;;) {
      const candidate = this.draw32();
      if (candidate < ceiling) return candidate % maxExclusive;
    }
  }

  choose<T>(pool: readonly T[]): T {
    return pool[this.below(pool.length)] as T;
  }
}

function makeUsers(generator: Xoroshiro, count: number): ScenarioUser[] {
  const taken = new Set<string>();
  const people: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = generator.choose(GIVEN_NAMES);
    const last = generator.choose(FAMILY_NAMES);
    const stem = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let handle = stem;
    let sequence = 2;
    while (taken.has(handle)) {
      handle = `${stem}-${sequence}`;
      sequence += 1;
    }
    taken.add(handle);
    people.push({ login: handle, name: `${first} ${last}`, email: `${handle}@example.invalid` });
  }
  return people;
}

let actorCache: { viewer: ScenarioUser; stranger: ScenarioUser } | null = null;

/** Scenario users[0] (the token's owner) and users[2] (the outsider). */
export function scenarioActors(): { viewer: ScenarioUser; stranger: ScenarioUser } {
  if (actorCache === null) {
    const people = makeUsers(new Xoroshiro(seedFor('users')), 12);
    actorCache = { viewer: people[0]!, stranger: people[2]! };
  }
  return actorCache;
}
