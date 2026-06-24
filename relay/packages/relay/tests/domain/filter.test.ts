import { describe, expect, test } from "vite-plus/test";
import { matchesAnyFilter, matchesFilter } from "../../src/domain/filter.ts";
import type { NostrEvent } from "../../src/domain/validate.ts";

function event(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: "",
    sig: "c".repeat(128),
    ...overrides,
  };
}

describe("matchesFilter: empty filter", () => {
  test("matches any event", () => {
    expect(matchesFilter({}, event())).toBe(true);
  });
});

describe("matchesFilter: ids", () => {
  test("matches when event id is in list", () => {
    const e = event({ id: "a".repeat(64) });
    expect(matchesFilter({ ids: ["a".repeat(64), "b".repeat(64)] }, e)).toBe(true);
  });

  test("rejects when event id is not in list", () => {
    expect(matchesFilter({ ids: ["b".repeat(64)] }, event({ id: "a".repeat(64) }))).toBe(false);
  });

  test("rejects on empty ids array", () => {
    expect(matchesFilter({ ids: [] }, event())).toBe(false);
  });
});

describe("matchesFilter: authors", () => {
  test("matches when pubkey is in list", () => {
    const e = event({ pubkey: "b".repeat(64) });
    expect(matchesFilter({ authors: ["b".repeat(64)] }, e)).toBe(true);
  });

  test("rejects when pubkey is not in list", () => {
    expect(matchesFilter({ authors: ["z".repeat(64)] }, event())).toBe(false);
  });

  test("rejects on empty authors array", () => {
    expect(matchesFilter({ authors: [] }, event())).toBe(false);
  });
});

describe("matchesFilter: kinds", () => {
  test("matches when kind is in list", () => {
    expect(matchesFilter({ kinds: [0, 1, 2] }, event({ kind: 1 }))).toBe(true);
  });

  test("rejects when kind is not in list", () => {
    expect(matchesFilter({ kinds: [0, 2] }, event({ kind: 1 }))).toBe(false);
  });

  test("rejects on empty kinds array", () => {
    expect(matchesFilter({ kinds: [] }, event())).toBe(false);
  });
});

describe("matchesFilter: since / until", () => {
  test("since is inclusive", () => {
    const e = event({ created_at: 1000 });
    expect(matchesFilter({ since: 1000 }, e)).toBe(true);
    expect(matchesFilter({ since: 1001 }, e)).toBe(false);
  });

  test("until is inclusive", () => {
    const e = event({ created_at: 1000 });
    expect(matchesFilter({ until: 1000 }, e)).toBe(true);
    expect(matchesFilter({ until: 999 }, e)).toBe(false);
  });

  test("since: 0 is honored (not treated as absent)", () => {
    expect(matchesFilter({ since: 0 }, event({ created_at: -1 }))).toBe(false);
    expect(matchesFilter({ since: 0 }, event({ created_at: 0 }))).toBe(true);
  });

  test("until: 0 is honored (not treated as absent)", () => {
    expect(matchesFilter({ until: 0 }, event({ created_at: 1 }))).toBe(false);
    expect(matchesFilter({ until: 0 }, event({ created_at: 0 }))).toBe(true);
  });

  test("impossible range (since > until) never matches", () => {
    const e = event({ created_at: 1000 });
    expect(matchesFilter({ since: 2000, until: 500 }, e)).toBe(false);
  });
});

describe("matchesFilter: tag filters", () => {
  test("#e matches when event has matching e tag", () => {
    const e = event({ tags: [["e", "deadbeef"]] });
    expect(matchesFilter({ "#e": ["deadbeef"] }, e)).toBe(true);
  });

  test("#e rejects when event has no e tag", () => {
    const e = event({ tags: [["p", "deadbeef"]] });
    expect(matchesFilter({ "#e": ["deadbeef"] }, e)).toBe(false);
  });

  test("#e rejects when event has e tag but different value", () => {
    const e = event({ tags: [["e", "other"]] });
    expect(matchesFilter({ "#e": ["deadbeef"] }, e)).toBe(false);
  });

  test("only the first value of a tag is matched", () => {
    const e = event({ tags: [["e", "first", "second"]] });
    expect(matchesFilter({ "#e": ["first"] }, e)).toBe(true);
    expect(matchesFilter({ "#e": ["second"] }, e)).toBe(false);
  });

  test("event with a bare tag (no value) does not match any value", () => {
    const e = event({ tags: [["e"]] });
    expect(matchesFilter({ "#e": ["anything"] }, e)).toBe(false);
  });

  test("empty tag filter array rejects everything", () => {
    const e = event({ tags: [["e", "deadbeef"]] });
    expect(matchesFilter({ "#e": [] }, e)).toBe(false);
  });

  test("multiple tag filters are ANDed", () => {
    const withBoth = event({
      tags: [
        ["e", "one"],
        ["p", "two"],
      ],
    });
    const withOnlyE = event({ tags: [["e", "one"]] });
    expect(matchesFilter({ "#e": ["one"], "#p": ["two"] }, withBoth)).toBe(true);
    expect(matchesFilter({ "#e": ["one"], "#p": ["two"] }, withOnlyE)).toBe(false);
  });

  test("non-single-letter # keys are ignored per NIP-01 indexable semantics", () => {
    const e = event({ tags: [["foo", "bar"]] });
    expect(matchesFilter({ "#foo": ["baz"] } as never, e)).toBe(true);
  });

  test("tag name matching is exact, not prefix", () => {
    const e = event({ tags: [["ee", "deadbeef"]] });
    expect(matchesFilter({ "#e": ["deadbeef"] }, e)).toBe(false);
  });
});

describe("matchesFilter: combined conditions (AND)", () => {
  test("all specified fields must match", () => {
    const e = event({ kind: 1, pubkey: "b".repeat(64), created_at: 1000 });
    expect(
      matchesFilter({ kinds: [1], authors: ["b".repeat(64)], since: 900, until: 1100 }, e),
    ).toBe(true);
    expect(matchesFilter({ kinds: [1], authors: ["b".repeat(64)], since: 1001 }, e)).toBe(false);
  });
});

describe("matchesAnyFilter", () => {
  test("returns true when any filter matches (OR)", () => {
    const e = event({ kind: 1 });
    expect(matchesAnyFilter([{ kinds: [0] }, { kinds: [1] }], e)).toBe(true);
  });

  test("returns false when no filter matches", () => {
    const e = event({ kind: 1 });
    expect(matchesAnyFilter([{ kinds: [0] }, { kinds: [2] }], e)).toBe(false);
  });

  test("returns false on empty filter list", () => {
    expect(matchesAnyFilter([], event())).toBe(false);
  });
});
