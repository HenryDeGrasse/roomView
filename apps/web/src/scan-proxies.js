// scan-proxies.js — scan-native object proxies (Showcase phase).
//
// Takes captured_frames (ARKit-shape RGB + float32 depth + camera transform
// + intrinsics) and the Scene's object OBBs, and produces per-object point
// clouds made of the actual pixels that hit that object. Rendered as
// soft-disc splats in three.js.
//
// Pipeline, all client-side:
//   1. fetch each frame's depth .npy and RGB jpg/png (parallel)
//   2. unproject depth pixels → camera-space 3D rays → world points
//      (using the frame's camera_transform + intrinsics, per
//      docs/pose-conventions.md — ARKit camera convention, Z-up world)
//   3. sample RGB at the matching pixel → per-point color
//   4. clip points into each object's OBB (local-frame bounds test)
//   5. merge across frames with voxel-hash dedup, confidence-weighted
//      color average
//   6. class-aware symmetry fill — mirror observed points across the
//      OBB's local Y and/or X for classes that are symmetric; tag
//      inferred points so the shader renders them slightly dimmer
//   7. splat shader: circular alpha falloff discs, size ∝ 1/sqrt(local_density)
//      so sparse regions still look solid
//
// Produces a Map<object_id, THREE.Points>. Caller decides whether to
// replace the OBB wireframe proxy (scan pane) or overlay on top of it.
//
// The whole file is deliberately framework-free apart from three.js.

import * as THREE from 'three';

const DEFAULT_VOXEL_CELL_M = 0.02;            // 2 cm dedup grid
const DEFAULT_MIN_POINTS_PER_OBJECT = 40;     // below this → skip proxy
const DEFAULT_MAX_POINTS_PER_OBJECT = 40000;  // random subsample if above
const SYMMETRY_FILL_EPSILON_M = 0.03;         // mirrored points only added if
                                              // no observed point within this
                                              // radius of the mirror location
const PI = Math.PI;

// Per-class symmetry axes in OBB local frame. "x" mirrors across y–z plane
// (left-right), "y" mirrors across x–z plane (front-back), "z" across x-y.
// These are canonical-furniture heuristics — close enough that they improve
// coverage more than they introduce artifacts. Conservative when unsure.
const CLASS_SYMMETRY_AXES = {
  bed: ['x'],
  nightstand: ['x'],
  desk: ['x'],
  table: ['x', 'y'],
  chair: ['x'],
  dresser: ['x'],
  bookshelf: ['x'],
  sofa: ['x'],
  rug: [],
  lamp: ['x', 'y'],
  television: [],
  storage: ['x'],
  generic_obstacle: [],
};

// --- OBB wireframes ------------------------------------------------------
//
// Every named scene object gets a thin wireframe box in the scan view. This
// gives the 3 objects with no mesh/splat coverage (chairs/TVs the camera
// never imaged) a visible presence, and makes selection legible — the
// selected object's box lights up while the rest dim. The wireframes are
// always layered above the splat/mesh content so they read clearly.
//
// Per-class accent color keeps object identity obvious in a single glance.

const CLASS_ACCENTS = {
  bed: 0x9fb6ff,          // periwinkle
  storage: 0x9affc0,      // mint
  nightstand: 0x9affc0,
  dresser: 0x9affc0,
  bookshelf: 0x9affc0,
  chair: 0xffc57a,        // amber
  sofa: 0xffc57a,
  desk: 0xffc57a,
  table: 0xffa8a8,        // coral
  lamp: 0xfff4a8,         // butter
  television: 0xc0a8ff,   // lavender
  rug: 0x8d9aa8,          // slate
  generic_obstacle: 0x8d9aa8,
};

const OBB_COLOR_DIM = 0.55;   // dim opacity for unselected OBBs
const OBB_COLOR_BRIGHT = 1.0; // full opacity for the selected OBB
const OBB_LINEWIDTH_NORMAL = 1;
const OBB_LINEWIDTH_SELECTED = 2;

/**
 * Build a THREE.Group of line-box wireframes — one per object in
 * scene.snapshot.state.room.objects. Each box carries userData.object_id
 * so callers can target selection highlights by entity id.
 */
export function buildObjectOutlines(scene) {
  const group = new THREE.Group();
  group.name = 'scan_object_outlines';
  const objects = scene?.snapshot?.state?.room?.objects ?? [];
  for (const obj of objects) {
    const line = buildOneOutline(obj);
    if (line) group.add(line);
  }
  return group;
}

