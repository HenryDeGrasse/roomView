# PRD — Canonical Room Representation & Scan-to-Edit Tool (MVP)

**Status:** Draft v1.0
**Owner:** Applied AI / 3D Systems
**Release target:** MVP / capstone-quality build
**Primary surface:** iOS capture companion + web editor
**Primary user:** consumer homeowner or renter redesigning one bedroom
**Core bet:** a real room becomes a canonical, editable, constraint-aware scene, not a photo and not a manually authored CAD file.

## 1. Product decision

This PRD defines one shippable MVP:

* Native iPhone capture using RoomPlan
* One scanned bedroom per scene
* Web editor with three panes: Scan, Layout, Render
* Quick 3D render for live iteration
* Button-triggered or chat-triggered photoreal image generation
* Conversational editing mapped to typed operations
* Deterministic constraint checking
* Single-step undo
* Non-blocking splat training for the scan pane

Everything else is explicitly post-MVP:

* Android capture
* multi-room scenes
* floorplan upload
* synthetic scene generation
* realistic splat+mesh compositing
* continuous/live photoreal
* full edit history
* drag-and-drop layout editing
* commerce, BOM, contractor outputs

## 2. Problem

Current AI room-design tools usually fail in one of two ways:

1. They restyle a photo and lose the actual room.
2. They require manual authoring in a design tool before anything useful happens.

The user need is narrower and more practical:

> “Let me scan my actual bedroom, try real layout and style changes without breaking the room, and show me a shareable image of what the result could look like.”

The product must preserve three truths at once:

* the **room as scanned**
* the **room as understood structurally**
* the **room as redesigned**

## 3. Product goal

Turn one scanned bedroom into a canonical scene document that supports:

* real-world shell preservation
* editable furniture and surface state
* deterministic validation of spatial edits
* fast architectural rendering during iteration
* photoreal outputs tied to exact scene state
* future extension without schema migration

## 4. Users and jobs to be done

### Primary user

A consumer redesigning a bedroom in their own home.

### Secondary user

A designer or technically inclined user using the room as a structured starting point.

### Core jobs

* Scan my room quickly
* See a believable editable model of the room
* Ask for layout changes in plain language
* Get told when a change does not physically work
* Save a photoreal result I can compare or share

## 5. Goals and non-goals

### Goals

* Make the room editable within seconds of scan completion
* Preserve shell geometry and major openings
* Support conversational edits that resolve to typed operations
* Enforce a small, clear constraint set
* Keep all render outputs tied to one source of truth
* Ship a demo that works on real bedroom scans, not just canned examples

### Non-goals

* Construction-grade measurement
* Open-vocabulary scene understanding
* Exact per-object mesh reconstruction
* Whole-home topology
* Real-time physically accurate lighting
* Replacing a professional architect or contractor

## 6. MVP scope

### In scope

* One bedroom scene per session
* iPhone/iPad LiDAR capture through native Swift app
* RoomPlan ingestion
* Optional raw video upload for asynchronous splat training
* Web editor with:

  * Scan pane
  * Layout pane
  * Render pane
  * chat
  * object/surface selection
  * single-step undo
  * photoreal gallery
* Typed scene-edit operations:

  * `move_object`
  * `rotate_object`
  * `replace_object`
  * `add_object`
  * `remove_object`
  * `lock_entity`
  * `unlock_entity`
  * `repaint_surface`
  * `swap_flooring`
* Dedicated command endpoints for:

  * `generate_photoreal`
  * `undo_last_change`
* Five hard constraints
* Three soft constraints
* Asset retrieval from curated glTF library
* Fixed/default and saved camera bookmarks

### Out of scope

* Android
* multi-room
* floorplan import
* realistic splat compositing
* arbitrary direct manipulation gizmos
* multi-user collaboration
* deep history beyond one undo
* share links
* commerce/BOM/cost estimation

## 7. User flow

### 7.1 Capture flow

1. User opens iOS companion app.
2. User scans a bedroom with RoomPlan.
3. App serializes RoomPlan output into capture payload.
4. App uploads the RoomPlan scene payload and metadata.
5. Backend creates the canonical scene, issues a short-lived one-time handoff grant, and returns:

   * `scene_id`
   * `handoff_url`
   * QR payload encoding the same one-time grant
   * `expires_at`
   * `video_upload_token` for optional post-ingest capture upload; it is short-lived, scene-scoped, and valid only for the companion app video upload path
6. If available, the app uploads optional raw video for splat training against that `scene_id` using `video_upload_token`, without blocking scene editability.
7. User opens the web editor on a laptop by redeeming the handoff URL or QR payload into an authenticated web session scoped to that `scene_id`.

**Acceptance criteria**

* A valid RoomPlan scan produces a canonical scene and a private handoff grant without manual intervention.
* Ingest creates the first immutable scene snapshot plus scene head before any splat work is required.
* Stable IDs are assigned during ingest and reused on subsequent reads of that scene state.
* Unsupported detections are preserved as `generic_obstacle` objects with provenance instead of being silently dropped.
* Initial `derived_state_cache` is available as part of the first editable scene read.
* Raw `scene_id` possession alone is insufficient to open the web editor in MVP.
* Handoff grants are short-lived, one-time use, and scene-scoped.
* Scene becomes editable before splat is ready.
* Optional raw video upload is attached after `scene_id` creation and never blocks the initial editable scene.
* If splat never completes, the editor still functions.

