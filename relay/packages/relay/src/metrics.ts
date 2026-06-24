/**
 * Minimal metrics sink. Call sites in core/store/relay push into this; the
 * host app provides the real implementation (typically a CloudWatch EMF
 * emitter). Tests and no-ops use `nullMetrics`.
 */
export interface Metrics {
  /** Add `n` (default 1) to a counter. */
  increment(name: string, n?: number): void;
  /** Record a duration or other timing observation (milliseconds). */
  timing(name: string, ms: number): void;
}

export const nullMetrics: Metrics = {
  increment: () => {},
  timing: () => {},
};
