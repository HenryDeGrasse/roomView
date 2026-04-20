import { spawnSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CapturePipelineStage } from "@roomview/contracts";

/**
 * Returns null if `uv` is callable in the current environment, or an error
 * message explaining what's wrong. Use at server boot or in a health endpoint
 * so "finalize" doesn't get halfway through promotion before discovering the
 * tool is missing.
 */
export function checkPipelinePrerequisites(command: PipelineCommand = DEFAULT_COMMAND): string | null {
  try {
    const result = spawnSync(command.bin, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    if (result.error) {
      return `\`${command.bin}\` not found on PATH (${result.error.message}). Install with \`brew install uv\` or add it to PATH before starting the API.`;
    }
    if (result.status !== 0) {
      return `\`${command.bin} --version\` exited with code ${result.status}; capture pipeline will fail.`;
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Could not probe \`${command.bin}\`: ${message}`;
  }
}

export interface CapturePipelineInputs {
  fixture_id: string;
  repo_root: string;
  /** True when scene.shell already has RoomPlan-populated surfaces; skips scan-to-shell + detect-openings. */
  has_roomplan_shell: boolean;
  /** Callback invoked at each stage transition so the caller can update the JobRecord. */
  on_stage_change: (args: { stage: CapturePipelineStage; message: string }) => void;
  /** Callback for every stdout / stderr line — used for structured logging. */
  on_log?: (args: { stream: "stdout" | "stderr"; line: string }) => void;
  /** Overridable for tests / headless CI. Defaults to `uv run --script`. */
  command?: PipelineCommand;
}

export interface CapturePipelineResult {
  success: boolean;
  failed_stage: CapturePipelineStage | null;
  stages_completed: CapturePipelineStage[];
  /** Tail of stderr from the first failing subprocess, if any. */
  error_tail: string | null;
}

/** Injection point for tests — lets us stub out `uv` without losing coverage. */
export interface PipelineCommand {
  bin: string;
  prefix_args: string[]; // e.g. ["run", "--script"]
}

export const DEFAULT_COMMAND: PipelineCommand = {
  bin: "uv",
  prefix_args: ["run", "--script"],
};

/**
 * Run the capture-to-render pipeline on a freshly-promoted fixture.
 *
 *   splat-generate ─▶ bake-wall-textures
 *
 * When `has_roomplan_shell` is false (pure ARKitScenes-style capture with no
 * Apple-provided surfaces), the runner additionally runs scan-to-shell and
 * detect-openings between splat-generate and bake-wall-textures.
 *
 * Each stage's success/failure flows into on_stage_change so the JobRecord in
 * the service can show progress ("splat" → "textures" → "complete") to the
 * editor UI while the subprocess is still running.
 */
export async function runCapturePipeline(inputs: CapturePipelineInputs): Promise<CapturePipelineResult> {
  const command = inputs.command ?? DEFAULT_COMMAND;
  const stages: CapturePipelineStage[] = [];
  let errorTail: string | null = null;

  const stageSequence: Array<{
    stage: CapturePipelineStage;
    message: string;
    script: string;
    args: string[];
  }> = [
    {
      stage: "splat",
      message: "Generating gaussian splat from captured frames…",
      script: "scripts/splat-generate.py",
      args: [
        "--fixture", absFixtureDir(inputs),
        "--capture-id", inputs.fixture_id,
        "--mode", "cohesive",
        "--out-dir", resolve(absFixtureDir(inputs), "splats"),
      ],
    },
  ];

  if (!inputs.has_roomplan_shell) {
    // ARKitScenes-style capture without Apple-provided walls — reconstruct the
    // shell + openings from the splat before texturing. This mirrors the
    // manual path in docs for existing fixtures.
    stageSequence.push({
      stage: "splat",
      message: "Fitting room walls from scan…",
      script: "scripts/scan-to-shell.py",
      args: ["--fixture-id", inputs.fixture_id],
    });
    stageSequence.push({
      stage: "splat",
      message: "Detecting doors and windows…",
      script: "scripts/detect-openings.py",
      args: ["--fixture-id", inputs.fixture_id],
    });
  }

  stageSequence.push({
    stage: "textures",
    message: "Baking wall textures from captured photos…",
    script: "scripts/bake-wall-textures.py",
    args: ["--fixture-id", inputs.fixture_id],
  });

  for (const step of stageSequence) {
    inputs.on_stage_change({ stage: step.stage, message: step.message });
    const scriptPath = resolve(inputs.repo_root, step.script);
    const result = await runScript({
      command,
      scriptPath,
      scriptArgs: step.args,
      cwd: inputs.repo_root,
      on_log: inputs.on_log,
    });
    if (!result.success) {
      errorTail = result.stderr_tail;
      inputs.on_stage_change({ stage: step.stage, message: `Stage failed: ${step.script}` });
      return {
        success: false,
        failed_stage: step.stage,
        stages_completed: stages,
        error_tail: errorTail,
      };
    }
    if (!stages.includes(step.stage)) {
      stages.push(step.stage);
    }
    // After splat-generate writes its descriptor, patch the fixture's
    // scene.json so scene.splat points at the just-generated file. The
    // viewer reads scene.splat.uri to load the gaussians — without this
    // patch it'd stay "queued" forever.
    if (step.script === "scripts/splat-generate.py") {
      try {
        patchSceneWithSplatDescriptor(absFixtureDir(inputs), inputs.on_log);
      } catch (err) {
        inputs.on_log?.({
          stream: "stderr",
          line: `[capture-pipeline] patch scene.splat failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  inputs.on_stage_change({ stage: "complete", message: "Room is ready." });
  stages.push("complete");
  return {
    success: true,
    failed_stage: null,
    stages_completed: stages,
    error_tail: null,
  };
}

function absFixtureDir(inputs: CapturePipelineInputs): string {
  return resolve(inputs.repo_root, "fixtures", "roomplan", inputs.fixture_id);
}

interface SplatDescriptor {
  splat_id?: string;
  ply_uri?: string;
  gaussian_count?: number;
  generated_at?: string;
}

/**
 * Read the most recent splat descriptor under <fixtureDir>/splats/ and update
 * <fixtureDir>/scene.json so scene.splat points at it (status=ready, asset_id,
 * uri). The viewer's splat loader reads scene.splat.uri — without this patch
 * it stays queued and the editor shows wireframe-only.
 *
 * Idempotent: safe to call multiple times; last write wins.
 */
export function patchSceneWithSplatDescriptor(
  fixtureDir: string,
  on_log?: (args: { stream: "stdout" | "stderr"; line: string }) => void
): boolean {
  const splatsDir = resolve(fixtureDir, "splats");
  let descriptorFiles: string[];
  try {
    descriptorFiles = readdirSync(splatsDir).filter((f) => f.endsWith(".json"));
  } catch {
    on_log?.({ stream: "stderr", line: `[capture-pipeline] splats dir not found at ${splatsDir}` });
    return false;
  }
  if (descriptorFiles.length === 0) {
    on_log?.({ stream: "stderr", line: `[capture-pipeline] no splat descriptor JSON under ${splatsDir}` });
    return false;
  }

  // Pick the newest descriptor by generated_at (fallback: lexical order).
  let chosen: { filename: string; descriptor: SplatDescriptor } | null = null;
  for (const filename of descriptorFiles) {
    const descriptor = JSON.parse(readFileSync(resolve(splatsDir, filename), "utf8")) as SplatDescriptor;
    if (!chosen) {
      chosen = { filename, descriptor };
      continue;
    }
    const a = chosen.descriptor.generated_at ?? "";
    const b = descriptor.generated_at ?? "";
    if (b > a) chosen = { filename, descriptor };
  }
  if (!chosen || !chosen.descriptor.ply_uri || !chosen.descriptor.splat_id) {
    on_log?.({ stream: "stderr", line: `[capture-pipeline] splat descriptor missing ply_uri / splat_id` });
    return false;
  }

  const scenePath = resolve(fixtureDir, "scene.json");
  const scene = JSON.parse(readFileSync(scenePath, "utf8")) as {
    splat?: {
      scene_id: string;
      source_scene_version?: number;
      status: string;
      asset_id: string | null;
      uri: string | null;
      updated_at: string;
      job_id?: string | null;
    };
    head?: { scene_id: string; current_scene_version?: number };
  };

  const now = new Date().toISOString();
  if (scene.splat) {
    scene.splat.status = "ready";
    scene.splat.asset_id = chosen.descriptor.splat_id;
    scene.splat.uri = chosen.descriptor.ply_uri;
    scene.splat.updated_at = now;
  } else if (scene.head?.scene_id) {
    // Scene had no splat record at all — synthesize one so the editor loads it.
    scene.splat = {
      scene_id: scene.head.scene_id,
      source_scene_version: scene.head.current_scene_version ?? 1,
      status: "ready",
      asset_id: chosen.descriptor.splat_id,
      uri: chosen.descriptor.ply_uri,
      updated_at: now,
      job_id: null,
    };
  }

  writeFileSync(scenePath, `${JSON.stringify(scene, null, 2)}\n`);
  on_log?.({
    stream: "stdout",
    line: `[capture-pipeline] patched scene.splat → ${chosen.descriptor.ply_uri} (${chosen.descriptor.gaussian_count ?? 0} gaussians)`,
  });
  return true;
}

/**
 * Fire-and-forget Tier 2 mesh generation. Runs `bundle-to-meshes.py --mode
 * tsdf` on the finalized fixture in a detached subprocess so the main
 * pipeline's "ready" signal isn't blocked by the 5-10 minute mesh build.
 *
 * The finalize flow calls this AFTER `runCapturePipeline` succeeds — the
 * splat + textures are already committed, scene.json is patched, and the
 * editor can render the room. When the mesh job finishes it drops
 * `fixtures/roomplan/<id>/meshes/manifest.json`. The editor polls for that
 * manifest and offers "load meshes" when it appears.
 *
 * No job record is created — progress isn't surfaced to the user. Success
 * is inferred from the manifest existing.
 */
export function enqueueMeshJob(args: {
  fixture_id: string;
  repo_root: string;
  command?: PipelineCommand;
}): void {
  const command = args.command ?? DEFAULT_COMMAND;
  const scriptPath = resolve(args.repo_root, "scripts/bundle-to-meshes.py");
  const fixtureDir = resolve(args.repo_root, "fixtures", "roomplan", args.fixture_id);
  // Skip if the script is missing (CI/tests without the Python pipeline).
  if (!existsSync(scriptPath)) {
    // eslint-disable-next-line no-console
    console.warn(`[capture-pipeline] skipping mesh job; ${scriptPath} not found`);
    return;
  }
  // Skip if we've already meshed this fixture (idempotent re-finalize).
  if (existsSync(resolve(fixtureDir, "meshes", "manifest.json"))) {
    // eslint-disable-next-line no-console
    console.log(`[capture-pipeline] mesh manifest already present for ${args.fixture_id}; skipping`);
    return;
  }
  const child = spawn(
    command.bin,
    [...command.prefix_args, scriptPath, "--fixture-id", args.fixture_id, "--mode", "tsdf"],
    {
      cwd: args.repo_root,
      // Fully detach so the parent API process doesn't hold onto the child
      // FDs — if the API restarts, the mesh job keeps running.
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  child.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.warn(`[capture-pipeline] mesh job spawn error for ${args.fixture_id}: ${err.message}`);
  });
  child.unref();
  // eslint-disable-next-line no-console
  console.log(`[capture-pipeline] enqueued mesh job for ${args.fixture_id} (pid=${child.pid ?? "?"})`);
}

/**
 * Fire-and-forget high-quality splat training via Brush (Rust + WebGPU).
 * Called by the finalize flow after the fast RGBD-init splat + meshes are
 * already on disk. Training takes 15-30 minutes on Apple Silicon; the room
 * is viewable the whole time via the fast splat + meshes.
 *
 * When training finishes, `scripts/brush-train.py` writes:
 *   fixtures/roomplan/<id>/splats/brush-train/splat_brush_<iter>.ply
 *   fixtures/roomplan/<id>/splats/brush-train/splat_brush_<iter>.json
 * and patches scene.splat to point at the trained PLY. The editor polls
 * for the descriptor and offers an "upgrade to HQ splat" action that
 * re-fetches the scene.
 *
 * Skipped silently if:
 *   - `tools/brush/.../brush_app` binary is missing (not installed)
 *   - A descriptor already exists for this fixture (idempotent re-finalize)
 *
 * Failure mode is graceful: if the Python wrapper or Brush itself errors,
 * scene.splat keeps pointing at the fast RGBD splat (nothing is modified
 * on the failure path). No regression.
 */
export function enqueueBrushTrainJob(args: {
  fixture_id: string;
  repo_root: string;
  command?: PipelineCommand;
  total_steps?: number;
  max_resolution?: number;
}): void {
  const command = args.command ?? DEFAULT_COMMAND;
  const scriptPath = resolve(args.repo_root, "scripts/brush-train.py");
  const fixtureDir = resolve(args.repo_root, "fixtures", "roomplan", args.fixture_id);
  const brushBinary = resolve(args.repo_root, "tools/brush/brush-app-aarch64-apple-darwin/brush_app");
  if (!existsSync(scriptPath)) {
    // eslint-disable-next-line no-console
    console.warn(`[capture-pipeline] skipping brush-train; ${scriptPath} not found`);
    return;
  }
  if (!existsSync(brushBinary)) {
    // eslint-disable-next-line no-console
    console.warn(`[capture-pipeline] skipping brush-train; ${brushBinary} not installed`);
    return;
  }
  // Idempotency: pick any existing .json descriptor under splats/brush-train/
  // as evidence we already trained this fixture.
  const brushDir = resolve(fixtureDir, "splats", "brush-train");
  if (existsSync(brushDir)) {
    try {
      const descriptors = readdirSync(brushDir).filter((f) => f.endsWith(".json"));
      if (descriptors.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[capture-pipeline] brush-train descriptor already present for ${args.fixture_id}; skipping`);
        return;
      }
    } catch {
      // fall through and re-run
    }
  }
  const scriptArgs = [
    ...command.prefix_args,
    scriptPath,
    "--fixture-id", args.fixture_id,
    "--total-steps", String(args.total_steps ?? 30_000),
    "--max-resolution", String(args.max_resolution ?? 960),
  ];
  const child = spawn(command.bin, scriptArgs, {
    cwd: args.repo_root,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.warn(`[capture-pipeline] brush-train spawn error for ${args.fixture_id}: ${err.message}`);
  });
  child.unref();
  // eslint-disable-next-line no-console
  console.log(`[capture-pipeline] enqueued brush-train for ${args.fixture_id} (pid=${child.pid ?? "?"})`);
}


interface RunScriptArgs {
  command: PipelineCommand;
  scriptPath: string;
  scriptArgs: string[];
  cwd: string;
  on_log?: (args: { stream: "stdout" | "stderr"; line: string }) => void;
}

interface RunScriptResult {
  success: boolean;
  exit_code: number | null;
  stderr_tail: string | null;
}

function runScript(args: RunScriptArgs): Promise<RunScriptResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(args.command.bin, [...args.command.prefix_args, args.scriptPath, ...args.scriptArgs], {
      cwd: args.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const stderrBuffer: string[] = [];
    const STDERR_TAIL_LINES = 40;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length === 0) continue;
        args.on_log?.({ stream: "stdout", line });
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length === 0) continue;
        args.on_log?.({ stream: "stderr", line });
        stderrBuffer.push(line);
        if (stderrBuffer.length > STDERR_TAIL_LINES) {
          stderrBuffer.shift();
        }
      }
    });

    child.on("error", (err: Error) => {
      resolvePromise({
        success: false,
        exit_code: null,
        stderr_tail: `spawn error: ${err.message}`,
      });
    });

    child.on("close", (code: number | null) => {
      resolvePromise({
        success: code === 0,
        exit_code: code,
        stderr_tail: stderrBuffer.length > 0 ? stderrBuffer.join("\n") : null,
      });
    });
  });
}
