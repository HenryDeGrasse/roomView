import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PersistedInitialSceneRecords } from "./roomplan-persistence";

export interface PersistedRoomPlanCaptureRecord {
  request_fingerprint: string;
  request_id: string;
  client_capture_id: string;
  persisted_records: PersistedInitialSceneRecords;
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
