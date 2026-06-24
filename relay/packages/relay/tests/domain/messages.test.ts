import { describe, expect, test } from "vite-plus/test";
import {
  closedMessage,
  eoseMessage,
  eventMessage,
  noticeMessage,
  okMessage,
  parseClientMessage,
  prefixed,
  serializeRelayMessage,
} from "../../src/domain/messages.ts";
import type { NostrEvent } from "../../src/domain/validate.ts";

const sampleEvent: NostrEvent = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1,
  kind: 1,
  tags: [],
  content: "hi",
  sig: "c".repeat(128),
};

describe("parseClientMessage: structural", () => {
  test("rejects invalid JSON string", () => {
    const r = parseClientMessage("not json");
    expect(r.ok).toBe(false);
  });

  test("rejects non-array input", () => {
    expect(parseClientMessage({ foo: 1 }).ok).toBe(false);
    expect(parseClientMessage([]).ok).toBe(false);
  });

  test("rejects when message type is not a string", () => {
    expect(parseClientMessage([42, "x"]).ok).toBe(false);
  });

  test("rejects unknown message type", () => {
    expect(parseClientMessage(["FOO"]).ok).toBe(false);
  });
});

describe("parseClientMessage: EVENT", () => {
  test("parses valid EVENT", () => {
    const r = parseClientMessage(["EVENT", sampleEvent]);
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === "EVENT") {
      expect(r.message.event).toEqual(sampleEvent);
    }
  });

  test("rejects when payload is missing", () => {
    expect(parseClientMessage(["EVENT"]).ok).toBe(false);
  });

  test("rejects when payload is not an object", () => {
    expect(parseClientMessage(["EVENT", "not an object"]).ok).toBe(false);
    expect(parseClientMessage(["EVENT", null]).ok).toBe(false);
  });

  test("rejects extra arguments", () => {
    expect(parseClientMessage(["EVENT", sampleEvent, "extra"]).ok).toBe(false);
  });

  test("does NOT validate the event (that's validateEvent's job)", () => {
    const r = parseClientMessage(["EVENT", { not: "a valid event" }]);
    expect(r.ok).toBe(true);
  });

  test("accepts raw JSON string input", () => {
    const r = parseClientMessage(JSON.stringify(["EVENT", sampleEvent]));
    expect(r.ok).toBe(true);
  });
});

describe("parseClientMessage: REQ", () => {
  test("parses valid REQ with a single filter", () => {
    const r = parseClientMessage(["REQ", "sub1", { kinds: [1] }]);
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === "REQ") {
      expect(r.message.subscriptionId).toBe("sub1");
      expect(r.message.filters).toEqual([{ kinds: [1] }]);
    }
  });

  test("parses REQ with multiple filters", () => {
    const r = parseClientMessage(["REQ", "sub1", { kinds: [0] }, { kinds: [1] }]);
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === "REQ") {
      expect(r.message.filters).toHaveLength(2);
    }
  });

  test("rejects REQ with no filters", () => {
    expect(parseClientMessage(["REQ", "sub1"]).ok).toBe(false);
  });

  test("rejects empty subscription id", () => {
    expect(parseClientMessage(["REQ", "", { kinds: [1] }]).ok).toBe(false);
  });

  test("rejects subscription id longer than 64 chars", () => {
    expect(parseClientMessage(["REQ", "x".repeat(65), { kinds: [1] }]).ok).toBe(false);
  });

  test("accepts subscription id of exactly 64 chars", () => {
    expect(parseClientMessage(["REQ", "x".repeat(64), { kinds: [1] }]).ok).toBe(true);
  });

  test("rejects non-object filter", () => {
    expect(parseClientMessage(["REQ", "sub1", "not an object"]).ok).toBe(false);
    expect(parseClientMessage(["REQ", "sub1", []]).ok).toBe(false);
  });

  test("parses tag filters with any # key", () => {
    const r = parseClientMessage(["REQ", "sub1", { "#e": ["abc"], "#d": ["xyz"] }]);
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === "REQ") {
      expect(r.message.filters[0]).toEqual({ "#e": ["abc"], "#d": ["xyz"] });
    }
  });

  test("ignores unknown filter keys for forward compatibility", () => {
    const r = parseClientMessage(["REQ", "sub1", { kinds: [1], mysteryField: "x" }]);
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === "REQ") {
      expect(r.message.filters[0]).toEqual({ kinds: [1] });
    }
  });

  test("rejects ids that is not array of strings", () => {
    expect(parseClientMessage(["REQ", "sub1", { ids: [1] }]).ok).toBe(false);
  });

  test("rejects kinds with non-integer values", () => {
    expect(parseClientMessage(["REQ", "sub1", { kinds: [1.5] }]).ok).toBe(false);
  });

  test("rejects since/until/limit that are not non-negative integers", () => {
    expect(parseClientMessage(["REQ", "sub1", { since: -1 }]).ok).toBe(false);
    expect(parseClientMessage(["REQ", "sub1", { until: 1.5 }]).ok).toBe(false);
    expect(parseClientMessage(["REQ", "sub1", { limit: "10" }]).ok).toBe(false);
  });

  test("accepts since: 0", () => {
    expect(parseClientMessage(["REQ", "sub1", { since: 0 }]).ok).toBe(true);
  });
});

describe("parseClientMessage: CLOSE", () => {
  test("parses valid CLOSE", () => {
    const r = parseClientMessage(["CLOSE", "sub1"]);
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === "CLOSE") {
      expect(r.message.subscriptionId).toBe("sub1");
    }
  });

  test("rejects when payload is missing", () => {
    expect(parseClientMessage(["CLOSE"]).ok).toBe(false);
  });

  test("rejects empty subscription id", () => {
    expect(parseClientMessage(["CLOSE", ""]).ok).toBe(false);
  });
});

describe("serializeRelayMessage", () => {
  test("EVENT", () => {
    const out = serializeRelayMessage(eventMessage("sub1", sampleEvent));
    expect(JSON.parse(out)).toEqual(["EVENT", "sub1", sampleEvent]);
  });

  test("OK accepted with empty message", () => {
    const out = serializeRelayMessage(okMessage(sampleEvent.id, true));
    expect(JSON.parse(out)).toEqual(["OK", sampleEvent.id, true, ""]);
  });

  test("OK rejected with prefix", () => {
    const out = serializeRelayMessage(
      okMessage(sampleEvent.id, false, prefixed("invalid", "bad signature")),
    );
    expect(JSON.parse(out)).toEqual(["OK", sampleEvent.id, false, "invalid: bad signature"]);
  });

  test("EOSE", () => {
    expect(JSON.parse(serializeRelayMessage(eoseMessage("sub1")))).toEqual(["EOSE", "sub1"]);
  });

  test("CLOSED", () => {
    const out = serializeRelayMessage(closedMessage("sub1", prefixed("error", "shutting down")));
    expect(JSON.parse(out)).toEqual(["CLOSED", "sub1", "error: shutting down"]);
  });

  test("NOTICE", () => {
    expect(JSON.parse(serializeRelayMessage(noticeMessage("hello")))).toEqual(["NOTICE", "hello"]);
  });
});

describe("round-trip parity", () => {
  test("EVENT message serializes to a string parseable as JSON array", () => {
    const out = serializeRelayMessage(eventMessage("sub1", sampleEvent));
    const parsed = JSON.parse(out);
    expect(parsed[0]).toBe("EVENT");
    expect(parsed[1]).toBe("sub1");
    expect(parsed[2]).toEqual(sampleEvent);
  });
});
