import { nullLogger, type Logger } from "@relay/core";
import { describe, expect, test } from "vite-plus/test";
import { createEmfMetrics } from "../src/metrics.ts";

interface CapturedLog {
  obj: Record<string, unknown>;
  msg: string | undefined;
}

function capturingLogger(): { logger: Logger; captured: CapturedLog[] } {
  const captured: CapturedLog[] = [];
  const logger: Logger = {
    debug: () => {},
    info: (obj: object, msg?: string) => {
      captured.push({ obj: obj as Record<string, unknown>, msg });
    },
    warn: () => {},
    error: () => {},
    child() {
      return logger;
    },
  };
  return { logger, captured };
}

describe("EMF metrics: counters", () => {
  test("aggregates increments across calls and emits one log line per flush", () => {
    const { logger, captured } = capturingLogger();
    const m = createEmfMetrics({ logger, flushMs: 60_000 });

    m.increment("events_stored");
    m.increment("events_stored", 2);
    m.increment("events_duplicate");
    m.flush();

    expect(captured).toHaveLength(1);
    const payload = captured[0]!.obj;
    expect(payload.events_stored).toBe(3);
    expect(payload.events_duplicate).toBe(1);

    m.stop();
  });

  test("clears counter state after flush", () => {
    const { logger, captured } = capturingLogger();
    const m = createEmfMetrics({ logger, flushMs: 60_000 });
    m.increment("x");
    m.flush();
    m.flush();
    // Second flush had no data → no new log line.
    expect(captured).toHaveLength(1);
    m.stop();
  });
});

describe("EMF metrics: EMF payload shape", () => {
  test("payload has _aws.CloudWatchMetrics with namespace and metric defs", () => {
    const { logger, captured } = capturingLogger();
    const m = createEmfMetrics({
      logger,
      namespace: "TestNs",
      dimensions: { service: "relay" },
      flushMs: 60_000,
    });

    m.increment("c1", 2);
    m.timing("t1", 42);
    m.flush();

    const payload = captured[0]!.obj;
    const aws = payload._aws as {
      Timestamp: number;
      CloudWatchMetrics: Array<{
        Namespace: string;
        Dimensions: string[][];
        Metrics: Array<{ Name: string; Unit: string }>;
      }>;
    };
    expect(aws.Timestamp).toBeTypeOf("number");
    expect(aws.CloudWatchMetrics[0]?.Namespace).toBe("TestNs");
    expect(aws.CloudWatchMetrics[0]?.Dimensions[0]).toEqual(["service"]);
    expect(payload.service).toBe("relay");

    const defs = aws.CloudWatchMetrics[0]!.Metrics;
    const byName = new Map(defs.map((d) => [d.Name, d.Unit]));
    expect(byName.get("c1")).toBe("Count");
    expect(byName.get("t1")).toBe("Milliseconds");
    m.stop();
  });
});

describe("EMF metrics: timings", () => {
  test("timings are emitted as an array for CloudWatch statistics", () => {
    const { logger, captured } = capturingLogger();
    const m = createEmfMetrics({ logger, flushMs: 60_000 });
    m.timing("event_save_duration_ms", 10);
    m.timing("event_save_duration_ms", 20);
    m.timing("event_save_duration_ms", 30);
    m.flush();

    const payload = captured[0]!.obj;
    expect(payload.event_save_duration_ms).toEqual([10, 20, 30]);
    m.stop();
  });

  test("samples are capped at maxSamplesPerTiming", () => {
    const { logger, captured } = capturingLogger();
    const m = createEmfMetrics({ logger, flushMs: 60_000, maxSamplesPerTiming: 3 });
    for (let i = 0; i < 10; i++) m.timing("d", i);
    m.flush();
    const payload = captured[0]!.obj;
    expect((payload.d as number[]).length).toBe(3);
    m.stop();
  });
});

describe("EMF metrics: gauges", () => {
  test("gauge providers are read at flush time", () => {
    const { logger, captured } = capturingLogger();
    const m = createEmfMetrics({ logger, flushMs: 60_000 });
    let live = 5;
    m.gaugeProvider("connections_active", () => live);
    m.flush();
    expect(captured[0]!.obj.connections_active).toBe(5);

    live = 12;
    m.flush();
    expect(captured[1]!.obj.connections_active).toBe(12);
    m.stop();
  });
});

describe("EMF metrics: empty flush", () => {
  test("nothing emitted when no metrics were recorded and no gauges defined", () => {
    const { logger, captured } = capturingLogger();
    const m = createEmfMetrics({ logger: nullLogger, flushMs: 60_000 });
    // Re-use captured via a different logger to double-check: pass our
    // capturing logger instead.
    const m2 = createEmfMetrics({ logger, flushMs: 60_000 });
    m2.flush();
    expect(captured).toHaveLength(0);
    m.stop();
    m2.stop();
  });
});
