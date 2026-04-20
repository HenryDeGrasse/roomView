/**
 * Unit tests for apps/api/src/graph-agent.ts and apps/api/src/feedback-log.ts.
 *
 * GraphAgent tests focus on the deterministic fallback + tool
 * execution — we don't hit OpenRouter in unit tests. The agent's
 * `run()` falls through to a deterministic summary when no API key is
 * present, which lets us verify shape without mocking HTTP.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { GraphAgent } from "../../apps/api/src/graph-agent.ts";
import type { Scene } from "../../packages/contracts/src/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BEDROOM110_4 = "capture-bedroom110-4-20260420-005336";

function loadScene(): Scene {
  return JSON.parse(readFileSync(resolve(repoRoot, "fixtures", "roomplan", BEDROOM110_4, "scene.json"), "utf8")) as Scene;
}

describe("GraphAgent — deterministic fallback", () => {
  test("without an API key returns a deterministic summary", async () => {
    const agent = new GraphAgent({ apiKey: undefined });
    const resp = await agent.run(loadScene(), { question: "What hard violations exist?" });
    assert.equal(resp.mode, "dry_run");
    assert.ok(resp.answer.length > 0);
    assert.ok(resp.cited_evaluation_ids.length > 0, "expected at least one cited evaluation");
  });
});

describe("FeedbackLog", () => {
  test("append + recent + derivePreferences handle a few drags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roomview-feedback-"));
    const modulePath = resolve(repoRoot, "apps/api/src/feedback-log.ts");
    // Import the module fresh by file URL (required because the singleton
    // path is resolved at construction time).
    const mod = await import(modulePath + "?t=" + Date.now());
    const store = new mod.feedbackLog.constructor(resolve(dir, "feedback.jsonl"));
    for (let i = 0; i < 3; i += 1) {
      store.append({ kind: "drag", object_class: "bed", object_id: "bed-1", details: { delta: { x: 0.1, y: 0 } } });
    }
    const prefs = store.derivePreferences();
    assert.ok(prefs.some((p: { tags: string[] }) => p.tags.includes("bed")), "expected a bed-related preference");
    const recent = store.recent(10);
    assert.equal(recent.length, 3);
    rmSync(dir, { recursive: true, force: true });
  });
});
