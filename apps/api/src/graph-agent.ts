/**
 * Graph agent — Phase 3 of graph-agent-plan.md.
 *
 * An LLM-driven read + propose agent that operates on the scene graph
 * (Phase 1) and constraint report (Phase 2). It answers spatial
 * questions, proposes moves, and cites the exact edges / evaluations
 * that support its answer. It does NOT commit scene mutations; commits
 * go through the existing planner/apply pipeline only after the user
 * approves a proposed move in the UI.
 *
 * Tool surface (JSON-schema tools for OpenRouter function calling):
 *   - query_graph({ node_kind?, object_class?, edge_kind?, from?, to? })
 *     → Cypher-lite filter over the current graph.
 *   - describe_node({ node_id })
 *     → Node + its first-degree neighbourhood.
 *   - evaluate_constraints({ only_failing? })
 *     → Current constraint report, optionally filtered.
 *   - list_constraints()
 *     → Registered constraint catalogue.
 *   - propose_move({ object_id, target_position, target_yaw_degrees? })
 *     → Dry-run: clone the scene, apply the move, rebuild graph +
 *       constraints, return before/after summary + diff.
 *   - find_free_spots({ class_hint?, min_size_x?, min_size_y?,
 *       near_node_id?, max_samples? })
 *     → Sample grid points on the floor polygon, return candidates
 *       that don't overlap any existing object's footprint.
 *   - finalize({ answer, cited_evaluation_ids?, cited_edge_ids?, proposed_plan? })
 *     → Close the loop. The agent must end with exactly one finalize
 *       call producing the user-visible answer.
 *
 * Environment:
 *   OPENROUTER_API_KEY, OPENROUTER_MODEL (overridable per-call)
 *   ROOMVIEW_AGENT_MAX_STEPS, ROOMVIEW_AGENT_TEMPERATURE,
 *   ROOMVIEW_AGENT_DRY_RUN
 *
 * The agent is explicitly dry-run: it never calls /apply itself. It
 * returns a `proposed_plan` in the final envelope; the UI surfaces the
 * plan to the user and commits only if they click through.
 */
import type { Scene } from "@roomview/contracts";
import { buildSceneGraph, type SceneGraph, type GraphNode, type GraphEdge } from "./scene-graph";
import {
  createDefaultConstraintEngine,
  type ConstraintEngine,
  type ConstraintReport,
} from "./constraint-engine";
import { feedbackLog, type DerivedPreference } from "./feedback-log";

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-4o-mini";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphAgentRequest {
  question: string;
  conversation_history?: Array<{ role: "user" | "assistant"; content: string }>;
  max_steps?: number;
  selection_entity_id?: string | null;
}

export interface ProposedPlan {
  kind: "move" | "rotate";
  object_id: string;
  delta: { x?: number; y?: number; yaw_degrees?: number };
  from: { x: number; y: number; yaw_degrees: number };
  to: { x: number; y: number; yaw_degrees: number };
  expected_constraint_delta: {
    hard_fail_before: number;
    hard_fail_after: number;
    soft_warn_before: number;
    soft_warn_after: number;
  };
}

export interface GraphAgentStep {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}

export interface GraphAgentResponse {
  answer: string;
  steps: GraphAgentStep[];
  cited_edge_ids: string[];
  cited_evaluation_ids: string[];
  proposed_plan: ProposedPlan | null;
  mode: "live" | "dry_run";
}

interface AgentContext {
  scene: Scene;
  graph: SceneGraph;
  report: ConstraintReport;
  engine: ConstraintEngine;
}

// ---------------------------------------------------------------------------
// Public class
// ---------------------------------------------------------------------------

export interface GraphAgentOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  siteUrl?: string;
  appName?: string;
  maxSteps?: number;
  temperature?: number;
  timeoutMs?: number;
  dryRun?: boolean;
  /**
   * Closure that returns the derived-preference list to prepend to the
   * agent's system prompt. Defaults to reading the process-wide
   * feedbackLog singleton. Injectable for tests + for callers that want
   * to opt out of feedback entirely (pass `() => []`).
   */
  preferencesProvider?: () => readonly DerivedPreference[];
}

