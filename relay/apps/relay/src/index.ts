import { startRelay } from "./server.ts";

// `startRelay` already logs `{ port } "relay listening"` through the structured
// logger — no duplicate plain-text line here so stdout stays one-JSON-per-line.
await startRelay();
