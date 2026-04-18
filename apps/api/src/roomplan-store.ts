import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  IdempotencyRecord,
  ISO8601Timestamp,
  JobRecord,
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
  job_records?: JobRecord[];
}

export interface StoredPhotorealArtifact {
  content_type: string;
  bytes: Buffer;
  metadata: Record<string, unknown> | null;
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

  public savePhotorealArtifact(
    sceneId: string,
    assetId: string,
    artifact: { content_type: string; bytes: Buffer; metadata?: Record<string, unknown> | null }
  ): string {
    const directory = this.photorealArtifactDirectory(sceneId);
    mkdirSync(directory, { recursive: true });

    const binaryTargetPath = resolve(directory, `${assetId}.bin`);
    const binaryTemporaryPath = `${binaryTargetPath}.tmp-${process.pid}`;
    writeFileSync(binaryTemporaryPath, artifact.bytes);
    renameSync(binaryTemporaryPath, binaryTargetPath);

    const metadataTargetPath = resolve(directory, `${assetId}.json`);
    const metadataTemporaryPath = `${metadataTargetPath}.tmp-${process.pid}`;
    writeFileSync(
      metadataTemporaryPath,
      `${JSON.stringify({ content_type: artifact.content_type, ...(artifact.metadata ?? {}) }, null, 2)}\n`
    );
    renameSync(metadataTemporaryPath, metadataTargetPath);

    return `/artifacts/photoreal/${encodeURIComponent(sceneId)}/${encodeURIComponent(assetId)}`;
  }

  public readPhotorealArtifact(sceneId: string, assetId: string): StoredPhotorealArtifact | null {
    const directory = this.photorealArtifactDirectory(sceneId);
    const binaryPath = resolve(directory, `${assetId}.bin`);
    const metadataPath = resolve(directory, `${assetId}.json`);
    if (!existsSync(binaryPath) || !existsSync(metadataPath)) {
      return null;
    }
    const rawMetadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { content_type?: string } & Record<string, unknown>;
    const { content_type, ...metadata } = rawMetadata;
    return {
      content_type: typeof content_type === "string" && content_type.length > 0 ? content_type : "application/octet-stream",
      bytes: readFileSync(binaryPath),
      metadata,
    };
  }

  private photorealArtifactDirectory(sceneId: string): string {
    return resolve(this.rootDirectory, "_artifacts", "photoreal", sceneId);
  }
}