### 7.2 Editor load flow

1. Web app redeems a valid handoff grant, or resumes an authenticated scene-scoped session, and requests the current scene read model.
2. Scan pane shows RoomPlan parametric preview.
3. Layout pane shows top-down shell, openings, and object OBBs.
4. Render pane shows Quick render using retrieved assets.
5. If splat later becomes ready, scan pane updates without changing scene state.

**Acceptance criteria**

* Editor access requires an authenticated session scoped to the scene; there are no public scene URLs in MVP.
* Editor loads a usable scene from canonical JSON only.
* Scan pane is read-only and never used for validation or mutation.
* Quick render and layout always reflect current committed scene version.

### 7.3 Edit flow

1. User selects an object/surface or types in chat.
2. Backend planning resolves the request into one of:

   * a clarification request
   * a rejection with reason code
   * a canonical scene-edit plan preview with server-issued apply credentials
   * a dedicated command request (`photoreal` or `undo`) routed to its own endpoint
3. For scene-edit previews, the client may only accept or reject the preview; it may not edit the returned ops.
4. If the user accepts a valid scene-edit preview before expiry, backend validates against the current head and commits atomically.
5. UI updates layout and quick render.
6. If invalid or stale, UI shows a reason and optional suggested next action.

**Acceptance criteria**

* One user prompt results in either:

  * one atomic committed plan, or
  * one clarification request, or
  * one rejection with reason code, or
  * one dedicated command execution routed through its own endpoint
* No partial commit on failed plan validation.
* The client never submits user-edited ops for apply.

### 7.4 Photoreal flow

1. User clicks “Generate Photoreal” or uses chat.
2. System uses current view or chosen bookmark.
3. Quick render produces high-resolution color, depth, and edge inputs.
4. Provider generates conditioned photoreal image.
5. Result is stored as a photoreal sidecar record with `scene_version`, `scene_snapshot_id`, and the resolved camera parameters.

**Acceptance criteria**

* Photoreal output is attached to a specific immutable scene version.
* Re-generating from the same bookmark on the same version produces structurally consistent images.
* Photoreal generation does not mutate scene geometry or increment `scene_version`.

### 7.5 Undo flow

1. User clicks undo or types “undo that.”
2. Backend creates a new head snapshot whose editable state matches the prior undoable committed snapshot.
3. Layout and render update.
4. Gallery images remain attached to their original versions.

**Acceptance criteria**

* Exactly one structural/material/lock commit can be undone.
* Undo creates a new head snapshot; it does not decrement or reuse `scene_version`.
* `generate_photoreal` is not part of undo history.

## 8. UX requirements

### 8.1 Scan pane

Purpose: show reality.

Requirements:

* read-only
* orbit and zoom
* placeholder uses RoomPlan parametric preview
* splat swaps in when job state is `ready`
* must visually indicate whether user is seeing placeholder or splat

### 8.2 Layout pane

Purpose: show explicit structure and constraints.

Requirements:

* top-down floor polygon
* wall segments and openings
* object footprints and labels
* selected entity highlight
* live display of:

  * clearance paths
  * hard violations
  * soft score summary

### 8.3 Render pane

Purpose: show proposal.

Requirements:

* Quick mode only for live updates in MVP
* object selection highlight
* camera orbit
* save current view as bookmark
* photoreal button
* gallery strip below pane

### 8.4 Chat

Requirements:

* supports natural-language edit requests
* supports clarifying questions when target is ambiguous
* supports “this wall,” “that chair,” and similar references using current selection context
* displays explanation of applied or rejected edits
* supports undo and photoreal commands

### 8.5 Selection

Minimal direct interaction is in scope.

Requirements:

* click object in layout or render to select it
* click surface in render or list to select it
* selected entity becomes chat context
* direct drag/transform gizmos are out of scope

## 9. System architecture

### 9.1 Components

**iOS Capture App**

* runs RoomPlan
* packages scan payload
* uploads optional video for splat job

**Scene Ingest Service**

* maps RoomPlan output into canonical scene JSON
* assigns stable IDs deterministically during ingest
* creates fallback `generic_obstacle` objects for unsupported detections
* computes and stores the initial immutable scene snapshot, scene head, and initial derived-state cache
* persists the secure handoff artifact and any initial sidecar job records needed for optional splat processing

**Scene Service**

* stores scene heads, immutable snapshots, and sidecars
* manages versions
* exposes server-authoritative scene read/write APIs

**Access Service**

* issues short-lived one-time handoff grants for newly created scenes
* redeems handoff grants into authenticated web sessions scoped to a single scene
* rejects expired, reused, or cross-scene access attempts

**Planner Service**

* calls LLM with scene summary, selection context, and asset manifest
* returns a canonical scene-edit plan preview, dedicated command request, clarification, or rejection

**Validation Service**

* simulates canonical scene-edit plan previews
* runs hard and soft constraints
* commits or rejects accepted previews

**Asset Service**

* resolves class/style/dimension requests to glTF assets
* provides fallback proxy assets when exact match is unavailable

**Photoreal Service**

* renders high-res conditioning inputs
* calls provider
* stores output in the photoreal gallery sidecar

**Splat Job Service**

* runs asynchronous training on uploaded video
* writes/updates the `SplatAssetRecord` sidecar when ready

