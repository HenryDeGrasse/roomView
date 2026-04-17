import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  IdempotencyRecord,
  ISO8601Timestamp,
  SceneEditOperation,
  SceneSnapshot,
} from "@roomview/contracts";

import type {
  PersistedDerivedStateCacheRecord,
  PersistedInitialSceneRecords,
} from "./roomplan-persistence";

export interface PersistedPreviewRecord {
  preview_id: string;
  scene_id: string;
  based_on_scene_version: number;
  ops: SceneEditOperation[];
  explanation: string;
  canonical_plan_hash: string;
  apply_token_hash: string;
  apply_token_expires_at: ISO8601Timestamp;
  idempotency_key: string;
  created_at: ISO8601Timestamp;
  consumed_at: ISO8601Timestamp | null;
}

export interface PersistedStoredIdempotencyRecord extends IdempotencyRecord {
  request_body: Record<string, unknown>;
}

export interface PersistedRoomPlanCaptureRecord {
  request_fingerprint: string;
  request_id: string;
  client_capture_id: string;
  persisted_records: PersistedInitialSceneRecords;
  snapshots?: SceneSnapshot[];
  derived_state_caches?: PersistedDerivedStateCacheRecord[];
  preview_records?: PersistedPreviewRecord[];
  idempotency_records?: PersistedStoredIdempotencyRecord[];
}

export class FileSystemRoomPlanCaptureRecordStore {
  private readonly rootDirectory: string;

  public constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
    mkdirSync(this.rootDirectory, { recursive: true });
  }

  public loadAll(): PersistedRoomPlanCaptureRecord[] {
    return readdirSync(this.rootDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) =>
        JSON.parse(readFileSync(resolve(this.rootDirectory, entry.name), "utf8")) as PersistedRoomPlanCaptureRecord
      );
  }

  public save(record: PersistedRoomPlanCaptureRecord): void {
    const targetPath = resolve(this.rootDirectory, `${record.persisted_records.scene_head.scene_id}.json`);
    const temporaryPath = `${targetPath}.tmp-${process.pid}`;
    writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temporaryPath, targetPath);
  }
}
