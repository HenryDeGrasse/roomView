BEGIN;

CREATE TABLE scene_heads (
  scene_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('scanned')),
  units TEXT NOT NULL CHECK (units IN ('m')),
  current_snapshot_id TEXT NOT NULL,
  current_scene_version INTEGER NOT NULL CHECK (current_scene_version >= 1),
  undo_base_snapshot_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE TABLE scene_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scene_heads(scene_id) ON DELETE CASCADE,
  scene_version INTEGER NOT NULL CHECK (scene_version >= 1),
  based_on_snapshot_id TEXT NULL REFERENCES scene_snapshots(snapshot_id),
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('initial_ingest', 'edit_plan', 'undo_restore')),
  state JSONB NOT NULL,
  editing_asset_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scene_id, scene_version)
);

ALTER TABLE scene_heads
  ADD CONSTRAINT scene_heads_current_snapshot_fk
  FOREIGN KEY (current_snapshot_id)
  REFERENCES scene_snapshots(snapshot_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE scene_heads
  ADD CONSTRAINT scene_heads_undo_base_snapshot_fk
  FOREIGN KEY (undo_base_snapshot_id)
  REFERENCES scene_snapshots(snapshot_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX scene_snapshots_scene_id_created_at_idx
  ON scene_snapshots (scene_id, created_at DESC);

CREATE TABLE derived_state_caches (
  snapshot_id TEXT PRIMARY KEY REFERENCES scene_snapshots(snapshot_id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES scene_heads(scene_id) ON DELETE CASCADE,
  scene_version INTEGER NOT NULL CHECK (scene_version >= 1),
  derived_state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX derived_state_caches_scene_id_version_idx
  ON derived_state_caches (scene_id, scene_version DESC);

CREATE TABLE camera_bookmarks (
  bookmark_id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scene_heads(scene_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  camera_pose JSONB NOT NULL,
  fov DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX camera_bookmarks_scene_id_created_at_idx
  ON camera_bookmarks (scene_id, created_at DESC);

CREATE TABLE photoreal_entries (
  entry_id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scene_heads(scene_id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  scene_version INTEGER NOT NULL CHECK (scene_version >= 1),
  scene_snapshot_id TEXT NOT NULL REFERENCES scene_snapshots(snapshot_id) ON DELETE CASCADE,
  bookmark_id TEXT NULL REFERENCES camera_bookmarks(bookmark_id) ON DELETE SET NULL,
  camera_pose JSONB NOT NULL,
  fov DOUBLE PRECISION NOT NULL,
  prompt_modifiers JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX photoreal_entries_scene_id_created_at_idx
  ON photoreal_entries (scene_id, created_at DESC);

CREATE TABLE splat_asset_records (
  scene_id TEXT PRIMARY KEY REFERENCES scene_heads(scene_id) ON DELETE CASCADE,
  source_scene_version INTEGER NOT NULL CHECK (source_scene_version >= 1),
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  asset_id TEXT NULL,
  uri TEXT NULL,
  job_id TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE handoff_grants (
  grant_id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scene_heads(scene_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  qr_payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('issued', 'redeemed', 'expired', 'revoked')) DEFAULT 'issued',
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ NULL,
  redeemed_session_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX handoff_grants_scene_id_status_idx
  ON handoff_grants (scene_id, status);

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scene_heads(scene_id) ON DELETE CASCADE,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('photoreal', 'splat')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  source_scene_version INTEGER NULL,
  scene_snapshot_id TEXT NULL REFERENCES scene_snapshots(snapshot_id) ON DELETE SET NULL,
  input_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL
);

CREATE INDEX jobs_scene_id_status_created_at_idx
  ON jobs (scene_id, status, created_at DESC);

ALTER TABLE splat_asset_records
  ADD CONSTRAINT splat_asset_records_job_fk
  FOREIGN KEY (job_id)
  REFERENCES jobs(job_id)
  ON DELETE SET NULL;

CREATE TABLE idempotency_records (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  scene_id TEXT NULL REFERENCES scene_heads(scene_id) ON DELETE CASCADE,
  request_body JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_status_code INTEGER NOT NULL,
  response_body JSONB NOT NULL DEFAULT '{}'::jsonb,
  job_id TEXT NULL REFERENCES jobs(job_id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NULL,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE INDEX idempotency_records_scene_id_idx
  ON idempotency_records (scene_id, updated_at DESC);

COMMIT;