**Web App**

* scene viewer
* layout view
* quick renderer
* chat client
* gallery
* bookmark management

### 9.2 Source of truth

The only logical source of truth for versioned editable scene data is the immutable `SceneSnapshot` referenced by `SceneHead.current_snapshot_id`, specifically its `state` and `editing_asset_refs`.

The following may be stored alongside the scene but are never authoritative for versioned editable scene data and may be regenerated or replaced from the current snapshot:

* `derived_state_cache`
* splat assets and splat job state
* quick renders
* photoreal outputs and photoreal job state
* camera bookmark sidecars
* RoomPlan preview meshes

### 9.3 Capture payload and ingest pipeline

```json
RoomPlanCaptureRequest {
  request_id: string,
  client_capture_id: string,
  roomplan_payload: object,
  capture_metadata: {
    room_type_hint: "bedroom",
    units: "m",
    device_model: string,
    captured_at: timestamp,
    video_expected: boolean
  },
  supplementary_detections: Array<{
    detection_id: string,
    label: string,
    obb: OBB3D,
    confidence: number
  }> | null
}
```

Initial ingest is synchronous and must complete the following before `POST /captures/roomplan` returns success:

1. validate that the capture is a single supported bedroom scan
2. map RoomPlan shell/openings/surfaces into canonical room-local geometry
3. assign stable IDs for room, surfaces, openings, fixed elements, and objects
4. create editable objects for supported classes and fallback `generic_obstacle` objects for unsupported RoomPlan or supplementary detections
5. attach initial edit-participating asset refs for supported editable objects, using proxy assets when exact matches are unavailable
6. compute the initial `derived_state_cache`
7. persist:

   * `SceneSnapshot(scene_version = 1, mutation_kind = "initial_ingest")`
   * `SceneHead(current_scene_version = 1, current_snapshot_id = <initial_snapshot_id>, undo_base_snapshot_id = null)`
   * initial `derived_state_cache`
   * secure handoff artifact
   * `SplatAssetRecord(status = "queued")` only if optional video upload is expected or has already been attached
8. return the scene handoff response without waiting for any splat job to finish

Stable-ID ingest rules:

* IDs are generated exactly once during initial ingest and then persisted; later reads never recompute them from display order.
* If the same physical unsupported item is carried through ingest, it must still receive a stable object ID and be stored as `class = "generic_obstacle"`.
* Objects omitted by RoomPlan and by supplementary detections are not synthesized into editable state during ingest.

## 10. Canonical scene model

### 10.1 Authoritative persistence model

The persistence model is split into immutable snapshots, a mutable scene head, and non-authoritative sidecars:

* `SceneHead`: the only mutable authoritative record; points to the current snapshot and the single undo base.
* `SceneSnapshot`: immutable version record containing only editable state plus edit-participating asset bindings.
* sidecars: bookmarks, photoreal gallery, splat/job metadata, and recomputable caches keyed back to `scene_id` and/or `scene_version`.

```json
SceneHead {
  scene_id: string,
  source: "scanned",
  units: "m",
  current_snapshot_id: string,
  current_scene_version: integer,
  undo_base_snapshot_id: string | null,
  updated_at: timestamp
}
```

```json
SceneSnapshot {
  snapshot_id: string,
  scene_id: string,
  scene_version: integer,
  based_on_snapshot_id: string | null,
  mutation_kind: "initial_ingest" | "edit_plan" | "undo_restore",
  state: SceneState,
  editing_asset_refs: AssetRef[],
  created_at: timestamp
}
```

```json
Scene {
  head: SceneHead,
  snapshot: SceneSnapshot,
  derived_state_cache: DerivedState | null,
  bookmarks: CameraBookmark[],
  photoreal_gallery: PhotorealEntry[],
  splat: SplatAssetRecord | null
}
```

```json
SceneState {
  style_tags: string[],
  room: Room
}
```

### 10.2 Core entities

```json
Room {
  room_id: string,
  room_type: "bedroom",
  coordinate_frame: RoomCoordinateFrame,
  shell: Shell,
  objects: Object[],
  constraints: ConstraintSpec[],
  focal_elements: FocalElementRef[],
  section_hints: string[]
}
```

```json
Shell {
  floor_polygon: Polygon2D,
  ceiling_height: number,
  surfaces: Surface[],
  named_wall_refs: NamedWallRef[],
  openings: Opening[],
  fixed_elements: FixedElement[]
}
```

```json
Surface {
  surface_id: string,
  type: "wall" | "floor" | "ceiling",
  geometry_ref: string,
  boundary: Polygon2D,
  surface_frame: SurfaceFrame | null,
  named_wall_ref_id: string | null,
  material_state: MaterialState,
  user_locked: boolean,
  provenance: Provenance
}
```

`Surface.boundary` semantics:

* for `type = "floor"`, `boundary` is expressed in the room-local floor plane
* for `type = "wall"` or `"ceiling"`, `boundary` is expressed in the local 2D coordinates of `surface_frame`

```json
Opening {
  opening_id: string,
  host_surface_id: string,
  type: "door" | "window" | "closet_door",
  rect: RectOnSurface,
  swing_zone: Polygon2D | null,
  keepout_zone: Polygon2D | null,
  connects_to_room_id: string | null,
  provenance: Provenance
}
```

`Opening.swing_zone` and `Opening.keepout_zone` are expressed in the room-local floor plane.

