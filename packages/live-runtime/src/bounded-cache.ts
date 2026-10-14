/** Process-owned LRU with explicit entry and retained-unit limits; not a process-RSS guarantee. */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, { value: V; weight: number }>();
  private retainedWeight = 0;
  constructor(private readonly maximumEntries: number, private readonly maximumWeight: number,
    private readonly weigh: (value: V, key: K) => number) {}

  get size(): number { return this.entries.size; }
  get weight(): number { return this.retainedWeight; }
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: K, value: V): void {
    const previous = this.entries.get(key);
    if (previous) { this.entries.delete(key); this.retainedWeight -= previous.weight; }
    const weight = this.weigh(value, key);
    if (!Number.isFinite(weight) || weight < 0 || weight > this.maximumWeight || this.maximumEntries <= 0) return;
    while (this.entries.size >= this.maximumEntries || this.retainedWeight + weight > this.maximumWeight) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.retainedWeight -= this.entries.get(oldest.value)!.weight;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, weight });
    this.retainedWeight += weight;
  }
  clear(): void { this.entries.clear(); this.retainedWeight = 0; }
}