function buildOneOutline(obj) {
  const obb = obj?.obb;
  if (!obb) return null;
  const hx = obb.size_x * 0.5;
  const hy = obb.size_y * 0.5;
  const hz = obb.size_z * 0.5;
  // 8 corners in local frame
  const corners = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corners.push([sx * hx, sy * hy, sz * hz]);
      }
    }
  }
  // 12 edges as index pairs into the 8-corner list (bit encoding)
  const edges = [
    [0, 1], [2, 3], [4, 5], [6, 7],  // along z
    [0, 2], [1, 3], [4, 6], [5, 7],  // along y
    [0, 4], [1, 5], [2, 6], [3, 7],  // along x
  ];
  const positions = new Float32Array(edges.length * 2 * 3);
  for (let i = 0; i < edges.length; i += 1) {
    const [a, b] = edges[i];
    const pa = corners[a]; const pb = corners[b];
    positions[i * 6 + 0] = pa[0]; positions[i * 6 + 1] = pa[1]; positions[i * 6 + 2] = pa[2];
    positions[i * 6 + 3] = pb[0]; positions[i * 6 + 4] = pb[1]; positions[i * 6 + 5] = pb[2];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const color = CLASS_ACCENTS[obj.class] ?? 0xcfd3da;
  const material = new THREE.LineBasicMaterial({
    color, transparent: true, opacity: OBB_COLOR_DIM,
  });
  const line = new THREE.LineSegments(geometry, material);
  // Place the box in world space via the OBB's yaw + center.
  const center = obb.center || { x: 0, y: 0, z: 0 };
  const yawDeg = obb.yaw_degrees || 0;
  line.position.set(center.x, center.y, center.z);
  line.rotation.z = yawDeg * (Math.PI / 180);
  line.userData = {
    scan_obb: true,
    object_id: obj.object_id,
    object_class: obj.class,
    base_color: color,
  };
  return line;
}

/**
 * Apply a selection highlight to a set of outlines produced by
 * buildObjectOutlines. Pass null/undefined to clear.
 */
export function setOutlineSelection(outlinesGroup, selectedObjectId) {
  if (!outlinesGroup) return;
  for (const child of outlinesGroup.children) {
    if (!child.userData?.scan_obb) continue;
    const isSelected = !!selectedObjectId && child.userData.object_id === selectedObjectId;
    if (child.material) {
      child.material.opacity = isSelected ? OBB_COLOR_BRIGHT : OBB_COLOR_DIM;
      child.material.linewidth = isSelected ? OBB_LINEWIDTH_SELECTED : OBB_LINEWIDTH_NORMAL;
      child.material.needsUpdate = true;
    }
  }
}

// --- Tier 2 — scan mesh loader (ASCII PLY) -------------------------------

/**
 * Fetch the mesh manifest for a fixture if present and return a parsed
 * Map<object_id, three.js Mesh>. Meshes are produced offline by
 * scripts/bundle-to-meshes.py (TSDF fusion or Poisson reconstruction) and
 * committed under fixtures/roomplan/{id}/meshes/. When a mesh exists for an
 * object, the scan pane should prefer it over the Tier 1 point-cloud proxy.
 *
 * Returns null when no manifest is found (fixture hasn't been processed by
 * Tier 2 yet) — caller falls back to buildScanProxies.
 */
export async function loadScanMeshes(fixtureId, options = {}) {
  if (!fixtureId) return null;
  const manifestUrl = options.manifestUrl || ('/dev/fixtures/' + encodeURIComponent(fixtureId) + '/meshes/manifest.json');
  const manifestResponse = await fetch(manifestUrl);
  if (!manifestResponse.ok) return null;
  const manifest = await manifestResponse.json();
  if (!manifest || typeof manifest !== 'object' || !manifest.meshes) return null;

  const entries = Object.entries(manifest.meshes);
  const results = await Promise.all(entries.map(async ([objectId, relPath]) => {
    try {
      const url = '/dev/fixtures/' + encodeURIComponent(fixtureId) + '/' + relPath;
      const plyText = await fetch(url).then((r) => r.ok ? r.text() : null);
      if (!plyText) return null;
      const mesh = plyAsciiToMesh(plyText);
      if (!mesh) return null;
      const perObjectMethod = (manifest.methods && manifest.methods[objectId]) || manifest.mode || 'tsdf';
      mesh.userData = {
        scan_mesh: true,
        object_id: objectId,
        vertex_count: mesh.geometry.getAttribute('position').count,
        mode: perObjectMethod,
      };
      return [objectId, mesh];
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[scan-proxies] mesh load failed', objectId, err);
      return null;
    }
  }));

  const out = new Map();
  for (const entry of results) {
    if (entry) out.set(entry[0], entry[1]);
  }
  return { manifest, meshes: out };
}

