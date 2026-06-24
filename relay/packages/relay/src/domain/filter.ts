import type { NostrEvent } from "./validate.ts";

export interface Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [key: `#${string}`]: string[] | undefined;
}

const SINGLE_LETTER = /^[a-zA-Z]$/;

export function matchesFilter(filter: Filter, event: NostrEvent): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;

  for (const key of Object.keys(filter)) {
    if (key.length !== 2 || key[0] !== "#") continue;
    const letter = key[1]!;
    if (!SINGLE_LETTER.test(letter)) continue;
    const values = (filter as Record<string, unknown>)[key];
    if (!Array.isArray(values)) continue;
    const matched = event.tags.some((tag) => tag[0] === letter && values.includes(tag[1]));
    if (!matched) return false;
  }

  return true;
}

export function matchesAnyFilter(filters: Filter[], event: NostrEvent): boolean {
  return filters.some((f) => matchesFilter(f, event));
}
