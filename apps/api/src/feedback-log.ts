/**
 * Feedback log — Phase 4 of graph-agent-plan.md.
 *
 * Local JSONL-backed event store for layout interactions:
 *   - `drag` events: the user translated/rotated an object locally.
 *   - `apply` events: a plan was committed.
 *   - `propose_accepted` / `propose_rejected`: the agent proposed a
 *     plan and the user accepted or dismissed it.
 *   - `rating`: thumbs up/down on an applied plan.
 *
 * Storage is a flat JSONL file at `.pi/feedback.jsonl` (gitignored).
 * No schema migrations, no remote transport — a local-first preference
 * surface the agent can read in future sessions without requiring a
 * server-side database.
 *
 * Preference extraction is intentionally minimal — it's a heuristic
 * summariser over recent events, not a model. It emits short strings
 * the agent can paste into its system prompt:
 *   "User tends to place beds flush to walls."
 *   "User rejected 2 propose_move suggestions for storage-near-bed."
 *
 * Safety: we require at least `MIN_EVENTS_FOR_PREFERENCE` events
 * matching a pattern before we lift it into the preference list.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_PATH = resolve(process.cwd(), ".pi", "feedback.jsonl");
const MAX_EVENTS_IN_MEMORY = 5000;
const MIN_EVENTS_FOR_PREFERENCE = 3;

export interface FeedbackEvent {
  event_id: string;
  kind:
    | "drag"
    | "apply"
    | "propose_accepted"
    | "propose_rejected"
    | "rating";
  scene_id?: string;
  object_id?: string;
  object_class?: string;
  details?: Record<string, unknown>;
  rating?: "up" | "down";
  captured_at: string;
}

export interface DerivedPreference {
  summary: string;
  supporting_event_count: number;
  tags: string[];
}

// ---------------------------------------------------------------------------
// File-backed log
// ---------------------------------------------------------------------------

class FeedbackLog {
  private readonly path: string;
  private readonly events: FeedbackEvent[] = [];
  private loaded = false;

  public constructor(path = DEFAULT_PATH) {
    this.path = path;
  }

  private loadIfNeeded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;
    const raw = readFileSync(this.path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as FeedbackEvent;
        this.events.push(parsed);
      } catch {
        // skip malformed lines silently
      }
    }
    if (this.events.length > MAX_EVENTS_IN_MEMORY) {
      this.events.splice(0, this.events.length - MAX_EVENTS_IN_MEMORY);
    }
  }

  public append(raw: Record<string, unknown>): FeedbackEvent {
    this.loadIfNeeded();
    const event: FeedbackEvent = {
      event_id: typeof raw.event_id === "string" && raw.event_id
        ? (raw.event_id as string)
        : `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind: (raw.kind as FeedbackEvent["kind"]) ?? "drag",
      scene_id: typeof raw.scene_id === "string" ? raw.scene_id : undefined,
      object_id: typeof raw.object_id === "string" ? raw.object_id : undefined,
      object_class: typeof raw.object_class === "string" ? raw.object_class : undefined,
      details: (raw.details && typeof raw.details === "object") ? (raw.details as Record<string, unknown>) : undefined,
      rating: raw.rating === "up" || raw.rating === "down" ? raw.rating : undefined,
      captured_at: new Date().toISOString(),
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS_IN_MEMORY) this.events.shift();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(event) + "\n", "utf8");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[feedback-log] append failed", err);
    }
    return event;
  }

  public recent(n: number): FeedbackEvent[] {
    this.loadIfNeeded();
    return this.events.slice(-n);
  }

  public all(): readonly FeedbackEvent[] {
    this.loadIfNeeded();
    return this.events;
  }

  public derivePreferences(): DerivedPreference[] {
    this.loadIfNeeded();
    const preferences: DerivedPreference[] = [];
    const classDrags = new Map<string, number>();
    for (const e of this.events) {
      if (e.kind === "drag" && e.object_class) {
        classDrags.set(e.object_class, (classDrags.get(e.object_class) ?? 0) + 1);
      }
    }
    for (const [klass, count] of classDrags) {
      if (count < MIN_EVENTS_FOR_PREFERENCE) continue;
      preferences.push({
        summary: `User frequently repositions ${klass} objects (${count} times in recent history).`,
        supporting_event_count: count,
        tags: ["drag", klass],
      });
    }
    const rejectedByClass = new Map<string, number>();
    for (const e of this.events) {
      if (e.kind === "propose_rejected" && e.object_class) {
        rejectedByClass.set(e.object_class, (rejectedByClass.get(e.object_class) ?? 0) + 1);
      }
    }
    for (const [klass, count] of rejectedByClass) {
      if (count < MIN_EVENTS_FOR_PREFERENCE) continue;
      preferences.push({
        summary: `User has rejected ${count} agent proposals involving ${klass} — treat automated ${klass} moves with extra caution.`,
        supporting_event_count: count,
        tags: ["propose_rejected", klass],
      });
    }
    const upRatings = this.events.filter((e) => e.kind === "rating" && e.rating === "up").length;
    const downRatings = this.events.filter((e) => e.kind === "rating" && e.rating === "down").length;
    if (upRatings + downRatings >= MIN_EVENTS_FOR_PREFERENCE) {
      preferences.push({
        summary: `Recent plan ratings: ${upRatings} up, ${downRatings} down.`,
        supporting_event_count: upRatings + downRatings,
        tags: ["rating"],
      });
    }
    return preferences;
  }
}

export const feedbackLog = new FeedbackLog();