/**
 * Minimal ASCII PLY parser tailored to what Open3D's `write_triangle_mesh`
 * emits in ascii mode: header declares vertex / face elements with typed
 * properties, body has one vertex per line followed by one face per line
 * prefixed by a count. We support the subset we actually emit — x/y/z,
 * optional nx/ny/nz, optional r/g/b (as uchar), and triangle faces.
 */
function plyAsciiToMesh(text) {
  const headerEnd = text.indexOf('\nend_header\n');
  if (headerEnd < 0) return null;
  const headerLines = text.slice(0, headerEnd).split('\n');
  if (headerLines[0] !== 'ply') return null;
  if (!headerLines.some((line) => line.trim() === 'format ascii 1.0')) return null;

  const elements = [];
  let current = null;
  for (const line of headerLines) {
    if (line.startsWith('comment') || line.startsWith('ply') || line.startsWith('format')) continue;
    if (line.startsWith('element ')) {
      const [, name, countStr] = line.split(/\s+/);
      current = { name, count: parseInt(countStr, 10), properties: [] };
      elements.push(current);
    } else if (line.startsWith('property ')) {
      if (!current) return null;
      const parts = line.split(/\s+/);
      if (parts[1] === 'list') {
        current.properties.push({ kind: 'list', countType: parts[2], valueType: parts[3], name: parts[4] });
      } else {
        current.properties.push({ kind: 'scalar', type: parts[1], name: parts[2] });
      }
    }
  }

  const bodyStart = headerEnd + '\nend_header\n'.length;
  const bodyLines = text.slice(bodyStart).split('\n');

  const vertexElement = elements.find((e) => e.name === 'vertex');
  const faceElement = elements.find((e) => e.name === 'face');
  if (!vertexElement || !faceElement) return null;

  const positions = new Float32Array(vertexElement.count * 3);
  const hasNormals = vertexElement.properties.some((p) => p.name === 'nx');
  const normals = hasNormals ? new Float32Array(vertexElement.count * 3) : null;
  const hasColors = vertexElement.properties.some((p) => p.name === 'red');
  const colors = hasColors ? new Float32Array(vertexElement.count * 3) : null;

  const vertexPropertyIndex = Object.fromEntries(
    vertexElement.properties.map((p, i) => [p.name, i]),
  );

  let cursor = 0;
  for (let i = 0; i < vertexElement.count; i += 1) {
    const line = bodyLines[cursor++];
    if (!line) return null;
    const parts = line.split(/\s+/);
    positions[i * 3 + 0] = parseFloat(parts[vertexPropertyIndex.x]);
    positions[i * 3 + 1] = parseFloat(parts[vertexPropertyIndex.y]);
    positions[i * 3 + 2] = parseFloat(parts[vertexPropertyIndex.z]);
    if (normals) {
      normals[i * 3 + 0] = parseFloat(parts[vertexPropertyIndex.nx]);
      normals[i * 3 + 1] = parseFloat(parts[vertexPropertyIndex.ny]);
      normals[i * 3 + 2] = parseFloat(parts[vertexPropertyIndex.nz]);
    }
    if (colors) {
      colors[i * 3 + 0] = parseFloat(parts[vertexPropertyIndex.red]) / 255;
      colors[i * 3 + 1] = parseFloat(parts[vertexPropertyIndex.green]) / 255;
      colors[i * 3 + 2] = parseFloat(parts[vertexPropertyIndex.blue]) / 255;
    }
  }

  // Faces: one line per face, `count v0 v1 v2 [v3 ...]`. We split fans of
  // quads/ngons into triangles so the geometry is always triangle-indexed.
  const triIndices = [];
  for (let i = 0; i < faceElement.count; i += 1) {
    const line = bodyLines[cursor++];
    if (!line) return null;
    const parts = line.split(/\s+/);
    const count = parseInt(parts[0], 10);
    if (count < 3) continue;
    const verts = [];
    for (let j = 0; j < count; j += 1) verts.push(parseInt(parts[1 + j], 10));
    for (let j = 1; j < count - 1; j += 1) {
      triIndices.push(verts[0], verts[j], verts[j + 1]);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (normals) geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(
    triIndices.length < 65535 ? new THREE.BufferAttribute(new Uint16Array(triIndices), 1)
      : new THREE.BufferAttribute(new Uint32Array(triIndices), 1),
  );
  if (!normals) geometry.computeVertexNormals();

  // Vertex colors were back-projected from captured RGB during Open3D TSDF
  // integration, so they already encode the captured lighting. Using
  // MeshBasicMaterial avoids double-lighting (scene lights would darken
  // surfaces that are already lit correctly in their RGB). When vertex
  // colors aren't present, fall back to a neutral base color.
  const material = new THREE.MeshBasicMaterial({
    vertexColors: !!colors,
    color: colors ? 0xffffff : 0xbbbbbb,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}

// --- Public API -----------------------------------------------------------

/**
 * Build scan-native object proxies for a scene.
 *
 * Returns a Promise<Map<object_id, { points: THREE.Points, stats: {...} }>>
 * Objects with insufficient coverage are absent from the map; the caller
 * should keep the OBB wireframe fallback for those.
 *
 * @param {Scene} scene
 * @param {{ voxelCellM?: number, minPointsPerObject?: number, maxPointsPerObject?: number, symmetryFill?: boolean }} [options]
 */
export async function buildScanProxies(scene, options = {}) {
  const voxelCellM = options.voxelCellM ?? DEFAULT_VOXEL_CELL_M;
  const minPoints = options.minPointsPerObject ?? DEFAULT_MIN_POINTS_PER_OBJECT;
  const maxPoints = options.maxPointsPerObject ?? DEFAULT_MAX_POINTS_PER_OBJECT;
  const symmetryFill = options.symmetryFill !== false;

  const frames = Array.isArray(scene.captured_frames) ? scene.captured_frames : [];
  if (frames.length === 0) {
    return new Map();
  }
  const objects = scene?.snapshot?.state?.room?.objects ?? [];
  if (objects.length === 0) {
    return new Map();
  }

  // 1–3: Fetch + unproject each frame in parallel. Each frame produces a
  // packed Float32Array [x, y, z, r, g, b, x, y, z, r, g, b, ...] of world
  // points. Do this once per scene, then clip per object.
  const perFrameWorldPoints = await Promise.all(
    frames.map(async (frame) => {
      try {
        return await unprojectFrameToWorld(frame);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[scan-proxies] frame unprojection failed', frame.frame_id, err);
        return null;
      }
    }),
  );

  // 4–5: Per object, clip + voxel-merge across frames.
  const result = new Map();
  for (const obj of objects) {
    if (!obj?.obb) continue;
    const obbFrame = buildOBBFrame(obj.obb);
    // Collect observed points by clipping each frame's world-points into the
    // OBB's local bounds. Merge into a voxel grid keyed on local coordinates
    // so dedup is OBB-aligned (better than world-aligned for non-axis-aligned
    // objects).
    const voxelGrid = new Map();
    for (const worldPoints of perFrameWorldPoints) {
      if (!worldPoints) continue;
      clipWorldPointsIntoVoxelGrid(worldPoints, obbFrame, voxelCellM, voxelGrid);
    }
    const observed = voxelGridToPointArray(voxelGrid);
    if (observed.positions.length / 3 < minPoints) continue;

    // 6: class-aware symmetry fill (only for symmetric classes).
    let finalPoints = observed;
    if (symmetryFill) {
      const axes = CLASS_SYMMETRY_AXES[obj.class] ?? [];
      if (axes.length > 0) {
        finalPoints = fillBySymmetry(observed, obbFrame, axes);
      }
    }

    // Cap point count to keep GPU memory / draw cost bounded.
    if (finalPoints.positions.length / 3 > maxPoints) {
      finalPoints = randomSubsample(finalPoints, maxPoints);
    }

    // 7: build three.js Points with the splat shader.
    const points = buildSplatPoints(finalPoints, obbFrame.diagonal);
    points.userData = {
      scan_proxy: true,
      object_id: obj.object_id,
      class: obj.class,
      observed_count: observed.positions.length / 3,
      total_count: finalPoints.positions.length / 3,
    };
    result.set(obj.object_id, {
      points,
      stats: points.userData,
    });
  }
  return result;
}

// --- Frame unprojection --------------------------------------------------

/**
 * Fetch a captured frame's depth + RGB, unproject each valid depth pixel to
 * world coordinates, colored from the RGB. Returns { positions, colors,
 * confidences } packed as Float32Arrays.
 */
async function unprojectFrameToWorld(frame) {
  const [depthMap, rgbSampler, confidenceMap] = await Promise.all([
    loadDepthNpy(frame.depth.uri),
    loadRGBAsSampler(frame.rgb.uri),
    frame.confidence ? loadConfidenceNpy(frame.confidence.uri).catch(() => null) : Promise.resolve(null),
  ]);

  const { data: depth, width: depthW, height: depthH } = depthMap;
  const intrinsics = frame.intrinsics;
  const scaleX = depthW / intrinsics.width;
  const scaleY = depthH / intrinsics.height;
  const fx = intrinsics.fx * scaleX;
  const fy = intrinsics.fy * scaleY;
  const cx = intrinsics.cx * scaleX;
  const cy = intrinsics.cy * scaleY;

  const T = frame.camera_transform;
  // Column-major 4x4: T = [c0.x c0.y c0.z c0.w c1.x c1.y c1.z c1.w ...]
  // Apply: world = T * (x_c, y_c, z_c, 1)
  //        world.x = T[0]*x + T[4]*y + T[8]*z + T[12]
  //        world.y = T[1]*x + T[5]*y + T[9]*z + T[13]
  //        world.z = T[2]*x + T[6]*y + T[10]*z + T[14]

  // First pass: count valid pixels.
  let valid = 0;
  for (let i = 0; i < depth.length; i += 1) {
    const d = depth[i];
    if (d > 0.05 && d < 8.0 && Number.isFinite(d)) valid += 1;
  }
  const positions = new Float32Array(valid * 3);
  const colors = new Float32Array(valid * 3);
  const confidences = confidenceMap ? new Float32Array(valid) : null;

  let writeIndex = 0;
  // Subsample stride: for a 192x256 depth map we get ~49k points per frame,
  // 6 frames ~= 300k. Stride 1 is fine for modern GPUs; bump to 2 if needed.
  for (let v = 0; v < depthH; v += 1) {
    for (let u = 0; u < depthW; u += 1) {
      const idx = v * depthW + u;
      const d = depth[idx];
      if (!(d > 0.05 && d < 8.0 && Number.isFinite(d))) continue;
      // ARKit camera: +X right, +Y up in image, -Z forward. Image pixel
      // coordinates: (0,0) top-left, u right, v down. Flip Y to bring the
      // image y-down convention to the camera y-up convention before lifting
      // to 3D (see docs/pose-conventions.md "Camera frame").
      const xC = (u - cx) * d / fx;
      const yC = -(v - cy) * d / fy;
      const zC = -d;
      const wx = T[0] * xC + T[4] * yC + T[8] * zC + T[12];
      const wy = T[1] * xC + T[5] * yC + T[9] * zC + T[13];
      const wz = T[2] * xC + T[6] * yC + T[10] * zC + T[14];
      positions[writeIndex * 3 + 0] = wx;
      positions[writeIndex * 3 + 1] = wy;
      positions[writeIndex * 3 + 2] = wz;
      const rgb = rgbSampler
        ? rgbSampler.sample(u / depthW, v / depthH)
        : [0.6, 0.6, 0.6];
      colors[writeIndex * 3 + 0] = rgb[0];
      colors[writeIndex * 3 + 1] = rgb[1];
      colors[writeIndex * 3 + 2] = rgb[2];
      if (confidences) {
        confidences[writeIndex] = confidenceMap.data[idx] / 2.0; // ARKit 0|1|2 → 0..1
      }
      writeIndex += 1;
    }
  }
  return { positions, colors, confidences };
}

// --- OBB clipping + voxel merge ------------------------------------------

function buildOBBFrame(obb) {
  // OBB in scene storage: center, size_x/y/z, yaw_degrees (rotation about +Z).
  // Build a rotation matrix that takes world → OBB-local, and the half-extents
  // for the clip test.
  const yaw = (obb.yaw_degrees || 0) * PI / 180;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // World → local: first translate by -center, then rotate by -yaw about Z.
  // The inverse yaw rotation matrix (world→local) is:
  //   [  c,  s, 0 ]
  //   [ -s,  c, 0 ]
  //   [  0,  0, 1 ]
  const center = obb.center || { x: 0, y: 0, z: 0 };
  const halfX = (obb.size_x || 0) / 2;
  const halfY = (obb.size_y || 0) / 2;
  const halfZ = (obb.size_z || 0) / 2;
  const diagonal = Math.hypot(halfX * 2, halfY * 2, halfZ * 2);
  return {
    center,
    halfX,
    halfY,
    halfZ,
    diagonal,
    cos: c,
    sin: s,
    worldToLocal(wx, wy, wz, out) {
      const dx = wx - center.x;
      const dy = wy - center.y;
      const dz = wz - center.z;
      out[0] = c * dx + s * dy;
      out[1] = -s * dx + c * dy;
      out[2] = dz;
    },
    localToWorld(lx, ly, lz, out) {
      // Inverse of worldToLocal: rotate by +yaw, then translate by +center.
      out[0] = c * lx - s * ly + center.x;
      out[1] = s * lx + c * ly + center.y;
      out[2] = lz + center.z;
    },
  };
}

function clipWorldPointsIntoVoxelGrid(worldPoints, obbFrame, cellM, voxelGrid) {
  const { positions, colors, confidences } = worldPoints;
  const { halfX, halfY, halfZ } = obbFrame;
  // Expand the OBB slightly so points grazing the boundary still contribute
  // — ARKit depth edges are noisy and we don't want to carve notches.
  const slackX = halfX + cellM;
  const slackY = halfY + cellM;
  const slackZ = halfZ + cellM;
  const local = [0, 0, 0];
  const pointCount = positions.length / 3;
  for (let i = 0; i < pointCount; i += 1) {
    const wx = positions[i * 3 + 0];
    const wy = positions[i * 3 + 1];
    const wz = positions[i * 3 + 2];
    obbFrame.worldToLocal(wx, wy, wz, local);
    if (Math.abs(local[0]) > slackX) continue;
    if (Math.abs(local[1]) > slackY) continue;
    if (Math.abs(local[2]) > slackZ) continue;
    const weight = confidences ? Math.max(0.1, confidences[i]) : 1.0;
    const cellX = Math.floor(local[0] / cellM);
    const cellY = Math.floor(local[1] / cellM);
    const cellZ = Math.floor(local[2] / cellM);
    const key = cellX + ',' + cellY + ',' + cellZ;
    let cell = voxelGrid.get(key);
    if (!cell) {
      cell = { wx: 0, wy: 0, wz: 0, r: 0, g: 0, b: 0, w: 0, lx: 0, ly: 0, lz: 0, inferred: 0 };
      voxelGrid.set(key, cell);
    }
    cell.wx += wx * weight;
    cell.wy += wy * weight;
    cell.wz += wz * weight;
    cell.r += colors[i * 3 + 0] * weight;
    cell.g += colors[i * 3 + 1] * weight;
    cell.b += colors[i * 3 + 2] * weight;
    cell.w += weight;
    cell.lx += local[0] * weight;
    cell.ly += local[1] * weight;
    cell.lz += local[2] * weight;
  }
}

function voxelGridToPointArray(voxelGrid) {
  const count = voxelGrid.size;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const localPositions = new Float32Array(count * 3);
  const inferred = new Float32Array(count);
  let i = 0;
  for (const cell of voxelGrid.values()) {
    const inv = 1.0 / cell.w;
    positions[i * 3 + 0] = cell.wx * inv;
    positions[i * 3 + 1] = cell.wy * inv;
    positions[i * 3 + 2] = cell.wz * inv;
    colors[i * 3 + 0] = cell.r * inv;
    colors[i * 3 + 1] = cell.g * inv;
    colors[i * 3 + 2] = cell.b * inv;
    localPositions[i * 3 + 0] = cell.lx * inv;
    localPositions[i * 3 + 1] = cell.ly * inv;
    localPositions[i * 3 + 2] = cell.lz * inv;
    inferred[i] = cell.inferred > 0 ? 1 : 0;
    i += 1;
  }
  return { positions, colors, localPositions, inferred };
}

// --- Symmetry fill -------------------------------------------------------

function fillBySymmetry(observed, obbFrame, axes) {
  const observedCount = observed.positions.length / 3;
  // Build a spatial hash of observed local positions so the "nearby point?"
  // test is O(1) per query.
  const hashCellM = SYMMETRY_FILL_EPSILON_M;
  const spatial = new Map();
  const localPos = observed.localPositions;
  const hashKey = (lx, ly, lz) =>
    Math.floor(lx / hashCellM) + ',' + Math.floor(ly / hashCellM) + ',' + Math.floor(lz / hashCellM);
  for (let i = 0; i < observedCount; i += 1) {
    const k = hashKey(localPos[i * 3], localPos[i * 3 + 1], localPos[i * 3 + 2]);
    const bucket = spatial.get(k) || [];
    bucket.push(i);
    spatial.set(k, bucket);
  }

  const extraPositions = [];
  const extraColors = [];
  const extraLocals = [];
  const extraInferred = [];
  const epsSq = SYMMETRY_FILL_EPSILON_M * SYMMETRY_FILL_EPSILON_M;

  const tryAddMirror = (lx, ly, lz, r, g, b) => {
    // Check neighborhood of 27 cells around the mirrored local position for
    // any already-observed point within epsilon.
    const baseCx = Math.floor(lx / hashCellM);
    const baseCy = Math.floor(ly / hashCellM);
    const baseCz = Math.floor(lz / hashCellM);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = spatial.get((baseCx + dx) + ',' + (baseCy + dy) + ',' + (baseCz + dz));
          if (!bucket) continue;
          for (const idx of bucket) {
            const dxp = localPos[idx * 3] - lx;
            const dyp = localPos[idx * 3 + 1] - ly;
            const dzp = localPos[idx * 3 + 2] - lz;
            if (dxp * dxp + dyp * dyp + dzp * dzp < epsSq) {
              return false; // observed neighbor exists — don't infer
            }
          }
        }
      }
    }
    // OK, add an inferred point here.
    const worldOut = [0, 0, 0];
    obbFrame.localToWorld(lx, ly, lz, worldOut);
    extraPositions.push(worldOut[0], worldOut[1], worldOut[2]);
    extraColors.push(r, g, b);
    extraLocals.push(lx, ly, lz);
    extraInferred.push(1);
    return true;
  };

  for (let i = 0; i < observedCount; i += 1) {
    const lx = localPos[i * 3];
    const ly = localPos[i * 3 + 1];
    const lz = localPos[i * 3 + 2];
    const r = observed.colors[i * 3];
    const g = observed.colors[i * 3 + 1];
    const b = observed.colors[i * 3 + 2];
    for (const axis of axes) {
      if (axis === 'x') tryAddMirror(-lx, ly, lz, r, g, b);
      if (axis === 'y') tryAddMirror(lx, -ly, lz, r, g, b);
      if (axis === 'z') tryAddMirror(lx, ly, -lz, r, g, b);
    }
  }

  if (extraPositions.length === 0) return observed;
  const totalCount = observedCount + extraPositions.length / 3;
  const positions = new Float32Array(totalCount * 3);
  const colors = new Float32Array(totalCount * 3);
  const locals = new Float32Array(totalCount * 3);
  const inferred = new Float32Array(totalCount);
  positions.set(observed.positions, 0);
  positions.set(extraPositions, observedCount * 3);
  colors.set(observed.colors, 0);
  colors.set(extraColors, observedCount * 3);
  locals.set(observed.localPositions, 0);
  locals.set(extraLocals, observedCount * 3);
  inferred.set(observed.inferred, 0);
  inferred.set(extraInferred, observedCount);
  return { positions, colors, localPositions: locals, inferred };
}

function randomSubsample(points, target) {
  const n = points.positions.length / 3;
  if (n <= target) return points;
  // Reservoir sample by shuffling indices in place (Fisher–Yates to `target`).
  const indices = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) indices[i] = i;
  for (let i = 0; i < target; i += 1) {
    const j = i + Math.floor(Math.random() * (n - i));
    const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
  }
  const positions = new Float32Array(target * 3);
  const colors = new Float32Array(target * 3);
  const locals = new Float32Array(target * 3);
  const inferred = new Float32Array(target);
  for (let i = 0; i < target; i += 1) {
    const src = indices[i];
    positions[i * 3 + 0] = points.positions[src * 3 + 0];
    positions[i * 3 + 1] = points.positions[src * 3 + 1];
    positions[i * 3 + 2] = points.positions[src * 3 + 2];
    colors[i * 3 + 0] = points.colors[src * 3 + 0];
    colors[i * 3 + 1] = points.colors[src * 3 + 1];
    colors[i * 3 + 2] = points.colors[src * 3 + 2];
    locals[i * 3 + 0] = points.localPositions[src * 3 + 0];
    locals[i * 3 + 1] = points.localPositions[src * 3 + 1];
    locals[i * 3 + 2] = points.localPositions[src * 3 + 2];
    inferred[i] = points.inferred[src];
  }
  return { positions, colors, localPositions: locals, inferred };
}

