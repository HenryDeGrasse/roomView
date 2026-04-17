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
* Typed edit operations:

  * `move_object`
  * `rotate_object`
  * `replace_object`
  * `add_object`
  * `remove_object`
  * `lock_entity`
  * `unlock_entity`
  * `repaint_surface`
  * `swap_flooring`
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
4. App uploads:

   * RoomPlan scene payload
   * metadata
   * optional raw video for splat training
5. Backend creates canonical scene and returns `scene_id`.
6. User opens web editor on laptop with that `scene_id`.

**Acceptance criteria**

* A valid RoomPlan scan produces a canonical scene without manual intervention.
* Scene becomes editable before splat is ready.
* If splat never completes, the editor still functions.

### 7.2 Editor load flow

1. Web app loads scene JSON.
2. Scan pane shows RoomPlan parametric preview.
3. Layout pane shows top-down shell, openings, and object OBBs.
4. Render pane shows Quick render using retrieved assets.
5. If splat later becomes ready, scan pane updates without changing scene state.

**Acceptance criteria**

* Editor loads a usable scene from canonical JSON only.
* Scan pane is read-only and never used for validation or mutation.
* Quick render and layout always reflect current committed scene version.

### 7.3 Edit flow

1. User selects an object/surface or types in chat.
2. LLM planner converts prompt into an operation plan.
3. Validator simulates the plan on a scene copy.
4. If valid, backend commits the plan atomically.
5. UI updates layout and quick render.
6. If invalid, UI shows a reason and optional suggested next action.

**Acceptance criteria**

* One user prompt results in either:

  * one atomic committed plan, or
  * one clarification request, or
  * one rejection with reason code
* No partial commit on failed plan validation.

### 7.4 Photoreal flow

1. User clicks “Generate Photoreal” or uses chat.
2. System uses current view or chosen bookmark.
3. Quick render produces high-resolution color, depth, and edge inputs.
4. Provider generates conditioned photoreal image.
5. Result is stored in gallery with `scene_version` and `bookmark_id`.

**Acceptance criteria**

* Photoreal output is attached to a specific immutable scene version.
* Re-generating from the same bookmark on the same version produces structurally consistent images.
* Photoreal generation does not mutate scene geometry or increment `scene_version`.

### 7.5 Undo flow

1. User clicks undo or types “undo that.”
2. Backend restores previous committed scene version.
3. Layout and render update.
4. Gallery images remain attached to their original versions.

**Acceptance criteria**

* Exactly one structural/material commit can be undone.
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
* assigns stable IDs
* stores initial scene version

**Scene Service**

* stores canonical scene
* manages versions
* exposes scene read/write APIs

**Planner Service**

* calls LLM with scene summary, selection context, and asset manifest
* returns typed operation plan or clarification

**Validation Service**

* simulates operation plans
* runs hard and soft constraints
* commits or rejects

**Asset Service**

* resolves class/style/dimension requests to glTF assets
* provides fallback proxy assets when exact match is unavailable

**Photoreal Service**

* renders high-res conditioning inputs
* calls provider
* stores output in gallery

**Splat Job Service**

* runs asynchronous training on uploaded video
* attaches `AssetRef(kind=splat)` when ready

**Web App**

* scene viewer
* layout view
* quick renderer
* chat client
* gallery
* bookmark management

### 9.2 Source of truth

The only logical source of truth is the canonical scene JSON.

The following are never sources of truth:

* splat
* quick render
* photoreal outputs
* RoomPlan preview meshes

## 10. Canonical scene model

### 10.1 Core entities

```json
Scene {
  scene_id: string,
  scene_version: integer,
  source: "scanned",
  units: "m",
  style_tags: string[],
  room: Room,
  assets: AssetRef[],
  camera_bookmarks: CameraBookmark[],
  photoreal_gallery: PhotorealEntry[],
  derived_state: DerivedState,
  last_operation: OperationSummary | null
}
```

```json
Room {
  room_id: string,
  room_type: "bedroom",
  shell: Shell,
  objects: Object[],
  constraints: ConstraintSpec[],
  section_hints: string[]
}
```

```json
Shell {
  floor_polygon: Polygon2D,
  surfaces: Surface[],
  ceiling_height: number,
  openings: Opening[],
  fixed_elements: FixedElement[]
}
```

```json
Surface {
  surface_id: string,
  type: "wall" | "floor" | "ceiling",
  geometry_ref: string,
  material_state: MaterialState,
  user_locked: boolean,
  provenance: Provenance
}
```

