/**
 * ObservabilityRecorder unit tests.
 *
 * The recorder is the only metrics/log sink in the API; it's consumed by
 * roomplan-ingest on every user-facing operation. If its invariants drift
 * (counter keys, latency aggregation, ring buffer cap) verify:observability
 * still passes because it only checks high-level properties against fixtures.
 * These tests pin the behavior directly.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ObservabilityRecorder,
  createConsoleObservabilitySink,
  type ObservabilityEvent,
} from "../../apps/api/src/observability.ts";

describe("ObservabilityRecorder", () => {
  test("counters increment per operation and status", () => {
    const recorder = new ObservabilityRecorder();
    recorder.start("plan").finish("ok");
    recorder.start("plan").finish("error", { reason_code: "VERSION_CONFLICT" });
    recorder.start("apply").finish("ok");

    const snapshot = recorder.snapshot();
    assert.equal(snapshot.counters["operation:plan"], 2);
    assert.equal(snapshot.counters["operation:apply"], 1);
    assert.equal(snapshot.counters["status:ok"], 2);
    assert.equal(snapshot.counters["status:error"], 1);
    assert.equal(snapshot.error_counts_by_reason["VERSION_CONFLICT"], 1);
  });

  test("latency summary aggregates count/min/max/avg over multiple events", () => {
    const recorder = new ObservabilityRecorder();
    // Simulate three finishes at different durations by controlling
    // Date.now via the handle's internal start time (we can't easily mock
    // there, so use real time but call in quick succession).
    recorder.start("noop").finish("ok");
    recorder.start("noop").finish("ok");
    recorder.start("noop").finish("ok");

    const { latencies_ms } = recorder.snapshot();
    const noop = latencies_ms["noop"];
    assert.equal(noop.count, 3);
    assert.ok(noop.min_ms >= 0);
    assert.ok(noop.max_ms >= noop.min_ms);
    assert.ok(noop.avg_ms >= 0);
    assert.ok(Math.abs(noop.avg_ms - noop.total_ms / noop.count) < 0.01);
  });

  test("recent_events is capped at max_events (ring buffer behavior)", () => {
    const recorder = new ObservabilityRecorder({ max_events: 2 });
    recorder.start("a").finish("ok");
    recorder.start("b").finish("ok");
    recorder.start("c").finish("ok");

    const snapshot = recorder.snapshot();
    assert.equal(snapshot.recent_events.length, 2);
    assert.equal(snapshot.recent_events[0].operation, "b");
    assert.equal(snapshot.recent_events[1].operation, "c");
  });

  test("snapshot is a defensive copy (mutating the returned events does not leak into next snapshot)", () => {
    const recorder = new ObservabilityRecorder();
    recorder.start("a").finish("ok");
    const first = recorder.snapshot();
    first.recent_events[0].operation = "MUTATED";

    const second = recorder.snapshot();
    assert.equal(second.recent_events[0].operation, "a");
  });

  test("reason_code field is hoisted to the event only when it is a string", () => {
    const recorder = new ObservabilityRecorder();
    recorder.start("op1").finish("error", { reason_code: "VERSION_CONFLICT" });
    recorder.start("op2").finish("error", { reason_code: 123 as unknown as string });
    recorder.start("op3").finish("ok");

    const events = recorder.snapshot().recent_events;
    assert.equal(events[0].reason_code, "VERSION_CONFLICT");
    assert.equal(events[1].reason_code, null);
    assert.equal(events[2].reason_code, null);
  });

  test("custom sink receives each event", () => {
    const captured: ObservabilityEvent[] = [];
    const recorder = new ObservabilityRecorder({ sink: (event) => captured.push(event) });
    recorder.start("s", { extra: 1 }).finish("ok", { outcome_field: "x" });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].operation, "s");
    assert.equal(captured[0].fields.extra, 1);
    assert.equal(captured[0].fields.outcome_field, "x");
  });

  test("latency_ms is floored at 0 even when the clock jumps backwards", () => {
    const recorder = new ObservabilityRecorder();
    const originalNow = Date.now;
    let callCount = 0;
    (Date as unknown as { now: () => number }).now = () => {
      callCount += 1;
      // First call (start): 100, second call (finish): 0 — simulates clock going backwards.
      return callCount === 1 ? 100 : 0;
    };
    try {
      recorder.start("clock_jump").finish("ok");
    } finally {
      (Date as unknown as { now: () => number }).now = originalNow;
    }
    const event = recorder.snapshot().recent_events[0];
    assert.equal(event.latency_ms, 0);
  });
});

describe("createConsoleObservabilitySink", () => {
  test("emits JSON log with the configured prefix", () => {
    const sink = createConsoleObservabilitySink("roomview_test");
    const originalInfo = console.info;
    let captured = "";
    console.info = (msg: string) => {
      captured = msg;
    };
    try {
      sink({
        timestamp: "2026-04-17T00:00:00.000Z",
        operation: "ping",
        status: "ok",
        latency_ms: 0,
        reason_code: null,
        fields: {},
      });
    } finally {
      console.info = originalInfo;
    }
    const parsed = JSON.parse(captured);
    assert.equal(parsed.log_type, "roomview_test_observability");
    assert.equal(parsed.operation, "ping");
    assert.equal(parsed.status, "ok");
  });
});