// --- three.js splat rendering --------------------------------------------

function buildSplatPoints(pointData, obbDiagonal) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pointData.positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(pointData.colors, 3));
  geometry.setAttribute('aInferred', new THREE.BufferAttribute(pointData.inferred, 1));

  // Splat size: each point represents a world-space disc. Size scales with
  // OBB diagonal so small objects (lamps) and big objects (bed) each read
  // as solid surfaces rather than a smattering of small dots. Larger radius
  // also helps the fallback-path look cohesive alongside Tier 2 meshes —
  // sparse clouds don't need to look like "missing data" when the user
  // expects a rendered surface.
  const worldRadiusM = Math.min(0.06, Math.max(0.025, obbDiagonal * 0.025));
  const uWorldRadiusPxPerM = worldRadiusM * 2 * 290;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uWorldRadiusPxPerM: { value: uWorldRadiusPxPerM },
      uPixelRatio: { value: typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 color;
      attribute float aInferred;
      varying vec3 vColor;
      varying float vInferred;
      uniform float uWorldRadiusPxPerM;
      uniform float uPixelRatio;
      void main() {
        vColor = color;
        vInferred = aInferred;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float z = max(0.1, -mvPosition.z);
        // Clamp so extremely close points don't blow up and extremely distant
        // ones still remain visible enough to hit-test visually.
        float sizePx = clamp(uWorldRadiusPxPerM / z, 3.0, 28.0) * uPixelRatio;
        gl_PointSize = sizePx;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      varying vec3 vColor;
      varying float vInferred;
      void main() {
        // Soft disc with gaussian falloff. Discard anything outside radius
        // 0.5 (the quad corners) so the splat is truly circular.
        vec2 uv = gl_PointCoord - vec2(0.5);
        float r = length(uv);
        if (r > 0.5) discard;
        // Alpha falloff: opaque at center, fades smoothly to 0 at the edge.
        float alpha = smoothstep(0.5, 0.22, r);
        // Inferred (symmetry-filled) points render slightly dimmer and more
        // transparent so viewers can tell observed from synthesized.
        float dim = mix(1.0, 0.72, vInferred);
        float aScale = mix(1.0, 0.65, vInferred);
        gl_FragColor = vec4(vColor * dim, alpha * aScale);
      }
    `,
    transparent: true,
    depthWrite: false,
    vertexColors: false,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

// --- Asset loaders -------------------------------------------------------

async function loadDepthNpy(uri) {
  const response = await fetch(uri);
  if (!response.ok) throw new Error('depth fetch failed: ' + uri);
  const buffer = await response.arrayBuffer();
  return parseNpyFloat32(buffer);
}

async function loadConfidenceNpy(uri) {
  const response = await fetch(uri);
  if (!response.ok) throw new Error('confidence fetch failed: ' + uri);
  const buffer = await response.arrayBuffer();
  return parseNpyUint8(buffer);
}

async function loadRGBAsSampler(uri) {
  if (!uri) return null;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', reject, { once: true });
    img.src = uri;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    width,
    height,
    sample(u, v) {
      // Nearest-neighbor sample; bilinear is overkill for our voxel-averaged output.
      const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
      const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
      const idx = (y * width + x) * 4;
      return [data[idx] / 255, data[idx + 1] / 255, data[idx + 2] / 255];
    },
  };
}

function parseNpyFloat32(buffer) {
  const header = parseNpyHeader(buffer);
  if (header.dtype !== '<f4') {
    throw new Error('unsupported npy dtype ' + header.dtype);
  }
  const data = new Float32Array(buffer, header.dataOffset, header.rows * header.cols);
  return { data, width: header.cols, height: header.rows };
}

function parseNpyUint8(buffer) {
  const header = parseNpyHeader(buffer);
  if (header.dtype !== '|u1') {
    throw new Error('unsupported confidence npy dtype ' + header.dtype);
  }
  const data = new Uint8Array(buffer, header.dataOffset, header.rows * header.cols);
  return { data, width: header.cols, height: header.rows };
}

function parseNpyHeader(buffer) {
  const view = new DataView(buffer);
  // Magic string "\x93NUMPY" followed by major/minor version (1.0 or 2.0).
  const magic = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];
  for (let i = 0; i < magic.length; i += 1) {
    if (view.getUint8(i) !== magic[i]) throw new Error('npy: bad magic');
  }
  const major = view.getUint8(6);
  let headerLenBytes;
  let headerStart;
  if (major === 1) {
    headerLenBytes = view.getUint16(8, true);
    headerStart = 10;
  } else if (major === 2) {
    headerLenBytes = view.getUint32(8, true);
    headerStart = 12;
  } else {
    throw new Error('npy: unsupported version ' + major);
  }
  const headerBytes = new Uint8Array(buffer, headerStart, headerLenBytes);
  const headerStr = new TextDecoder('ascii').decode(headerBytes);
  // Extract descr, shape via tiny regex (the header is a Python dict literal).
  const descrMatch = headerStr.match(/'descr':\s*'([^']+)'/);
  const shapeMatch = headerStr.match(/'shape':\s*\(([^)]+)\)/);
  const fortranMatch = headerStr.match(/'fortran_order':\s*(True|False)/);
  if (!descrMatch || !shapeMatch || !fortranMatch) {
    throw new Error('npy: malformed header');
  }
  if (fortranMatch[1] === 'True') {
    throw new Error('npy: fortran_order not supported');
  }
  const dtype = descrMatch[1];
  const shape = shapeMatch[1].split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  if (shape.length !== 2) {
    throw new Error('npy: expected 2D array, got shape ' + shape.join('x'));
  }
  return {
    dtype,
    rows: shape[0],
    cols: shape[1],
    dataOffset: headerStart + headerLenBytes,
  };
}
