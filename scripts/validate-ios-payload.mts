import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RoomPlanCaptureRequest } from "../packages/contracts/src/index.ts";
import { RoomPlanCaptureService } from "../apps/api/src/index.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

function parseCli(argv: string[]): { payload_path: string } {
  let payloadPath: string | null = null;
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--payload") {
      payloadPath = argv[++i] ?? null;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: validate-ios-payload --payload <path-to-RoomPlanCaptureRequest.json>\n"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!payloadPath) throw new Error("--payload <path> is required");
  return { payload_path: resolve(REPO_ROOT, payloadPath) };
}

async function main(): Promise<void> {
  const { payload_path } = parseCli(process.argv);
  const request = JSON.parse(readFileSync(payload_path, "utf8")) as RoomPlanCaptureRequest;
  const storageDir = mkdtempSync(join(tmpdir(), "roomview-ios-payload-"));
  try {
    const service = new RoomPlanCaptureService({
      storage_directory: storageDir,
      token_secret: "ios-payload-verify-secret",
      handoff_base_url: "https://roomview.local/h",
    });
    const response = service.postRoomPlanCapture(request);
    assert.ok(response.scene_id, "expected scene_id in capture response");
    const scene = service.getScene(response.scene_id);
    assert.ok(scene, "scene retrievable after ingest");
    const room = scene.snapshot.state.room;
    process.stdout.write(
      [
        `OK  payload=${payload_path}`,
        `    scene_id=${response.scene_id}`,
        `    scene_version=${response.scene_version}`,
        `    surfaces=${room.shell.surfaces.length}`,
        `    openings=${room.shell.openings.length}`,
        `    objects=${room.objects.length}`,
        `    floor_polygon_vertices=${room.shell.floor_polygon.vertices.length}`,
        `    ceiling_height_m=${room.shell.ceiling_height}`,
      ].join("\n") + "\n"
    );
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
}

await main();
