/**
 * Generic object pool. Used for bullets, particles, tracers, damage numbers,
 * loot meshes and AI "noise" events — anything spawned many times per second.
 */
export class ObjectPool<T> {
  private free: T[] = [];
  private activeSet = new Set<T>();

  constructor(
    private factory: () => T,
    private onAcquire?: (item: T) => void,
    private onRelease?: (item: T) => void,
    prewarm = 0
  ) {
    for (let i = 0; i < prewarm; i++) this.free.push(this.factory());
  }

  acquire(): T {
    const item = this.free.pop() ?? this.factory();
    this.activeSet.add(item);
    this.onAcquire?.(item);
    return item;
  }

  release(item: T): void {
    if (!this.activeSet.delete(item)) return;
    this.onRelease?.(item);
    this.free.push(item);
  }

  get activeCount(): number {
    return this.activeSet.size;
  }

  get pooledCount(): number {
    return this.free.length;
  }

  forEachActive(fn: (item: T) => void): void {
    for (const item of this.activeSet) fn(item);
  }

  clear(): void {
    for (const item of this.activeSet) {
      this.onRelease?.(item);
      this.free.push(item);
    }
    this.activeSet.clear();
  }
}

/** Simple ring buffer pool for numeric per-frame data. */
export class RingBuffer<T> {
  private items: T[] = [];
  private head = 0;

  constructor(private capacity: number, make: () => T) {
    for (let i = 0; i < capacity; i++) this.items.push(make());
  }

  get size(): number {
    return this.capacity;
  }

  at(i: number): T {
    return this.items[(this.head + i) % this.capacity];
  }

  push(): T {
    const item = this.items[this.head];
    this.head = (this.head + 1) % this.capacity;
    return item;
  }

  forEach(fn: (item: T) => void): void {
    for (let i = 0; i < this.capacity; i++) fn(this.at(i));
  }
}
