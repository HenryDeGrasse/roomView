export interface ObservabilityEvent {
  timestamp: string;
  operation: string;
  status: "ok" | "error";
  latency_ms: number;
  reason_code?: string | null;
  fields: Record<string, unknown>;
}

export interface OperationLatencySummary {
  count: number;
  total_ms: number;
  min_ms: number;
  max_ms: number;
  avg_ms: number;
}

export interface ObservabilitySnapshot {
  counters: Record<string, number>;
  error_counts_by_reason: Record<string, number>;
  latencies_ms: Record<string, OperationLatencySummary>;
  recent_events: ObservabilityEvent[];
}

export interface ObservabilityRecorderOptions {
  max_events?: number;
  sink?: ((event: ObservabilityEvent) => void) | null;
}

export class ObservabilityRecorder {
  private readonly maxEvents: number;
  private readonly sink: ((event: ObservabilityEvent) => void) | null;
  private readonly counters = new Map<string, number>();
  private readonly errorCountsByReason = new Map<string, number>();
  private readonly latencyTotals = new Map<string, { count: number; total_ms: number; min_ms: number; max_ms: number }>();
  private readonly recentEvents: ObservabilityEvent[] = [];

  public constructor(options: ObservabilityRecorderOptions = {}) {
    this.maxEvents = options.max_events ?? 200;
    this.sink = options.sink ?? null;
  }

  public start(operation: string, fields: Record<string, unknown> = {}): { finish: (status: "ok" | "error", outcome?: Record<string, unknown>) => ObservabilityEvent } {
    const startedAt = Date.now();
    return {
      finish: (status, outcome = {}) => {
        const event: ObservabilityEvent = {
          timestamp: new Date().toISOString(),
          operation,
          status,
          latency_ms: Math.max(0, Date.now() - startedAt),
          reason_code: typeof outcome.reason_code === "string" ? outcome.reason_code : null,
          fields: {
            ...fields,
            ...outcome,
          },
        };
        this.record(event);
        return event;
      },
    };
  }

  public snapshot(): ObservabilitySnapshot {
    const counters = Object.fromEntries(this.counters.entries());
    const error_counts_by_reason = Object.fromEntries(this.errorCountsByReason.entries());
    const latencies_ms = Object.fromEntries(
      Array.from(this.latencyTotals.entries()).map(([operation, summary]) => [
        operation,
        {
          count: summary.count,
          total_ms: summary.total_ms,
          min_ms: summary.min_ms,
          max_ms: summary.max_ms,
          avg_ms: summary.count === 0 ? 0 : roundNumber(summary.total_ms / summary.count),
        },
      ])
    );
    return {
      counters,
      error_counts_by_reason,
      latencies_ms,
      recent_events: this.recentEvents.map((event) => structuredClone(event)),
    };
  }

  private record(event: ObservabilityEvent): void {
    this.incrementCounter(`operation:${event.operation}`);
    this.incrementCounter(`status:${event.status}`);
    if (event.reason_code) {
      this.errorCountsByReason.set(event.reason_code, (this.errorCountsByReason.get(event.reason_code) ?? 0) + 1);
    }
    const latency = this.latencyTotals.get(event.operation) ?? {
      count: 0,
      total_ms: 0,
      min_ms: Number.POSITIVE_INFINITY,
      max_ms: 0,
    };
    latency.count += 1;
    latency.total_ms = roundNumber(latency.total_ms + event.latency_ms);
    latency.min_ms = Math.min(latency.min_ms, event.latency_ms);
    latency.max_ms = Math.max(latency.max_ms, event.latency_ms);
    this.latencyTotals.set(event.operation, latency);

    this.recentEvents.push(event);
    if (this.recentEvents.length > this.maxEvents) {
      this.recentEvents.splice(0, this.recentEvents.length - this.maxEvents);
    }
    this.sink?.(event);
  }

  private incrementCounter(key: string): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }
}

export function createConsoleObservabilitySink(prefix = "roomview"): (event: ObservabilityEvent) => void {
  return (event) => {
    console.info(
      JSON.stringify({
        log_type: `${prefix}_observability`,
        ...event,
      })
    );
  };
}

function roundNumber(value: number): number {
  return Math.round(value * 1000) / 1000;
}