```json
Object {
  object_id: string,
  class: string,
  attributes: string[],
  parent_id: string | null,
  child_movement_policy: "move_with_parent" | "independent",
  pose: Pose3D,
  obb: OBB3D,
  mobility: "movable" | "anchored" | "fixed",
  host: HostRelation | null,
  support: SupportRelation,
  asset_ref: string | null,
  style_tags: string[],
  material_state: MaterialState | null,
  user_locked: boolean,
  provenance: Provenance
}
```

```json
FixedElement {
  fixed_element_id: string,
  class: string,
  pose: Pose3D,
  obb: OBB3D,
  host: HostRelation | null,
  support: SupportRelation,
  keepout_zone: Polygon2D | null,
  provenance: Provenance
}
```

```json
AssetRef {
  asset_id: string,
  kind: "gltf" | "proxy_gltf",
  uri: string,
  bound_to: string
}
```

```json
SplatAssetRecord {
  scene_id: string,
  source_scene_version: integer,
  status: "queued" | "processing" | "ready" | "failed",
  asset_id: string | null,
  uri: string | null,
  updated_at: timestamp
}
```

### 10.3 Supporting types

`Point2D`

* `x`
* `y`

`Point3D`

* `x`
* `y`
* `z`

`Vector3D`

* `x`
* `y`
* `z`

`Polygon2D`

* `vertices: Point2D[]`
* semantics: non-self-intersecting polygon in the local 2D frame implied by the containing field; first vertex is not repeated at the end; clockwise/counter-clockwise winding must be consistent within a scene.

`RectOnSurface`

* `min_u`
* `min_v`
* `width`
* `height`
* semantics: axis-aligned rectangle in the host surface's `surface_frame`; `u` runs horizontally across the surface and `v` runs upward within the surface plane.

`Pose3D`

* `position: Point3D`
* `yaw_degrees`
* semantics: all poses are expressed in the room-local frame; objects remain upright in MVP, so pitch and roll are implicitly `0`.

`OBB3D`

* `center: Point3D`
* `size_x`
* `size_y`
* `size_z`
* `yaw_degrees`
* semantics: oriented bounding box expressed in the room-local frame; `size_x/size_y` project to the floor plane for overlap and clearance checks.

`RoomCoordinateFrame`

* `origin: Point3D`
* `x_axis: Vector3D`
* `y_axis: Vector3D`
* `z_axis: Vector3D`
* `north_source: "true_north" | "scan_forward"`
* semantics: right-handed room-local frame used by every `Pose3D`, `OBB3D`, and every `SurfaceFrame`; `+z` is up, `+y` is scene north, and `+x` is scene east.

`SurfaceFrame`

* `origin: Point3D`
* `u_axis: Vector3D`
* `v_axis: Vector3D`
* `normal: Vector3D`
* semantics: local frame for wall/floor/ceiling surfaces. `RectOnSurface` coordinates resolve only through this frame.

`NamedWallRef`

* `wall_ref_id`
* `name`
* `surface_ids: string[]`
* `azimuth_degrees`
* `inward_normal_xy: Point2D`
* semantics: groups one or more wall surfaces into a stable planner-facing reference. Reserved MVP names are `north wall`, `south wall`, `east wall`, and `west wall`.

`HostRelation`

* `relation_type: "flush_to_wall" | "mounted_to_wall" | "embedded_in_wall" | "ceiling_mounted"`
* `host_surface_id: string`
* `anchor_rect: RectOnSurface | null`
* semantics: describes the surface an anchored/fixed item must stay attached to. Canonical absence of a host is represented by `host = null`; when a `HostRelation` is present, `host_surface_id` must resolve to a compatible wall or ceiling `Surface`.

`SupportRelation`

* `support_kind: "floor" | "wall" | "ceiling" | "object"`
* `support_entity_id: string`
* `contact_patch: Polygon2D | RectOnSurface | null`
* semantics: describes the entity bearing weight or physically supporting the item.

`FocalElementRef`

* `entity_id`
* `entity_type: "object" | "opening" | "fixed_element" | "surface"`
* `role: "primary" | "secondary"`
* `reason`
* semantics: explicit annotation used by layout scoring and targeting. The validator never infers focal elements on the fly.

`ConstraintSpec`

* `constraint_id`
* `kind: "opening_preserved" | "walkway_clearance" | "no_overlap_in_bounds" | "anchor_integrity" | "class_specific_clearance" | "desk_near_window" | "sofa_faces_focal_element" | "primary_path_not_serpentine"`
* `severity: "hard" | "soft"`
* `target_entity_ids: string[]`
* `params`
* `reason_code_on_fail: string | null`
* semantics: canonical declaration of an applicable rule instance. Hard constraints reject a plan; soft constraints feed scoring only.

`Provenance`

* `source_kind`: `measured | inferred | generated | user_authored`
* `confidence`: `0..1`
* `source_ref`: optional string
* `updated_at`

`MaterialState`

* `category`
* `color`
* `finish`
* `pattern`
* `reference_asset_id`

`CameraBookmark`

* `bookmark_id`
* `name`
* `camera_pose`
* `fov`
* `created_at`
* `updated_at`
* semantics: sidecar record keyed by `scene_id`; `bookmark_id` is an immutable reference to `camera_pose` + `fov`, so changing the saved view creates a new bookmark with a new `bookmark_id`. Bookmark sidecar changes do not create a new `SceneSnapshot` or increment `scene_version`.

