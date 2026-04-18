/**
 * Spins up the RoomPlan API server on a random ephemeral port inside a
 * temporary directory so tests don't pollute the repo's data/ dir.
 *
 * Returns a helper object with baseUrl, fetch wrappers, and a close() method.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRoomPlanApiServer } from "../../apps/api/src/server.ts";

export interface ApiHarness {
  baseUrl: string;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
  storageDir: string;
}

export async function startApiHarness(): Promise<ApiHarness> {
  const storageDir = mkdtempSync(join(tmpdir(), "roomview-api-test-"));
  const server = createRoomPlanApiServer({
    storage_directory: storageDir,
    handoff_base_url: "http://127.0.0.1/handoff",
    token_secret: "test-secret",
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    fetch: (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(storageDir, { recursive: true, force: true });
          resolve();
        });
      }),
    storageDir,
  };
}
