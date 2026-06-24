import type { Logger, Metrics } from "@relay/core";

export interface EmfMetricsOptions {
  logger: Logger;
  /** CloudWatch namespace. */
  namespace?: string;
  /** Dimension fields applied to every metric. */
  dimensions?: Record<string, string>;
  /** Flush period. Default 60_000 ms. */
  flushMs?: number;
  /** Bound on retained timing samples per metric to cap emitted log size. */
  maxSamplesPerTiming?: number;
}

export interface EmfMetrics extends Metrics {
  /** Register a gauge read at flush time. */
  gaugeProvider(name: string, fn: () => number): void;
  /** Flush buffered metrics to the logger immediately. */
  flush(): void;
  /** Stop the periodic flush timer. */
  stop(): void;
}

/**
 * Aggregates counters + timings in memory and emits them as a single
 * CloudWatch Embedded Metric Format log line at a fixed interval.
 *
 * CloudWatch Logs (via the log subscription on our ECS task) parses the
 * `_aws.CloudWatchMetrics` header and publishes the metrics automatically —
 * no scraping agent or separate metrics endpoint needed.
 */
export function createEmfMetrics(options: EmfMetricsOptions): EmfMetrics {
  const logger = options.logger.child({ component: "metrics" });
  const namespace = options.namespace ?? "Relay";
  const dimensions = options.dimensions ?? {};
  const flushMs = options.flushMs ?? 60_000;
  const maxSamples = options.maxSamplesPerTiming ?? 1000;

  const counters = new Map<string, number>();
  const timings = new Map<string, number[]>();
  const gaugeProviders = new Map<string, () => number>();

  const metrics: EmfMetrics = {
    increment(name, n = 1) {
      counters.set(name, (counters.get(name) ?? 0) + n);
    },
    timing(name, ms) {
      const arr = timings.get(name) ?? [];
      if (arr.length < maxSamples) arr.push(ms);
      timings.set(name, arr);
    },
    gaugeProvider(name, fn) {
      gaugeProviders.set(name, fn);
    },
    flush() {
      emit();
    },
    stop() {
      clearInterval(timer);
    },
  };

  function emit(): void {
    const gauges: Record<string, number> = {};
    for (const [name, fn] of gaugeProviders) {
      try {
        gauges[name] = fn();
      } catch {
        // ignore gauge read errors
      }
    }

    const hasCounters = counters.size > 0;
    const hasTimings = timings.size > 0;
    const hasGauges = Object.keys(gauges).length > 0;
    if (!hasCounters && !hasTimings && !hasGauges) return;

    const metricDefs: Array<{ Name: string; Unit: string }> = [];
    const values: Record<string, string | number | number[]> = { ...dimensions };

    for (const [name, count] of counters) {
      metricDefs.push({ Name: name, Unit: "Count" });
      values[name] = count;
    }
    for (const [name, samples] of timings) {
      if (samples.length === 0) continue;
      metricDefs.push({ Name: name, Unit: "Milliseconds" });
      values[name] = samples;
    }
    for (const [name, value] of Object.entries(gauges)) {
      metricDefs.push({ Name: name, Unit: "None" });
      values[name] = value;
    }

    const payload = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: namespace,
            Dimensions: Object.keys(dimensions).length > 0 ? [Object.keys(dimensions)] : [[]],
            Metrics: metricDefs,
          },
        ],
      },
      ...values,
    };

    logger.info(payload, "emf");

    counters.clear();
    timings.clear();
  }

  const timer = setInterval(emit, flushMs);
  timer.unref();

  return metrics;
}
