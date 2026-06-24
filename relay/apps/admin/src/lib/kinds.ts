/** Human labels for well-known Nostr event kinds. */
export const KIND_LABELS: Record<number, string> = {
  0: "metadata",
  1: "note",
  3: "contacts",
  4: "DM",
  5: "delete",
  6: "repost",
  7: "reaction",
  1984: "report",
  9735: "zap",
  10002: "relays",
  30023: "article",
};

/** Common kinds offered in the events filter. */
export const KIND_OPTIONS = [0, 1, 3, 4, 5, 6, 7, 1984, 9735, 10002, 30023];
