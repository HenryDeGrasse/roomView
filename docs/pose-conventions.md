# Pose and Coordinate Conventions

Single-source reference for the pose math flowing through RoomView. If something here changes, the downstream code (Swift recorder, TS ingest, web viewer, Phase 2 surface projection) changes with it.

## World frame

RoomView's **scene world frame is right-handed Z-up**.

- `+Z` is up (opposite gravity)
- `+X` and `+Y` form the horizontal floor plane
- Floor polygons carry 2D `(x, y)` coordinates that map directly to world `(X, Y)` with z=0
- `Surface.type = "floor"` sits at z=0; ceilings sit at `shell.ceiling_height`
- Object OBBs have `size_z` = vertical extent (e.g. a bed's `size_z ≈ 0.5–0.6` m for its height)
- Units: meters

This matches the fixture (`fixtures/roomplan/bedroom-primary`) and the web viewer (`apps/web/src/viewer.js` explicitly sets `camera.up = (0, 0, 1)`). The Z-up choice is called out in the viewer source as intentional: it eases future USD/DXF export without a root-rotation undo step.

This is **not** the same as ARKit's runtime world frame (right-handed Y-up). An on-device iPhone bundle produced by the Swift `CaptureBundleWriter` emits Y-up pose data because that's what ARKit hands us; adapters like `scripts/arkitscenes-to-bundle.py` consume ARKitScenes which is natively Z-up. **The scene stores whatever frame the bundle arrives in**, so a real iPhone capture and an ARKitScenes import will not agree on "up" unless one of them is remapped before ingest. Remapping the Swift-emitted bundle to Z-up on-device (or in the TS ingest) is a known open question — see roadmap.md.

The RoomPlan `coordinate_frame` on an ingested scene describes the room's own local axes. The `origin` is the room's corner; `x_axis`/`y_axis`/`z_axis` point along the room-local u/v/up directions. Object positions are in **world** coordinates but have been anchored so the room corner sits at the world origin — so world and room-local coordinates typically coincide.

## Camera frame

**ARKitScenes bundles** (adapter-sourced) use **OpenCV** camera convention:

- `+X` is right across the image
- `+Y` is DOWN in the image (matches v increasing downward in the JPG)
- `+Z` is forward, into the scene (matches the direction the lens points)

The forward vector in world space is `+transform.columns.2.xyz` (third column, positive).

This was verified empirically: the stored `camera_transform` columns point image-"up" in -Z_world for ~95% of the fixture frames, meaning the phone's sensor +Y is anti-aligned with world-up — which only makes sense if image-DOWN is cam +Y (OpenCV). Earlier drafts of this doc claimed OpenGL convention; that was wrong and produced upside-down splats (floor content rendered on the ceiling). See `scripts/splat-generate.py` `_unproject_frame` and `scripts/bundle-to-meshes.py` `arkit_world_from_camera_to_opencv_camera_from_world`.

**On-device iPhone bundles** (`CaptureBundleWriter`, not yet wired end-to-end) produce raw ARKit poses in OpenGL camera convention (+X right, +Y up in image, -Z forward). When we wire that path, the ingest adapter will need to translate to the canonical ARKitScenes/OpenCV convention so every downstream consumer can assume one frame.

## `camera_transform` — 16-element column-major 4x4

Every `CapturedFrame.camera_transform` is a 4x4 matrix serialized as **16 floats in column-major order**. This matches `simd_float4x4` memory layout on iOS and the convention used by most graphics APIs.

Reading indices as `[col][row]`:

```
index 0:  m[0][0]        index 4:  m[1][0]        index 8:  m[2][0]        index 12: m[3][0]  (tx)
index 1:  m[0][1]        index 5:  m[1][1]        index 9:  m[2][1]        index 13: m[3][1]  (ty)
index 2:  m[0][2]        index 6:  m[1][2]        index 10: m[2][2]        index 14: m[3][2]  (tz)
index 3:  m[0][3]        index 7:  m[1][3]        index 11: m[2][3]        index 15: m[3][3]  (1)
```

So indices `12, 13, 14` are the camera's world-space position `(tx, ty, tz)`. Indices `8, 9, 10` are the third column — negate those three values for the camera's forward direction in world.

The transform is **world-from-camera**: it takes a point in camera-local coordinates and produces world coordinates. To project world points into the camera, invert it.

## `camera_pose` — `Pose3D` simplification

`CapturedFrame.camera_pose` is a `Pose3D = { position: Point3D, yaw_degrees: number }`. It is a **lossy projection** of `camera_transform`, kept for compatibility with `CameraBookmark` and other pose-consumers that never needed pitch/roll.

Derivation depends on which "up" the bundle is in:

- **Z-up bundles** (ARKitScenes adapter, fixture-equivalent scenes):
  ```
  position = (transform[12], transform[13], transform[14])
  yaw_radians = atan2(R[1][0], R[0][0])   // rotation about +Z
  yaw_degrees = yaw_radians * 180 / π
  ```

- **Y-up bundles** (on-device iPhone CaptureBundleWriter, which carries raw ARKit poses):
  ```
  position = (transform[12], transform[13], transform[14])
  forward  = -(transform[8], transform[9], transform[10])
  yaw_radians = atan2(forward.x, forward.z)  // rotation about +Y
  yaw_degrees = yaw_radians * 180 / π
  ```

Readers that need full orientation (pitch, roll) **must** use `camera_transform`. `camera_pose` is for UI/bookmarks only. This is called out at the point of use in `CaptureBundleWriter.poseRecord(for:)` and the TS `postCaptureFrames` path.

Wall-azimuth yaw uses a different convention (`WALL_NAME_TO_AZIMUTH` in `apps/api/src/roomplan-ingest.ts`: north=0, east=90, south=180, west=270). These are **not** the same space — wall yaw is about the room frame's normals; camera yaw is about the world-frame forward vector. Don't compare them without composing through the room frame.

## Intrinsics

`CameraIntrinsics = { fx, fy, cx, cy, width, height }` in pixels.

ARKit's `ARCamera.intrinsics` is a 3x3 matrix; the relevant entries are:

```
fx = intrinsics.columns.0.x
fy = intrinsics.columns.1.y
cx = intrinsics.columns.2.x
cy = intrinsics.columns.2.y
```

`width` and `height` come from `ARCamera.imageResolution`, **not** the depth map's resolution. The depth map is a downsampled LiDAR grid (typically 256x192 or smaller); the RGB is full camera resolution. A projection pipeline that uses the depth grid must scale coordinates from the RGB resolution down to the depth resolution, not assume they match.

Vertical field of view — used to materialize a `CameraBookmark.fov`:

```
fov_vertical_radians = 2 * atan(height / (2 * fy))
fov_vertical_degrees = fov_vertical_radians * 180 / π
```

This is what `computeFovDegreesFromIntrinsics` does in the API ingest.

## Depth map

- Encoded on the wire as a **NumPy v1.0 `.npy` file** wrapping a `float32` 2D array in row-major (C) order.
- Each pixel value is the **depth in meters** from the camera's optical center along the `-Z` axis (camera space), i.e. radial-Z, not Euclidean distance.
- Resolution is whatever ARKit emitted (device-dependent; expect 256x192 on current iPhone Pro).
- Encoding is produced by `NumpyEncoder.encodeFloat32` in the Swift Package and consumed by both `scripts/phase0-render-bench.py` (via `numpy.load`) and any TS-side reader that wants to interpret the bytes.

A non-finite pixel (NaN, Inf) indicates ARKit had no depth estimate there. The confidence map is the authoritative signal for per-pixel trust.

## Confidence map

- Optional. Only present when ARKit emits one; Swift recorder forwards it verbatim.
- NumPy `.npy` `uint8` 2D array, same resolution as the depth map.
- Values follow Apple's `ARConfidenceLevel`: `0 = low`, `1 = medium`, `2 = high`. No RoomView-specific remapping.

## What each consumer needs to know

| Consumer | Uses `camera_transform` | Uses `camera_pose` | Uses `intrinsics` | Uses depth | Uses confidence |
|----------|------------------------|--------------------|--------------------|------------|-----------------|
| Web editor strip (scan pane) | — | position only (display) | — | link only | link only |
| CameraBookmark materialization | — (position from transform is fine if unified later) | both | fov derivation | — | — |
| Phase 0 render bench | via `pose.json` | — | yes | yes | no (yet) |
| Phase 2 surface projection (planned) | yes (invert for world→camera) | — | yes | yes | yes (mask) |

## When to update this doc

- The scene's world frame is rebased (e.g. aligning to room axes on ingest) — this invalidates the "no rebase on ingest" claim above.
- `camera_transform` adds row-major variant or alternative layout.
- Intrinsics are switched to the depth resolution instead of RGB resolution.
- Depth encoding switches from `.npy` to a different format (e.g. EXR, raw binary header).
- Milestone 3 lands surface projection — update the consumer table with the concrete call sites.