export class GraphAgent {
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly siteUrl: string;
  private readonly appName: string;
  private readonly maxSteps: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly dryRun: boolean;
  private readonly preferencesProvider: () => readonly DerivedPreference[];

  public constructor(options: GraphAgentOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? null;
    this.model = options.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
    this.baseUrl = options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL;
    this.siteUrl = options.siteUrl ?? process.env.ROOMVIEW_SITE_URL ?? "http://127.0.0.1:3000";
    this.appName = options.appName ?? process.env.ROOMVIEW_APP_NAME ?? "RoomView Graph Agent";
    this.maxSteps = options.maxSteps ?? Number(process.env.ROOMVIEW_AGENT_MAX_STEPS ?? DEFAULT_MAX_STEPS);
    this.temperature = options.temperature ?? Number(process.env.ROOMVIEW_AGENT_TEMPERATURE ?? DEFAULT_TEMPERATURE);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.dryRun = options.dryRun ?? (process.env.ROOMVIEW_AGENT_DRY_RUN !== "false");
    this.preferencesProvider = options.preferencesProvider ?? (() => feedbackLog.derivePreferences());
  }

  private readPreferences(): readonly DerivedPreference[] {
    try {
      return this.preferencesProvider();
    } catch (err) {
      // A corrupt feedback.jsonl should never break the agent — log and
      // run without preferences.
      // eslint-disable-next-line no-console
      console.warn("[graph-agent] preferencesProvider failed", err);
      return [];
    }
  }

