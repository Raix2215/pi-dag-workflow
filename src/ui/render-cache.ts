/**
 * Small memo helpers for the UI render path. Static values follow immutable input objects;
 * render variants have both per-snapshot and total-snapshot caps so retained session history
 * cannot keep every previously rendered frame alive. Values stay display-only.
 */

/** Insertion-ordered bounded map: `get` refreshes recency and `set` evicts the oldest entry. */
export class Lru<V> {
  private readonly entries = new Map<string, V>();
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }
  set(key: string, value: V): V {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
}

/** One value per immutable object, recomputed only when a new object identity appears. */
export function weakMemo<K extends object, V>(compute: (key: K) => V): (key: K) => V {
  const cache = new WeakMap<K, V>();
  return (key: K): V => {
    let value = cache.get(key);
    if (value === undefined) { value = compute(key); cache.set(key, value); }
    return value;
  };
}

/**
 * Bounded variants per immutable snapshot, with an additional total snapshot cap. A session
 * manager may retain old task arrays for its whole history, so weak keys alone are insufficient.
 */
export function snapshotCache<V>(capacity: number, snapshots = 4): (snapshot: object, key: string, make: () => V) => V {
  const caches = new Map<object, Lru<V>>();
  return (snapshot, key, make) => {
    let lru = caches.get(snapshot);
    if (!lru) lru = new Lru<V>(capacity);
    caches.delete(snapshot); caches.set(snapshot, lru);
    while (caches.size > snapshots) caches.delete(caches.keys().next().value!);
    const cached = lru.get(key);
    if (cached !== undefined) return cached;
    return lru.set(key, make());
  };
}

const ids = new WeakMap<object, number>();
let nextId = 0;
/** Stable identity for cache keys; the WeakMap never keeps the object alive. */
export function objectId(object: object): number {
  let id = ids.get(object);
  if (id === undefined) { id = ++nextId; ids.set(object, id); }
  return id;
}