`PhotorealEntry`

* `entry_id`
* `asset_id`
* `scene_version`
* `scene_snapshot_id`
* `bookmark_id: string | null`
* `camera_pose`
* `fov`
* `prompt_modifiers`
* `created_at`
* semantics: sidecar gallery record keyed to an immutable scene snapshot; it stores resolved camera parameters so later bookmark edits do not alter historical outputs.

`DerivedState`

* `zones[]`
* `clearance_paths[]`
* `soft_scores`
* `hard_violations[]`
* `selection_context_summary`
* semantics: recomputable cache derived from `SceneSnapshot.state`, typically stored by `snapshot_id`.

`OperationSummary`

* `request_id`
* `ops[]`
* `timestamp`
* `user_message`

### 10.4 Semantic rules

#### Room-local axes and named wall resolution

* Every geometric field is anchored to the room-local frame defined by `Room.coordinate_frame`: fields are stored either directly in room-local coordinates or in an explicit local surface frame (`SurfaceFrame`) defined relative to that room-local frame.
* `Shell.named_wall_refs` must provide stable planner-facing wall names for the room, including reserved cardinal names `north wall`, `south wall`, `east wall`, and `west wall`.
* A named wall may span multiple contiguous wall surfaces; each contributing `Surface` points back to the grouping via `named_wall_ref_id`.
* If capture cannot determine true compass north, ingest still assigns a stable scene north using `north_source = "scan_forward"`. All later references to `north wall` resolve against that stored frame, not against a recomputed heading.
* `RectOnSurface` coordinates are valid only when `host_surface_id` resolves to a `Surface` with a matching `surface_frame`.

#### Focal-element annotations

* `Room.focal_elements` is explicit canonical state, not derived cache.
* A focal element may reference a window, TV, architectural feature, or other intentionally named target used by soft constraints and chat grounding.
* Soft rule `SC-2 Sofa faces focal element` evaluates only against these annotations.

#### Host/support relationships

* `host` answers “what surface is this attached to?” while `support` answers “what physically carries this item?”
* `mobility = "anchored"` or `mobility = "fixed"` requires a valid `support` relation and, when applicable, a valid `host` relation.
* Examples:

  * wall-mounted TV: `host.relation_type = "mounted_to_wall"`, `support.support_kind = "wall"`
  * bed against a wall: `host.relation_type = "flush_to_wall"`, `support.support_kind = "floor"`
  * table lamp on a nightstand: `support.support_kind = "object"` with `support_entity_id = "nightstand_id"`
* `FixedElement` uses the same `host`/`support` semantics as `Object` but is never directly editable in MVP.

#### Parent/child and `include_children` movement rules

* `parent_id` may only reference another `Object` in the same room; the resulting graph must be acyclic.
* `parent_id` is a semantic relationship, not a coordinate frame switch. Child `pose` and `obb` remain stored in room-local coordinates.
* `child_movement_policy = "move_with_parent"` means the child is expected to inherit a parent transform when a parent move/rotate is applied with `include_children = true`.
* `include_children` defaults to `false`. When `true`, the exact parent transform delta is applied to all descendants whose `child_movement_policy` is `move_with_parent`, unless blocked by a lock or anchor/support rule.
* If `include_children = false`, descendants remain fixed in room coordinates. The validator must reject the operation with `PARENT_MOVE_VIOLATION` when that would detach a supported child, violate an anchor, or break an expected parent-child grouping.
* A child supported by another object (`support.support_kind = "object"`) must either move with that supporting object or be explicitly re-supported within the same atomic plan.

### 10.5 Model invariants

* IDs are stable across scene snapshots unless an entity is removed.
* `SceneSnapshot` is immutable once committed.
* `SceneHead.current_scene_version` is monotonic and must equal the `scene_version` of `SceneHead.current_snapshot_id`.
* Only `SceneSnapshot.state` and `SceneSnapshot.editing_asset_refs` participate in editable version history.
* `generate_photoreal`, splat jobs, bookmark edits, and recomputation of `derived_state_cache` do not increment `scene_version`.
* `derived_state_cache` is recomputed from snapshot state and may be dropped and rebuilt without schema migration.
* Unsupported captured items may exist as `generic_obstacle` objects. They participate in constraints even if not directly editable.
* Splat assets are optional sidecars and never modify editable scene state.
* All geometry uses meters and is expressed either directly in the room-local frame stored on the room or in an explicit `SurfaceFrame` defined relative to that frame.

### 10.6 Snapshot, versioning, and undo semantics

* A new `SceneSnapshot` is created only for initial ingest, a successful structural/material/lock edit plan, or a successful `undo_last_change`.
* Undo never rewinds, decrements, or reuses version numbers. It creates a new head snapshot with `mutation_kind = "undo_restore"` whose `state` and `editing_asset_refs` match the prior undoable snapshot.
* MVP undo depth is exactly one structural/material/lock commit. `SceneHead.undo_base_snapshot_id` points to the snapshot that can be restored by undo.
* After any successful structural/material/lock commit, `undo_base_snapshot_id` is updated to the pre-commit head snapshot. After a successful undo, the new head snapshot becomes current, `undo_base_snapshot_id` is cleared to `null`, and the prior undone state is no longer redo-able in MVP.
* Sidecar records must link back to immutable scene versions: photoreal records reference `scene_version` and `scene_snapshot_id`; splat/job records reference the source `scene_version` they were produced from.
* Camera bookmarks are sidecar metadata. They are not part of undo history and are not versioned scene state.