  public async run(scene: Scene, request: GraphAgentRequest): Promise<GraphAgentResponse> {
    const engine = createDefaultConstraintEngine();
    const graph = buildSceneGraph(scene);
    const report = engine.evaluate(graph);
    const context: AgentContext = { scene, graph, report, engine };

    // Without an API key we fall back to a deterministic "summarize"
    // response so the endpoint remains usable in offline dev.
    if (!this.apiKey) {
      return deterministicFallback(context, request);
    }

    // Phase 4 feedback loop: pull local preference summaries derived
    // from accumulated drag / propose_rejected / rating events and
    // prepend them to the system prompt so the agent can bias its
    // suggestions toward what the user historically accepts. Gated
    // by MIN_EVENTS_FOR_PREFERENCE inside derivePreferences() — no
    // preference appears until there's enough signal, so the empty
    // case is harmless.
    const preferences = this.readPreferences();
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(preferences) },
      { role: "user", content: buildUserPrompt(scene, graph, report, request) },
    ];

    const steps: GraphAgentStep[] = [];
    const citedEdgeIds: string[] = [];
    const citedEvaluationIds: string[] = [];
    let proposedPlan: ProposedPlan | null = null;
    // Stash the richest plan the agent generated. `propose_move` tool
    // executions carry the full {from,to,delta,expected_constraint_delta}
    // envelope; when the agent later calls `finalize` with a
    // proposed_plan, we prefer this stashed version over the minimal
    // {object_id,target_x,target_y} stub the LLM emits.
    let lastProposeMovePlan: ProposedPlan | null = null;
    let finalAnswer: string | null = null;

    for (let step = 1; step <= this.maxSteps; step += 1) {
      const assistant = await this.complete(messages);
      if (!assistant) throw new Error("Graph agent: OpenRouter returned no message.");
      messages.push({
        role: "assistant",
        content: assistant.content ?? "",
        tool_calls: assistant.tool_calls,
      });
      if (!Array.isArray(assistant.tool_calls) || assistant.tool_calls.length === 0) {
        // Model didn't call a tool — treat content as the final answer.
        finalAnswer = assistant.content ?? "(no answer)";
        break;
      }
      let shouldBreak = false;
      for (const call of assistant.tool_calls) {
        const args = safeParseJson(call.function?.arguments ?? "{}");
        const tool = call.function?.name ?? "";
        const execution = runTool(tool, args, context);
        steps.push({ step, tool, args, summary: execution.summary });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(execution.payload).slice(0, 8000),
        });
        if (execution.lastProposedPlan) {
          lastProposeMovePlan = execution.lastProposedPlan;
        }
        if (tool === "finalize") {
          finalAnswer = typeof args.answer === "string" ? args.answer : "(no answer)";
          const citedEdges = Array.isArray(args.cited_edge_ids) ? args.cited_edge_ids.filter((v: unknown): v is string => typeof v === "string") : [];
          const citedEvals = Array.isArray(args.cited_evaluation_ids) ? args.cited_evaluation_ids.filter((v: unknown): v is string => typeof v === "string") : [];
          citedEdgeIds.push(...citedEdges);
          citedEvaluationIds.push(...citedEvals);
          if (args.proposed_plan && typeof args.proposed_plan === "object") {
            // Prefer the richest plan we've seen — propose_move's full
            // envelope (from/to/delta/expected_constraint_delta) over
            // finalize's minimal stub.
            proposedPlan = lastProposeMovePlan ?? (args.proposed_plan as ProposedPlan);
          } else if (lastProposeMovePlan) {
            proposedPlan = lastProposeMovePlan;
          }
          shouldBreak = true;
          break;
        }
      }
      if (shouldBreak) break;
    }

    return {
      answer: finalAnswer ?? "Agent exceeded step budget without finishing.",
      steps,
      cited_edge_ids: citedEdgeIds,
      cited_evaluation_ids: citedEvaluationIds,
      proposed_plan: proposedPlan,
      mode: this.dryRun ? "dry_run" : "live",
    };
  }

  private async complete(messages: ChatMessage[]): Promise<ChatMessage | null> {
    if (!this.apiKey) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": this.siteUrl,
          "X-Title": this.appName,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: this.temperature,
          messages,
          tools: buildToolDefinitions(),
          tool_choice: "auto",
          parallel_tool_calls: false,
        }),
        signal: controller.signal,
      });
      const payload = (await response.json()) as { choices?: Array<{ message?: ChatMessage }>; error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? `OpenRouter HTTP ${response.status}`);
      return payload.choices?.[0]?.message ?? null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function buildSystemPrompt(preferences: readonly DerivedPreference[] = []): string {
  // Preferences come from the local feedback log — short heuristic
  // summaries derived from drag / propose_rejected / rating events.
  // They're advisory: the agent may weigh them, but constraint
  // violations still win over preference hints.
  const preferenceBlock = preferences.length
    ? [
        "",
        "User preferences (from recent session history — advisory, do not override hard constraints):",
        ...preferences.map((p) => `- ${p.summary}`),
        "",
      ].join("\n")
    : "";
  return [
    "You are the RoomView graph agent. You answer spatial questions about a captured room",
    "by querying a read-only scene graph and a constraint engine, and optionally proposing",
    "a dry-run move. You never commit changes; the user will approve any proposed move",
    "themselves.",
    preferenceBlock,
    "",
    "Coordinate frame: XY on the floor plane (+x east, +y north, +z up). Units are metres.",
    "Yaw is degrees, normalised to (-180, 180].",
    "",
    "Hard rules:",
    "- Never invent node IDs, entity IDs, or numeric coordinates. Always derive them from tool output.",
    "- Always finish by calling the `finalize` tool with the user-visible answer.",
    "- Cite evidence: include at least one edge_id or evaluation_id whenever you make a",
    "  claim about relations or violations.",
    "- If the user asks a question that the graph cannot answer (e.g. 'what colour is the",
    "  sofa?'), explain the limitation and finalize.",
    "",
    "Typical flows:",
    "- Diagnostic: describe_node → evaluate_constraints → finalize.",
    "- Planning (move): evaluate_constraints → find_free_spots → propose_move → finalize.",
    "- Discovery (can X fit?): query_graph → find_free_spots → finalize.",
    "",
    "Budget hygiene:",
    "- You have a hard tool-call budget. Don't chain more than two of the same tool",
    "  with similar arguments. If find_free_spots keeps returning 0 candidates, the",
    "  room is genuinely too crowded — finalize with that explanation instead of",
    "  retrying.",
    "- propose_move accepts either the raw object_id ('object-scene-...-obje-abcd')",
    "  or the graph node_id ('object:object-scene-...-obje-abcd'). Both work.",
    "- Even when find_free_spots returns nothing, you may still try one propose_move",
    "  with an educated guess — the dry-run report tells you whether violations",
    "  improved. Cap that at ONE attempt; if it doesn't help, finalize.",
  ].join("\n");
}

