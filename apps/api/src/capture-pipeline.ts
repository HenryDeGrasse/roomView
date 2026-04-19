import { spawnSync, spawn } from "node:child_process";
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
