import { describe, expect, test } from "vite-plus/test";
import { classifyKind, dTagValue } from "../../src/domain/kinds.ts";

describe("classifyKind", () => {
  test("kind 0 (metadata) is replaceable", () => {
    expect(classifyKind(0)).toBe("replaceable");
  });

  test("kind 3 (follows) is replaceable", () => {
    expect(classifyKind(3)).toBe("replaceable");
  });

  test("kinds 1, 2, 4-44, 1000-9999 are regular", () => {
    for (const k of [1, 2, 4, 44, 1000, 9999]) {
      expect(classifyKind(k)).toBe("regular");
    }
  });

  test("kinds 10000-19999 are replaceable", () => {
    expect(classifyKind(10000)).toBe("replaceable");
    expect(classifyKind(19999)).toBe("replaceable");
  });

  test("kinds 20000-29999 are ephemeral", () => {
    expect(classifyKind(20000)).toBe("ephemeral");
    expect(classifyKind(29999)).toBe("ephemeral");
  });

  test("kinds 30000-39999 are addressable", () => {
    expect(classifyKind(30000)).toBe("addressable");
    expect(classifyKind(39999)).toBe("addressable");
  });

  test("undefined ranges default to regular", () => {
    expect(classifyKind(40000)).toBe("regular");
    expect(classifyKind(65535)).toBe("regular");
  });
});

describe("dTagValue", () => {
  test("returns the value of the first d tag", () => {
    expect(dTagValue([["d", "abc"]])).toBe("abc");
  });

  test("finds the d tag among others", () => {
    expect(
      dTagValue([
        ["e", "ref"],
        ["d", "xyz"],
        ["p", "who"],
      ]),
    ).toBe("xyz");
  });

  test("returns empty string when no d tag present", () => {
    expect(dTagValue([["e", "ref"]])).toBe("");
  });

  test("returns empty string when d tag has no value", () => {
    expect(dTagValue([["d"]])).toBe("");
  });

  test("returns the first d tag value when multiple exist", () => {
    expect(
      dTagValue([
        ["d", "first"],
        ["d", "second"],
      ]),
    ).toBe("first");
  });
});