## 11. Supported object classes

Editable in MVP:

* bed
* nightstand
* desk
* chair
* table
* dresser
* bookshelf
* sofa
* rug
* lamp
* television
* storage

Non-editable fallback:

* `generic_obstacle`

If RoomPlan or the supplementary detector finds an object outside the editable set, it is stored as `generic_obstacle` with OBB and provenance. It blocks placement and paths but cannot be replaced through chat in MVP.

## 12. Typed operation contract

### 12.1 Operation plan request

```json
OperationPlanRequest {
  request_id: string,
  idempotency_key: string,
  scene_id: string,
  expected_scene_version: integer,
  selection_context: {
    selected_entity_ids: string[]
  },
  user_prompt: string
}
```

### 12.2 Planner response

One of:

* `clarification_request`
* `operation_plan_preview`
* `command_request`
* `rejection`

```json
OperationPlanPreview {
  request_id: string,
  preview_id: string,
  based_on_scene_version: integer,
  ops: SceneEditOperation[],
  explanation: string,
  canonical_plan_hash: string,
  apply_token: string,
  apply_token_expires_at: timestamp,
  idempotency_key: string
}
```

```json
CommandRequest {
  request_id: string,
  command_kind: "generate_photoreal" | "undo_last_change",
  endpoint: string,
  explanation: string,
  idempotency_key: string
}
```

```json
ApplyPlanRequest {
  preview_id: string,
  apply_token: string,
  canonical_plan_hash: string,
  expected_scene_version: integer,
  idempotency_key: string
}
```

### 12.3 Supported scene-edit operations

`move_object`

* target: `object_id`
* params: target position in room-local coordinates, optional target `NamedWallRef`/window relation, optional `include_children`
* semantics: `include_children` defaults to `false` and follows the parent/child rules in section 10.4
* MVP note: translation on floor plane only

`rotate_object`

* target: `object_id`
* params: yaw degrees, optional `include_children`
* semantics: parent rotation uses the same `include_children` rules as `move_object`

`replace_object`

* target: `object_id`
* params: desired class, style tags, optional asset id
* semantics: mutate object in place; preserve `object_id`

`add_object`

* params: class, style tags, target placement relation or explicit pose
* creates new object id

`remove_object`

* target: `object_id`

`lock_entity`

* target: `object_id` or `surface_id`

`unlock_entity`

* target: `object_id` or `surface_id`

`repaint_surface`

* target: `surface_id`
* params: color, finish

`swap_flooring`

* target: floor `surface_id`
* params: material selection

### 12.4 Dedicated command endpoints

`generate_photoreal`

* params: bookmark id or current camera, optional prompt modifiers
* routed to `POST /scenes/{scene_id}/photoreal`
* non-mutating sidecar job; never appears inside `OperationPlanPreview.ops`

`undo_last_change`

* no params beyond endpoint metadata (`expected_scene_version`, `idempotency_key`)
* routed to `POST /scenes/{scene_id}/undo`
* creates a new head snapshot whose editable state matches the prior undoable committed snapshot; never appears inside `OperationPlanPreview.ops`

### 12.5 Transaction and authority rules

* Max 5 scene-edit operations per user turn
* `/plan` returns canonical scene-edit ops plus server-issued apply credentials; the client may accept or reject the preview, but may not edit the returned ops
* `/apply` accepts only `ApplyPlanRequest`; submitting user-modified ops directly is invalid
* Plan previews are single-use, short-lived, and scoped to one scene version
* Entire plan is simulated before commit
* Entire plan commits atomically or fails atomically
* One successful plan that mutates editable state creates a new immutable `SceneSnapshot` and increments `scene_version` by 1
* `generate_photoreal` and bookmark changes are sidecar-only updates and do not create scene snapshots

### 12.6 Reason codes

The validator/API must return machine-readable reason codes.

Required MVP codes:

* `AUTH_REQUIRED`
* `SCENE_ACCESS_DENIED`
* `HANDOFF_EXPIRED`
* `HANDOFF_ALREADY_USED`
* `AMBIGUOUS_TARGET`
* `TARGET_NOT_FOUND`
* `VERSION_CONFLICT`
* `APPLY_TOKEN_INVALID`
* `APPLY_TOKEN_EXPIRED`
* `IDEMPOTENCY_CONFLICT`
* `ENTITY_LOCKED`
* `OBJECT_OVERLAP`
* `OUT_OF_BOUNDS`
* `OPENING_BLOCKED`
* `CLEARANCE_VIOLATION`
* `ANCHOR_VIOLATION`
* `UNSUPPORTED_CLASS`
* `ASSET_NOT_AVAILABLE`
* `PARENT_MOVE_VIOLATION`
* `UNDO_NOT_AVAILABLE`
* `SCENE_DELETED`
* `PHOTOREAL_PROVIDER_ERROR`

## 13. Planner behavior

The LLM planner is not allowed to mutate scene state directly.

It must:

