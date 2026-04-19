# Pose and Coordinate Conventions

Single-source reference for the pose math flowing through RoomView. If something here changes, the downstream code (Swift recorder, TS ingest, web viewer, Phase 2 surface projection) changes with it.

## World frame

RoomView's world frame is **ARKit's world frame** — there is no rebase on ingest.

- Right-handed
- `+Y` is up (opposite gravity)
- `+X` and `+Z` form the horizontal plane; the initial orientation of `+X`/`+Z` is defined by how ARKit initializes the session (typically first-frame-camera-aligned, unless a world map anchors it)
- Units: meters

When a scanner is started, ARKit's world origin coincides with the device's initial pose. Subsequent frames are expressed relative to that origin.

The RoomPlan `coordinate_frame` on an ingested scene describes the room's own axes, which may differ from the raw ARKit axes. For captured frames we record the raw ARKit pose (not room-relative) — downstream consumers that need room-relative poses compose with the room's frame.

## Camera frame

ARKit uses the standard computer-vision camera convention:

- `+X` is right across the image
- `+Y` is up in the image
- `-Z` is the direction the camera is looking (forward)

So the forward vector in world space is `-transform.columns.2.xyz` (negate the third column's xyz).

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

Derivation (what the Swift recorder and the TS verifier both do):

```
position = (transform[12], transform[13], transform[14])
forward  = -(transform[8], transform[9], transform[10])
yaw_radians  = atan2(forward.x, forward.z)
yaw_degrees  = yaw_radians * 180 / π
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