function buildUserPrompt(
  scene: Scene,
  graph: SceneGraph,
  report: ConstraintReport,
  request: GraphAgentRequest
): string {
  const room = scene.snapshot.state.room;
  const headline = [
    `Question: ${request.question}`,
    `Scene: ${scene.head.scene_id} (version ${scene.head.current_scene_version})`,
    `Room: ${room.room_type}, floor_area_m2=${graph.room_summary.floor_area_m2}, ceiling_height_m=${graph.room_summary.ceiling_height_m}`,
    `Counts: ${graph.room_summary.object_count} objects, ${graph.room_summary.wall_count} walls, ${graph.room_summary.opening_count} openings.`,
    `Selected: ${request.selection_entity_id ?? "(none)"}`,
    `Constraints: ${report.summary.hard_fail} hard, ${report.summary.soft_warn} soft, ${report.summary.ok} ok.`,
  ].join("\n");
  const history = request.conversation_history?.length
    ? `\nPrior turns:\n${request.conversation_history.map((m) => `- ${m.role}: ${m.content}`).join("\n")}`
    : "";
  return `${headline}${history}\n\nCall tools to investigate, then finalize.`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function buildToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "query_graph",
        description: "Filter the current graph by node + edge predicates. Returns up to 30 matches.",
        parameters: {
          type: "object",
          properties: {
            node_kind: { type: "string", enum: ["object", "wall", "opening", "floor", "ceiling"] },
            object_class: { type: "string" },
            edge_kind: { type: "string" },
            from_node_id: { type: "string" },
            to_node_id: { type: "string" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "describe_node",
        description: "Describe a node and its first-degree neighbourhood.",
        parameters: {
          type: "object",
          properties: { node_id: { type: "string" } },
          required: ["node_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "evaluate_constraints",
        description: "Return the current constraint report. Set only_failing=true for just hard_fail + soft_warn.",
        parameters: {
          type: "object",
          properties: { only_failing: { type: "boolean" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_constraints",
        description: "List all registered constraint definitions (id, kind, severity, statement).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "propose_move",
        description:
          "Dry-run: move an object to a target position/yaw, rebuild the graph + constraint report, return before/after counts and the diff of hard_fail / soft_warn.",
        parameters: {
          type: "object",
          properties: {
            object_id: { type: "string" },
            target_x: { type: "number" },
            target_y: { type: "number" },
            target_yaw_degrees: { type: "number" },
          },
          required: ["object_id", "target_x", "target_y"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "find_free_spots",
        description:
          "Sample floor locations that don't overlap any existing object's footprint. Optional class_hint filters by room zone heuristics. Returns up to `max_samples` candidates.",
        parameters: {
          type: "object",
          properties: {
            min_size_x: { type: "number" },
            min_size_y: { type: "number" },
            near_node_id: { type: "string" },
            max_samples: { type: "integer", minimum: 1, maximum: 20 },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "finalize",
        description:
          "Close the session with the final user-visible answer. Cite edge_ids and evaluation_ids you used. Include proposed_plan when you want the UI to offer a move preview.",
        parameters: {
          type: "object",
          properties: {
            answer: { type: "string" },
            cited_edge_ids: { type: "array", items: { type: "string" } },
            cited_evaluation_ids: { type: "array", items: { type: "string" } },
            proposed_plan: {
              type: "object",
              properties: {
                object_id: { type: "string" },
                target_x: { type: "number" },
                target_y: { type: "number" },
                target_yaw_degrees: { type: "number" },
              },
            },
          },
          required: ["answer"],
        },
      },
    },
  ];
}

type ToolExecution = {
  payload: unknown;
  summary: string;
  lastProposedPlan?: ProposedPlan | null;
};

function runTool(tool: string, args: Record<string, unknown>, context: AgentContext): ToolExecution {
  switch (tool) {
    case "query_graph":
      return runQueryGraph(args, context);
    case "describe_node":
      return runDescribeNode(args, context);
    case "evaluate_constraints":
      return runEvaluateConstraints(args, context);
    case "list_constraints":
      return runListConstraints(context);
    case "propose_move":
      return runProposeMove(args, context);
    case "find_free_spots":
      return runFindFreeSpots(args, context);
    case "finalize":
      return { payload: { ok: true }, summary: "finalized" };
    default:
      return { payload: { error: `Unknown tool ${tool}` }, summary: `unknown_tool:${tool}` };
  }
}

function runQueryGraph(args: Record<string, unknown>, ctx: AgentContext): ToolExecution {
  const nodeKind = args.node_kind;
  const objectClass = args.object_class;
  const edgeKind = args.edge_kind;
  const from = args.from_node_id;
  const to = args.to_node_id;
  const nodes = ctx.graph.nodes.filter((n) => {
    if (nodeKind && n.kind !== nodeKind) return false;
    if (objectClass && (n.kind !== "object" || n.object_class !== objectClass)) return false;
    return true;
  }).slice(0, 30);
  const edges = ctx.graph.edges.filter((e) => {
    if (edgeKind && e.kind !== edgeKind) return false;
    if (from && e.from_node_id !== from) return false;
    if (to && e.to_node_id !== to) return false;
    return true;
  }).slice(0, 30);
  return {
    payload: {
      nodes: nodes.map(compactNode),
      edges: edges.map(compactEdge),
    },
    summary: `matched ${nodes.length} nodes, ${edges.length} edges`,
  };
}

function runDescribeNode(args: Record<string, unknown>, ctx: AgentContext): ToolExecution {
  const id = String(args.node_id ?? "");
  // Accept either the prefixed graph node_id ("object:object-scene-...")
  // or the raw entity_id ("object-scene-..."). Same leniency as
  // propose_move — the agent commonly copies the selection_entity_id
  // verbatim from the user-prompt header, which is the raw form.
  const node =
    ctx.graph.nodes.find((n) => n.node_id === id) ??
    ctx.graph.nodes.find((n) => {
      if (n.kind === "object") return n.object_id === id;
      if (n.kind === "wall") return n.wall_ref_id === id;
      if (n.kind === "opening") return n.opening_id === id;
      return false;
    });
  if (!node) return { payload: { error: "UNKNOWN_NODE", node_id: id }, summary: `describe_node:${id}:missing` };
  const neighbourEdges = ctx.graph.edges.filter((e) => e.from_node_id === node.node_id || e.to_node_id === node.node_id).slice(0, 40);
  return {
    payload: {
      node: compactNode(node),
      neighbours: neighbourEdges.map(compactEdge),
    },
    summary: `described ${id} · ${neighbourEdges.length} edges`,
  };
}

function runEvaluateConstraints(args: Record<string, unknown>, ctx: AgentContext): ToolExecution {
  const onlyFailing = Boolean(args.only_failing);
  const filtered = onlyFailing
    ? ctx.report.evaluations.filter((e) => e.status !== "ok")
    : ctx.report.evaluations;
  return {
    payload: {
      summary: ctx.report.summary,
      evaluations: filtered.map((e) => ({
        evaluation_id: e.evaluation_id,
        constraint_id: e.constraint_id,
        kind: e.kind,
        status: e.status,
        message: e.message,
        edge_ids: e.edge_ids,
        node_ids: e.node_ids,
      })).slice(0, 40),
    },
    summary: `${filtered.length} evaluations`,
  };
}

function runListConstraints(ctx: AgentContext): ToolExecution {
  return {
    payload: {
      constraints: ctx.engine.list().map((def) => ({
        constraint_id: def.constraint_id,
        kind: def.kind,
        severity: def.severity,
        statement: def.statement,
      })),
    },
    summary: `${ctx.engine.list().length} constraints`,
  };
}

function runProposeMove(args: Record<string, unknown>, ctx: AgentContext): ToolExecution {
  // Accept either the raw entity id ("object-scene-...") or the
  // prefixed graph node_id ("object:object-scene-..."). The agent is
  // often shown node_ids in query_graph output and copies them back,
  // so the prefix stripping keeps the flow from wasting a tool call.
  const rawId = String(args.object_id ?? "");
  const objectId = rawId.startsWith("object:") ? rawId.slice("object:".length) : rawId;
  const targetX = Number(args.target_x);
  const targetY = Number(args.target_y);
  const targetYaw = args.target_yaw_degrees === undefined ? undefined : Number(args.target_yaw_degrees);
  const before = ctx.report.summary;
  const targetNode = ctx.graph.nodes.find((n) => n.kind === "object" && n.object_id === objectId);
  if (!targetNode) {
    return {
      payload: { error: "UNKNOWN_OBJECT", object_id: objectId },
      summary: `propose_move:${objectId}:unknown`,
    };
  }
  const cloned: Scene = JSON.parse(JSON.stringify(ctx.scene));
  const clonedObject = cloned.snapshot.state.room.objects.find((o) => o.object_id === objectId);
  if (!clonedObject) {
    return {
      payload: { error: "UNKNOWN_OBJECT_IN_CLONE", object_id: objectId },
      summary: `propose_move:${objectId}:clone_miss`,
    };
  }
  const dx = targetX - clonedObject.obb.center.x;
  const dy = targetY - clonedObject.obb.center.y;
  clonedObject.obb.center.x = targetX;
  clonedObject.obb.center.y = targetY;
  clonedObject.pose.position.x = targetX;
  clonedObject.pose.position.y = targetY;
  if (Number.isFinite(targetYaw)) {
    clonedObject.obb.yaw_degrees = targetYaw as number;
    clonedObject.pose.yaw_degrees = targetYaw as number;
  }
  if (clonedObject.footprint_polygon && Array.isArray(clonedObject.footprint_polygon.vertices)) {
    for (const v of clonedObject.footprint_polygon.vertices) {
      v.x += dx;
      v.y += dy;
    }
  }
  const newGraph = buildSceneGraph(cloned);
  const newReport = ctx.engine.evaluate(newGraph);
  const plan: ProposedPlan = {
    kind: Number.isFinite(targetYaw) && targetYaw !== targetNode.yaw_degrees ? "rotate" : "move",
    object_id: objectId,
    delta: { x: dx, y: dy, yaw_degrees: Number.isFinite(targetYaw) ? (targetYaw as number) - targetNode.yaw_degrees : undefined },
    from: {
      x: ctx.scene.snapshot.state.room.objects.find((o) => o.object_id === objectId)!.obb.center.x,
      y: ctx.scene.snapshot.state.room.objects.find((o) => o.object_id === objectId)!.obb.center.y,
      yaw_degrees: targetNode.yaw_degrees,
    },
    to: {
      x: targetX,
      y: targetY,
      yaw_degrees: Number.isFinite(targetYaw) ? (targetYaw as number) : targetNode.yaw_degrees,
    },
    expected_constraint_delta: {
      hard_fail_before: before.hard_fail,
      hard_fail_after: newReport.summary.hard_fail,
      soft_warn_before: before.soft_warn,
      soft_warn_after: newReport.summary.soft_warn,
    },
  };
  return {
    payload: {
      before: before,
      after: newReport.summary,
      plan,
    },
    summary: `move ${objectId} → (${targetX.toFixed(2)}, ${targetY.toFixed(2)}) · ${before.hard_fail}→${newReport.summary.hard_fail} hard_fail`,
    lastProposedPlan: plan,
  };
}

function runFindFreeSpots(args: Record<string, unknown>, ctx: AgentContext): ToolExecution {
  // Bigger default sample budget + finer grid step, so tight rooms still
  // surface a handful of viable candidates instead of returning 0 and
  // sending the agent into a retry loop.
  const minSizeX = Math.max(0.05, Number(args.min_size_x ?? 0.3));
  const minSizeY = Math.max(0.05, Number(args.min_size_y ?? 0.3));
  const maxSamples = Math.max(1, Math.min(20, Number(args.max_samples ?? 10)));
  const nearNode = args.near_node_id ? ctx.graph.nodes.find((n) => n.node_id === args.near_node_id) : null;
  const floor = ctx.graph.nodes.find((n) => n.kind === "floor");
  if (!floor || floor.kind !== "floor") return { payload: { candidates: [] }, summary: "no floor" };
  const bounds = floor.bounds;
  const step = Math.max(0.15, Math.min(minSizeX, minSizeY) * 0.6);
  const candidates: Array<{ x: number; y: number; clearance_m: number }> = [];
  for (let x = bounds.min_x + minSizeX / 2; x <= bounds.max_x - minSizeX / 2 && candidates.length < 200; x += step) {
    for (let y = bounds.min_y + minSizeY / 2; y <= bounds.max_y - minSizeY / 2 && candidates.length < 200; y += step) {
      const rect = rectangleAroundPoint(x, y, minSizeX, minSizeY);
      // All four rectangle corners must sit inside the floor polygon —
      // the previous version only checked the center point, which let
      // the agent propose placements that clipped the walls. Testing
      // the corners rules out partial-wall-clip candidates at the
      // cost of also skipping legal spots on concave walls, which is
      // fine for Phase-1 planning.
      if (!pointInPolygon2D(x, y, floor.polygon.vertices)) continue;
      let allCornersInside = true;
      for (const corner of rect) {
        if (!pointInPolygon2D(corner.x, corner.y, floor.polygon.vertices)) {
          allCornersInside = false;
          break;
        }
      }
      if (!allCornersInside) continue;
      let collision = false;
      let nearest = Infinity;
      for (const node of ctx.graph.nodes) {
        if (node.kind !== "object") continue;
        if (rectPolygonIntersects(rect, node.footprint_polygon.vertices)) { collision = true; break; }
        const dist = distancePointToPolygon(x, y, node.footprint_polygon.vertices);
        if (dist < nearest) nearest = dist;
      }
      if (collision) continue;
      candidates.push({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), clearance_m: Number(nearest.toFixed(2)) });
    }
  }
  if (nearNode) {
    const anchor = "centroid" in nearNode ? (nearNode as { centroid: { x: number; y: number } }).centroid : null;
    if (anchor) {
      candidates.sort((a, b) => Math.hypot(a.x - anchor.x, a.y - anchor.y) - Math.hypot(b.x - anchor.x, b.y - anchor.y));
    }
  } else {
    candidates.sort((a, b) => b.clearance_m - a.clearance_m);
  }
  return {
    payload: { candidates: candidates.slice(0, maxSamples) },
    summary: `${Math.min(candidates.length, maxSamples)} free spots`,
  };
}

// ---------------------------------------------------------------------------
// Offline fallback
// ---------------------------------------------------------------------------

function deterministicFallback(ctx: AgentContext, request: GraphAgentRequest): GraphAgentResponse {
  const { graph, report } = ctx;
  const lines: string[] = [];
  lines.push(`Scene ${graph.scene_id} (v${graph.scene_version}) has ${graph.room_summary.object_count} objects, ${graph.room_summary.opening_count} openings.`);
  const hard = report.evaluations.filter((e) => e.status === "hard_fail");
  const soft = report.evaluations.filter((e) => e.status === "soft_warn");
  if (hard.length > 0) {
    lines.push(`There are ${hard.length} hard violation${hard.length === 1 ? "" : "s"}:`);
    for (const h of hard.slice(0, 5)) lines.push(`  - ${h.message}`);
  } else {
    lines.push("No hard violations.");
  }
  if (soft.length > 0) {
    lines.push(`Soft warnings: ${soft.length}.`);
  }
  lines.push("");
  lines.push("(No OPENROUTER_API_KEY configured — this is a deterministic summary. Set OPENROUTER_API_KEY in .env to enable the LLM graph agent.)");
  return {
    answer: lines.join("\n"),
    steps: [],
    cited_edge_ids: [],
    cited_evaluation_ids: hard.map((e) => e.evaluation_id),
    proposed_plan: null,
    mode: "dry_run",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compactNode(node: GraphNode): Record<string, unknown> {
  const base: Record<string, unknown> = {
    node_id: node.node_id,
    kind: node.kind,
    label: node.label,
    source_entity_id: node.source_entity_id,
  };
  if (node.kind === "object") {
    base.object_class = node.object_class;
    base.centroid = node.centroid;
    base.yaw_degrees = node.yaw_degrees;
    base.size = { x: node.obb.size_x, y: node.obb.size_y, z: node.obb.size_z };
  } else if (node.kind === "wall") {
    base.name = node.name;
    base.length_m = node.length_m;
    base.centroid = node.centroid;
  } else if (node.kind === "opening") {
    base.type = node.type;
    base.centroid = node.centroid;
    base.host_wall_node_id = node.host_wall_node_id;
  } else if (node.kind === "floor") {
    base.area_m2 = node.area_m2;
  }
  return base;
}

function compactEdge(edge: GraphEdge): Record<string, unknown> {
  return {
    edge_id: edge.edge_id,
    kind: edge.kind,
    from: edge.from_node_id,
    to: edge.to_node_id,
    symmetric: edge.symmetric,
    evidence: edge.evidence,
  };
}

function safeParseJson(text: string): Record<string, unknown> {
  try { return JSON.parse(text); } catch { return {}; }
}

function rectangleAroundPoint(cx: number, cy: number, sx: number, sy: number): Array<{ x: number; y: number }> {
  const hx = sx / 2, hy = sy / 2;
  return [
    { x: cx - hx, y: cy - hy },
    { x: cx + hx, y: cy - hy },
    { x: cx + hx, y: cy + hy },
    { x: cx - hx, y: cy + hy },
  ];
}

function pointInPolygon2D(px: number, py: number, vertices: readonly { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const xi = vertices[i]!.x;
    const yi = vertices[i]!.y;
    const xj = vertices[j]!.x;
    const yj = vertices[j]!.y;
    const intersect = ((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function rectPolygonIntersects(rect: Array<{ x: number; y: number }>, vertices: readonly { x: number; y: number }[]): boolean {
  for (const p of rect) if (pointInPolygon2D(p.x, p.y, vertices)) return true;
  for (const p of vertices) {
    if (pointInPolygon2D(p.x, p.y, rect)) return true;
  }
  return false;
}

function distancePointToPolygon(px: number, py: number, vertices: readonly { x: number; y: number }[]): number {
  let best = Infinity;
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    best = Math.min(best, distancePointToSegment(px, py, a, b));
  }
  return best;
}

function distancePointToSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