1. read compact scene summary + relevant entities + selection context
2. emit only supported scene-edit operation schema, or request a dedicated command route for `generate_photoreal` / `undo_last_change`
3. ask for clarification if target is not unique
4. prefer deterministic edits over stylistic guessing
5. keep plans short and atomic
6. never let the client author or rewrite canonical ops after planning

Examples:

* “Move the desk under the window” → `move_object`
* “Keep this bed, don’t touch it” → `lock_entity`
* “Make it cozier” → either

  * clarification request, or
  * small multi-op plan if target surfaces/objects are clear and supported

## 14. Validation engine

### 14.1 Validation order

1. Schema validation
2. Target resolution
3. Version check
4. Lock check
5. Simulate all ops on scene copy
6. Hard constraints
7. Soft score recompute
8. Commit or reject

### 14.2 Hard constraints

**HC-1 Openings preserved**
Door swing zones and opening keep-out regions must remain unobstructed.

**HC-2 Walkway clearance**
A navigable path of at least 76 cm must exist from the room door to required access targets:

* bed access zone
* desk access zone if desk exists
* closet/storage access zone if present

**HC-3 No overlap / in bounds**
Object footprints may not intersect each other beyond tolerance and must remain inside the floor polygon.

**HC-4 Anchor integrity**
Anchored/fixed objects must remain attached to their host surface and valid support.

**HC-5 Class-specific access clearance**
Minimum local clearances:

* bed: at least one access side >= 60 cm
* desk: pullout zone behind chair >= 90 cm
* storage/dresser/closet front: >= 60 cm

### 14.3 Soft constraints

Soft score is normalized over applicable rules only.

**SC-1 Desk near window**
Desk center within target distance of a window wall or with direct line of sight to window.

**SC-2 Sofa faces focal element**
If sofa and focal element exist, orientation alignment must be within tolerance.

**SC-3 Primary path not serpentine**
Navigable path tortuosity should remain below threshold.

### 14.4 Derived state

After every accepted plan, recompute:

* applicable zones
* clearance paths
* hard violations
* soft scores
* human-readable score explanations

## 15. Asset retrieval

### 15.1 Library

MVP asset library:

* ~500 glTF assets
* ~15 furniture classes
* ~5 style tags

### 15.2 Retrieval inputs

* object class
* approximate dimensions
* style tags
* room type

### 15.3 Retrieval outputs

* best asset match
* fallback generic proxy if exact match unavailable

### 15.4 Acceptance rules

* retrieved asset must fit within object OBB scaling tolerance
* if fit fails, use proxy asset and warn silently in logs
* asset retrieval must never block scene editing

## 16. Photoreal generation spec

### 16.1 Inputs

* current committed scene version and `scene_snapshot_id`
* selected camera bookmark or current camera
* high-res quick render
* depth map
* edge map
* prompt string from scene state + modifiers

### 16.2 Outputs

* generated image asset
* sidecar gallery entry linked to `scene_version` and `scene_snapshot_id`
* provider metadata for debugging

### 16.3 Constraints

* photoreal output must not invent geometry that conflicts with conditioning inputs
* provider failure must not affect current scene
* provider may be swapped without schema change

## 17. APIs

Minimal backend contract:

`POST /captures/roomplan`

* upload `RoomPlanCaptureRequest`
* synchronously creates the initial scene snapshot, scene head, initial derived-state cache, and secure handoff artifact
* returns:

  * `scene_id`
  * `scene_version = 1`
  * `scene_snapshot_id`
  * `handoff_url`
  * `qr_payload`
  * `expires_at`
  * `video_upload_token`

`POST /handoffs/redeem`

* input: one-time handoff token from the URL or QR payload
* redeems the grant into an authenticated web session scoped to exactly one `scene_id`
* fails with `HANDOFF_EXPIRED`, `HANDOFF_ALREADY_USED`, or `SCENE_ACCESS_DENIED` if invalid

`POST /captures/{scene_id}/video`

* upload optional raw video for splat job
* requires the server-issued `video_upload_token` returned by `POST /captures/roomplan`; the token must match `{scene_id}`, expire quickly, and be rejected after a successful upload
* creates or updates the `SplatAssetRecord` sidecar to `queued`/`processing` and returns `job_id`

`GET /scenes/{scene_id}`

* requires an authenticated session scoped to `{scene_id}`
* returns the current scene read model: head, current snapshot, derived cache, and related sidecars

`POST /scenes/{scene_id}/plan`

* requires authenticated access to that scene
* input: `OperationPlanRequest`
* returns one of:

  * `clarification_request`
  * `operation_plan_preview`
  * `command_request`
  * `rejection`

`POST /scenes/{scene_id}/apply`

* requires authenticated access to that scene
* input: `ApplyPlanRequest`
* accepts only a server-issued preview via `preview_id` + `apply_token` + `canonical_plan_hash`; raw client-edited ops are rejected
* returns updated scene and validation summary

`POST /scenes/{scene_id}/photoreal`

* requires authenticated access to that scene
* dedicated command endpoint
* input: `scene_snapshot_id`, bookmark or current camera + modifiers, `idempotency_key`
* returns `job_id`

`GET /jobs/{job_id}`

* requires authenticated access to the owning scene
* returns job state for photoreal or splat

`POST /scenes/{scene_id}/undo`

* requires authenticated access to that scene
* dedicated command endpoint
* input: `expected_scene_version`, `idempotency_key`
* creates a new head snapshot that restores the last undoable committed editable state