```json
Opening {
  opening_id: string,
  host_surface_id: string,
  type: "door" | "window" | "closet_door",
  rect: RectOnSurface,
  swing_zone: Polygon2D | null,
  connects_to_room_id: string | null,
  provenance: Provenance
}
```

```json
Object {
  object_id: string,
  class: string,
  attributes: string[],
  parent_id: string | null,
  pose: Pose3D,
  obb: OBB3D,
  mobility: "movable" | "anchored" | "fixed",
  asset_ref: string | null,
  style_tags: string[],
  material_state: MaterialState | null,
  user_locked: boolean,
  provenance: Provenance
}
```

```json
AssetRef {
  asset_id: string,
  kind: "gltf" | "splat" | "photoreal",
  uri: string,
  bound_to: string
}
```

### 10.2 Supporting types

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

`PhotorealEntry`

* `entry_id`
* `asset_id`
* `scene_version`
* `bookmark_id`
* `prompt_modifiers`
* `created_at`

`DerivedState`

* `zones[]`
* `clearance_paths[]`
* `soft_scores`
* `hard_violations[]`
* `selection_context_summary`

`OperationSummary`

* `request_id`
* `ops[]`
* `timestamp`
* `user_message`

### 10.3 Model invariants

* IDs are stable across scene versions unless an entity is removed.
* `scene_version` increments once per committed edit plan.
* `generate_photoreal` does not increment `scene_version`.
* `derived_state` is recomputed after every committed plan.
* Unsupported captured items may exist as `generic_obstacle` objects. They participate in constraints even if not directly editable.
* Splat assets are optional and attached by reference only.

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
* `operation_plan`
* `rejection`

```json
OperationPlan {
  request_id: string,
  ops: Operation[],
  explanation: string
}
```

### 12.3 Supported operations

`move_object`

* target: `object_id`
* params: target position, optional target wall/window relation, optional `include_children`
* MVP note: translation on floor plane only

`rotate_object`

* target: `object_id`
* params: yaw degrees

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

`generate_photoreal`

* params: bookmark id or current camera, optional prompt modifiers
* non-mutating job

`undo_last_change`

* no params
* restores prior committed scene version

### 12.4 Transaction rules

* Max 5 operations per user turn
* Entire plan is simulated before commit
* Entire plan commits atomically or fails atomically
* One successful plan increments `scene_version` by 1
* `last_operation` stores plan summary, not raw user text alone

### 12.5 Reason codes

The validator must return machine-readable reason codes.

Required MVP codes:

* `AMBIGUOUS_TARGET`
* `TARGET_NOT_FOUND`
* `VERSION_CONFLICT`
* `ENTITY_LOCKED`
* `OBJECT_OVERLAP`
* `OUT_OF_BOUNDS`
* `OPENING_BLOCKED`
* `CLEARANCE_VIOLATION`
* `ANCHOR_VIOLATION`
* `UNSUPPORTED_CLASS`
* `ASSET_NOT_AVAILABLE`
* `PARENT_MOVE_VIOLATION`
* `PHOTOREAL_PROVIDER_ERROR`

## 13. Planner behavior

The LLM planner is not allowed to mutate scene state directly.

It must:

1. read compact scene summary + relevant entities + selection context
2. emit only supported operation schema
3. ask for clarification if target is not unique
4. prefer deterministic edits over stylistic guessing
5. keep plans short and atomic

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

* current committed scene version
* selected camera bookmark or current camera
* high-res quick render
* depth map
* edge map
* prompt string from scene state + modifiers

### 16.2 Outputs

* generated image asset
* gallery entry linked to `scene_version`
* provider metadata for debugging

### 16.3 Constraints

* photoreal output must not invent geometry that conflicts with conditioning inputs
* provider failure must not affect current scene
* provider may be swapped without schema change

## 17. APIs

Minimal backend contract:

`POST /captures/roomplan`

* upload RoomPlan payload
* returns `scene_id`

`POST /captures/{scene_id}/video`

* upload optional raw video for splat job

`GET /scenes/{scene_id}`

* returns latest scene JSON

`POST /scenes/{scene_id}/plan`

* input: `OperationPlanRequest`
* returns clarification or operation plan preview

`POST /scenes/{scene_id}/apply`

* input: approved operation plan
* returns updated scene and validation summary

`POST /scenes/{scene_id}/photoreal`

* input: bookmark or current camera + modifiers
* returns job id

`GET /jobs/{job_id}`

* returns job state for photoreal or splat

`POST /scenes/{scene_id}/undo`

* reverts last committed scene change

`DELETE /scenes/{scene_id}`

* deletes scene and attached assets

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
* scene must reload from backend state after refresh

### Privacy

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
8. Undo reverts the last committed structural/material change
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

