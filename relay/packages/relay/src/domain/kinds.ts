export type KindClass = "regular" | "replaceable" | "ephemeral" | "addressable";

export function classifyKind(kind: number): KindClass {
  if (kind === 0 || kind === 3) return "replaceable";
  if (kind >= 10000 && kind < 20000) return "replaceable";
  if (kind >= 20000 && kind < 30000) return "ephemeral";
  if (kind >= 30000 && kind < 40000) return "addressable";
  return "regular";
}

export function dTagValue(tags: readonly (readonly string[])[]): string {
  for (const tag of tags) {
    if (tag[0] === "d") return tag[1] ?? "";
  }
  return "";
}
