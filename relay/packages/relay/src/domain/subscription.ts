import { matchesAnyFilter, type Filter } from "./filter.ts";
import type { NostrEvent } from "./validate.ts";

export interface Subscription {
  connId: string;
  subId: string;
  filters: Filter[];
}

export interface SubscriptionRegistryOptions {
  /**
   * Maximum active subscriptions per connection. When a new subscription id
   * would push a connection past this cap, `add()` returns false. Replacing
   * an existing sub (same id) is always allowed. Defaults to Infinity.
   */
  maxPerConnection?: number;
}

export class SubscriptionRegistry {
  private readonly conns = new Map<string, Map<string, Filter[]>>();
  private readonly maxPerConnection: number;

  constructor(options: SubscriptionRegistryOptions = {}) {
    this.maxPerConnection = options.maxPerConnection ?? Infinity;
  }

  /**
   * Register (or replace) a subscription. Returns false when adding a NEW
   * subscription id would exceed `maxPerConnection`. Replacing an existing
   * id is always allowed — NIP-01 says reusing an id replaces the previous
   * subscription.
   */
  add(connId: string, subId: string, filters: Filter[]): boolean {
    let subs = this.conns.get(connId);
    if (!subs) {
      if (this.maxPerConnection < 1) return false;
      subs = new Map();
      this.conns.set(connId, subs);
    }
    if (!subs.has(subId) && subs.size >= this.maxPerConnection) {
      return false;
    }
    subs.set(subId, filters);
    return true;
  }

  remove(connId: string, subId: string): boolean {
    const subs = this.conns.get(connId);
    if (!subs) return false;
    const removed = subs.delete(subId);
    if (subs.size === 0) this.conns.delete(connId);
    return removed;
  }

  removeAll(connId: string): number {
    const subs = this.conns.get(connId);
    if (!subs) return 0;
    const count = subs.size;
    this.conns.delete(connId);
    return count;
  }

  has(connId: string, subId: string): boolean {
    return this.conns.get(connId)?.has(subId) ?? false;
  }

  get(connId: string, subId: string): Filter[] | undefined {
    return this.conns.get(connId)?.get(subId);
  }

  size(): number {
    let count = 0;
    for (const subs of this.conns.values()) count += subs.size;
    return count;
  }

  connectionCount(): number {
    return this.conns.size;
  }

  *matching(event: NostrEvent): IterableIterator<Subscription> {
    for (const [connId, subs] of this.conns) {
      for (const [subId, filters] of subs) {
        if (matchesAnyFilter(filters, event)) {
          yield { connId, subId, filters };
        }
      }
    }
  }
}