`DELETE /scenes/{scene_id}`

* requires authenticated access to that scene
* input: `idempotency_key`
* deletes scene and attached assets

### 17.1 Conflict and retry behavior

* All mutating endpoints (`/apply`, `/photoreal`, `/undo`, `/delete`) require an `idempotency_key`.
* Retrying the same request with the same `idempotency_key` and identical body must return the original terminal response instead of duplicating work.
* Reusing an `idempotency_key` with a different request body returns `IDEMPOTENCY_CONFLICT`.
* `/apply` returns:

  * `VERSION_CONFLICT` if `expected_scene_version` is stale
  * `APPLY_TOKEN_INVALID` if `preview_id`, token, or plan hash does not match the server preview
  * `APPLY_TOKEN_EXPIRED` if the preview expired before acceptance
* `/undo` returns:

  * `VERSION_CONFLICT` if the caller is stale
  * `UNDO_NOT_AVAILABLE` if there is no undoable base snapshot
* `/photoreal` never mutates scene state. Safe retry with the same `idempotency_key` returns the same `job_id`.
* `DELETE /scenes/{scene_id}` is idempotent. After deletion, subsequent scene commands return `SCENE_DELETED`.
* Any scene endpoint that uses web-session auth returns `AUTH_REQUIRED` or `SCENE_ACCESS_DENIED` when called without a valid scene-scoped session. `POST /captures/{scene_id}/video` instead validates `video_upload_token`.

## 18. Non-functional requirements

### Performance

* scene usable within 20 seconds of scan completion
* quick render update under 1 second
* validation under 100 ms on 20 objects
* photoreal under 10 seconds median
* splat non-blocking

### Reliability

* stale-tab updates must fail with `VERSION_CONFLICT`
* no silent partial commits
* mutating request retries must be safe via `idempotency_key`
* scene must reload from backend state after refresh

### Privacy

* scene access requires a redeemed handoff or existing authenticated scene-scoped session, except for the companion app's one-time `video_upload_token` path for `POST /captures/{scene_id}/video`
* raw `scene_id` is not a shareable credential in MVP
* deleting a scene deletes:

  * canonical scene
  * photoreal gallery
  * uploaded capture video
  * splat asset
* no public sharing in MVP

### Observability

Log:

* planner output
* validation failures by reason code
* photoreal latency and failure rate
* asset retrieval misses
* splat job duration

## 19. Success metrics

### Quantitative

* Edit validation latency < 100 ms on 20-object room
* Scan-to-usable-scene < 20 seconds from RoomPlan completion
* Quick render < 1 second per edit
* Photoreal < 10 seconds per generation
* Constraint catch rate >= 95% on 200 invalid edits
* Conversational edit success rate >= 80% on 100 test prompts
* Photoreal structural consistency >= 90%

### Qualitative

* Designers say it is usable as a starting point
* Lay users say photoreal output is good enough to share
* Reviewers describe the system as understanding the room, not just styling it

## 20. Milestones

### Week 1

* finalize schema
* build RoomPlan → canonical scene mapper
* stand up scene storage

### Week 2

* web editor shell
* load scene
* layout pane with shell + objects
* selection model

### Week 3

* quick renderer
* asset library ingestion
* proxy fallback path

### Week 4

* validation engine
* hard constraints
* soft score scaffolding
* single-step undo

### Week 5

* LLM planner
* typed operation pipeline
* chat UI
* reason-code messaging

### Week 6

* photoreal pipeline
* camera bookmarks
* gallery
* provider benchmark

### Week 7

* asynchronous splat jobs
* scan pane swap logic
* polish and bug fixing

### Week 8

* eval harness
* scripted demo room set
* failure handling
* presentation hardening

## 21. Cut lines if schedule slips

Cut in this order, without changing the core product thesis:

1. supplementary detector for non-RoomPlan classes
   fallback: `generic_obstacle`

2. `add_object` and `remove_object`
   keep: move, rotate, replace, repaint, swap flooring

3. arbitrary saved bookmarks
   keep: 2 default views + current camera

4. splat ready during demo
   keep: RoomPlan preview only

5. soft-constraint explanation polish
   keep: raw score + hard validation

Do **not** cut:

* canonical scene versioning
* typed operations
* hard constraint validation
* quick render
* photoreal tied to scene version

## 22. MVP exit criteria

The MVP is done when all of the following work on a real bedroom scan:

1. User scans room on iPhone and opens web editor
2. Editor shows scan placeholder, layout, and quick render
3. “Move the desk under the window” succeeds
4. “Put the bed against the north wall” fails with a valid reason if it blocks an opening or access zone
5. “Replace the rug with something warm and earthy” succeeds
6. “Keep this bed, don’t touch it” locks the bed and future move attempts fail
7. “Show me what this would actually look like” generates a photoreal image tied to the current scene version
8. Undo reverts the last committed structural/material/lock change
9. Refresh reloads the same latest scene state
10. If splat completes, scan pane updates without changing editable state

## 23. Decisions already made

To keep this buildable, these are now fixed:

* MVP is one room only
* iPhone is the only capture path
* quick render is the only live renderer
* photoreal is button/chat-triggered, not continuous
* splat is secondary and non-blocking
* edits are chat-first with selection-assisted disambiguation
* plans are atomic
* one-step undo is in scope

This is the version I would hand to engineering.

