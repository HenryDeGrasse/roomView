// RoomView 3D viewer — slice 1 (shell + openings + objects + camera).
// Renders from canonical `Scene.snapshot.state.room` so floorplan/synthetic
// ingestion (stretch.md Track 1 v1.2) inherits the viewer without changes.
// Coordinate frame preserved as canonical +z up so future USD/DXF export
// (stretch.md Track 3 v2) walks the graph without root-rotation to undo.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const LAYER_SHELL = 0;
const LAYER_OBJECTS = 1;
const LAYER_SPLAT = 2;
const LAYER_GIZMO = 3;

export function mountViewer(container) {
  return mountThreeView(container, {
    enabledLayers: [LAYER_SHELL, LAYER_OBJECTS],
    mountKind: 'viewer',
  });
}

// Scan pane view: shell-only, orbit/zoom; L2 will light up when splat lands.
// Reads canonical Scene.snapshot.state.room — independent three.js scene from
// the render-pane viewer but shares the canonical coordinate frame so a
// future stretch Track 2 v1.1 composite renderer can run in the same space.
export function mountScanView(container) {
  return mountThreeView(container, {
    enabledLayers: [LAYER_SHELL, LAYER_SPLAT],
    mountKind: 'scan',
  });
}

function mountThreeView(container, opts) {
  if (!container) throw new Error('mountThreeView: missing container element');
  const enabledLayers = opts?.enabledLayers ?? [LAYER_SHELL, LAYER_OBJECTS];
  const mountKind = opts?.mountKind ?? 'viewer';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.position.set(4, -3, 6);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
  camera.up.set(0, 0, 1);
  camera.position.set(6, -6, 4);
  // Start from layer 0 only (default) and enable exactly the configured layers.
  camera.layers.disableAll();
  for (const layer of enabledLayers) camera.layers.enable(layer);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  const initialWidth = container.clientWidth || 400;
  const initialHeight = container.clientHeight || 300;
  renderer.setSize(initialWidth, initialHeight, false);
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.5;
  controls.maxDistance = 50;

  const roomsRoot = new THREE.Group();
  roomsRoot.userData = { kind: 'rooms' };
  scene.add(roomsRoot);

  const resize = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width <= 0 || height <= 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  window.addEventListener('resize', resize);

  let rafHandle = 0;
  const tick = () => {
    controls.update();
    renderer.render(scene, camera);
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);

  let currentRoomId = null;
  let currentSelectionId = null;
  let onSelect = () => {};
  const selectionSavedStyle = new Map();

  // glTF loading infra. Boxes render immediately; glTFs swap in async.
  // Resolver is pluggable so the MVP stays in box-proxy mode until a real
  // asset library (stretch Track 3 v1 / data sourcing) lights up.
  const gltfLoader = new GLTFLoader();
  const gltfCache = new Map(); // resolvedUrl -> Promise<THREE.Group>
  let assetUriResolver = () => null;
  let setRoomVersion = 0;

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();

  canvas.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);
    raycaster.layers = camera.layers;
    const candidates = [];
    roomsRoot.traverse((child) => {
      if (!child.isMesh) return;
      // Only count objects/fixed-elements/walls as selectable — floor is skipped
      // so clicking an empty floor area deselects.
      const kind = child.userData?.kind;
      if (kind === 'object' || kind === 'fixed_element' || kind === 'wall') {
        candidates.push(child);
      }
    });
    const hits = raycaster.intersectObjects(candidates, false);
    const firstVisible = hits.find((hit) => camera.layers.test(hit.object.layers));
    if (firstVisible) {
      const id = firstVisible.object.userData?.canonical_id;
      if (id) {
        onSelect(id);
        return;
      }
    }
    onSelect(null);
  });

  function setSelection(id) {
    for (const [mesh, saved] of selectionSavedStyle) {
      if (mesh.material && mesh.material.emissive) {
        mesh.material.emissive.setHex(saved.emissiveHex);
        mesh.material.emissiveIntensity = saved.intensity;
      }
    }
    selectionSavedStyle.clear();
    currentSelectionId = id || null;
    if (!currentSelectionId) return;
    roomsRoot.traverse((obj) => {
      if (!obj.isMesh) return;
      if (obj.userData?.canonical_id !== currentSelectionId) return;
      const mat = obj.material;
      if (!mat || !mat.emissive) return;
      selectionSavedStyle.set(obj, {
        emissiveHex: mat.emissive.getHex(),
        intensity: mat.emissiveIntensity ?? 1,
      });
      mat.emissive.setHex(0xfbbf24);
      mat.emissiveIntensity = 0.55;
    });
  }

  function setOnSelect(fn) {
    onSelect = typeof fn === 'function' ? fn : () => {};
  }

  function setAssetUriResolver(fn) {
    assetUriResolver = typeof fn === 'function' ? fn : () => null;
  }

  function setRoom(room, options) {
    if (!room) return;
    setRoomVersion += 1;
    const versionToken = setRoomVersion;
    disposeRoomsRoot();
    const assetRefsByObjectId = new Map();
    const rawAssetRefs = options?.editing_asset_refs;
    if (Array.isArray(rawAssetRefs)) {
      for (const ref of rawAssetRefs) {
        if (ref && typeof ref.bound_to === 'string') {
          assetRefsByObjectId.set(ref.bound_to, ref);
        }
      }
    }
    const ctx = {
      assetRefsByObjectId,
      gltfCache,
      gltfLoader,
      resolveAssetUri: assetUriResolver,
      versionToken,
      getVersion: () => setRoomVersion,
    };
    const roomGroup = buildRoomGroup(room, ctx);
    roomsRoot.add(roomGroup);
    if (room.room_id !== currentRoomId) {
      fitCameraToRoom(camera, controls, room);
      currentRoomId = room.room_id;
    }
    if (currentSelectionId) setSelection(currentSelectionId);
  }

  function disposeRoomsRoot() {
    selectionSavedStyle.clear();
    for (const child of [...roomsRoot.children]) {
      disposeTree(child);
      roomsRoot.remove(child);
    }
  }

  function dispose() {
    cancelAnimationFrame(rafHandle);
    resizeObserver.disconnect();
    window.removeEventListener('resize', resize);
    disposeRoomsRoot();
    renderer.dispose();
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  function captureConditioning() {
    // Render color (current scene state).
    renderer.render(scene, camera);
    const colorDataUrl = renderer.domElement.toDataURL('image/png');

    // Render depth via an override material. MeshDepthMaterial packs depth into
    // RGBA which is fine for conditioning; the real provider re-extracts it.
    const savedOverride = scene.overrideMaterial;
    const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking });
    scene.overrideMaterial = depthMat;
    renderer.render(scene, camera);
    const depthDataUrl = renderer.domElement.toDataURL('image/png');
    scene.overrideMaterial = savedOverride;
    depthMat.dispose();

    // Restore live color so the rAF loop resumes without a flash.
    renderer.render(scene, camera);

    return {
      color: stripDataUrlPrefix(colorDataUrl),
      depth: stripDataUrlPrefix(depthDataUrl),
      // Edge is intentionally null in slice 1 of Phase 0 Slice D. Real providers
      // typically generate their own Canny from the color buffer; when we wire
      // a real provider, add a Sobel pass here or rely on the server to compute.
      edge: null,
      width: renderer.domElement.width,
      height: renderer.domElement.height,
    };
  }

  const api = { setRoom, setSelection, setOnSelect, setAssetUriResolver, captureConditioning, dispose };
  // Dev/demo hook: lets the browser console (and later E2E harnesses) inspect
  // the scene graph, camera, and controls without re-plumbing through the UI.
  if (typeof window !== 'undefined') {
    window.__roomviewDebug = window.__roomviewDebug || {};
    window.__roomviewDebug[mountKind] = { api, scene, camera, controls, roomsRoot, THREE };
  }
  return api;
}

function buildRoomGroup(room, ctx) {
  const group = new THREE.Group();
  group.userData = { kind: 'room', canonical_id: room.room_id };

  const shell = new THREE.Group();
  shell.userData = { kind: 'shell' };
  buildFloor(room, shell);
  buildWalls(room, shell);
  buildFixedElements(room, shell, ctx);
  setLayerDeep(shell, LAYER_SHELL);
  group.add(shell);

  const objects = new THREE.Group();
  objects.userData = { kind: 'objects' };
  buildObjects(room, objects, ctx);
  setLayerDeep(objects, LAYER_OBJECTS);
  group.add(objects);

  const splatLayer = new THREE.Group();
  splatLayer.userData = { kind: 'splat' };
  setLayerDeep(splatLayer, LAYER_SPLAT);
  group.add(splatLayer);

  const gizmoLayer = new THREE.Group();
  gizmoLayer.userData = { kind: 'gizmos' };
  setLayerDeep(gizmoLayer, LAYER_GIZMO);
  group.add(gizmoLayer);

  return group;
}

function buildFloor(room, parent) {
  const floorSurface = room.shell.surfaces.find((s) => s.type === 'floor');
  const polygon = room.shell.floor_polygon.vertices;
  if (!polygon || polygon.length < 3) return;
  const points = polygon.map((v) => new THREE.Vector2(v.x, v.y));
  if (shoelaceSignedArea(points) < 0) points.reverse();
  const shape = new THREE.Shape(points);
  const geom = new THREE.ShapeGeometry(shape);
  const color = materialColor(floorSurface?.material_state, 0x6b5a3e);
  const mat = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.92 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData = { canonical_id: floorSurface?.surface_id, kind: 'floor' };
  parent.add(mesh);
}

function buildWalls(room, parent) {
  const walls = room.shell.surfaces.filter((s) => s.type === 'wall');
  const openingsBySurface = groupOpeningsBySurface(room.shell.openings);
  for (const wall of walls) {
    if (!wall.surface_frame || !wall.boundary) continue;
    const boundary = wall.boundary.vertices.map((v) => new THREE.Vector2(v.x, v.y));
    if (boundary.length < 3) continue;
    if (shoelaceSignedArea(boundary) < 0) boundary.reverse();
    const shape = new THREE.Shape(boundary);

    const openings = openingsBySurface.get(wall.surface_id) ?? [];
    for (const opening of openings) {
      const { min_u, min_v, width, height } = opening.rect;
      if (width <= 0 || height <= 0) continue;
      const path = new THREE.Path();
      path.moveTo(min_u, min_v);
      path.lineTo(min_u + width, min_v);
      path.lineTo(min_u + width, min_v + height);
      path.lineTo(min_u, min_v + height);
      path.closePath();
      shape.holes.push(path);
    }

    const geom = new THREE.ShapeGeometry(shape);
    const color = materialColor(wall.material_state, 0xd8d2c0);
    const mat = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.85 });
    const mesh = new THREE.Mesh(geom, mat);

    const { origin, u_axis, v_axis, normal } = wall.surface_frame;
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(u_axis.x, u_axis.y, u_axis.z),
      new THREE.Vector3(v_axis.x, v_axis.y, v_axis.z),
      new THREE.Vector3(normal.x, normal.y, normal.z),
    );
    basis.setPosition(origin.x, origin.y, origin.z);
    mesh.applyMatrix4(basis);

    mesh.userData = { canonical_id: wall.surface_id, kind: 'wall' };
    parent.add(mesh);
  }
}

function buildFixedElements(room, parent, ctx) {
  const elements = room.shell.fixed_elements ?? [];
  for (const element of elements) {
    const mesh = makeOBBMesh(element.obb, 0x808a94, 0.78);
    if (!mesh) continue;
    mesh.userData = {
      canonical_id: element.fixed_element_id,
      kind: 'fixed_element',
      class: element.class,
    };
    parent.add(mesh);
    tryAttachGLTF(parent, mesh, element.obb, element.fixed_element_id, ctx, 'fixed_element');
  }
}

function buildObjects(room, parent, ctx) {
  for (const object of room.objects) {
    const color = objectColor(object);
    const mesh = makeOBBMesh(object.obb, color, 0.7);
    if (!mesh) continue;
    mesh.userData = {
      canonical_id: object.object_id,
      kind: 'object',
      class: object.class,
    };
    parent.add(mesh);
    tryAttachGLTF(parent, mesh, object.obb, object.object_id, ctx, 'object', object.class);
  }
}

function tryAttachGLTF(parentGroup, proxyMesh, obb, canonicalId, ctx, kind, className) {
  if (!ctx || !ctx.assetRefsByObjectId) return;
  const ref = ctx.assetRefsByObjectId.get(canonicalId);
  if (!ref || ref.kind !== 'gltf' || typeof ref.uri !== 'string') return;
  const resolved = ctx.resolveAssetUri ? ctx.resolveAssetUri(ref.uri) : null;
  if (!resolved || typeof resolved !== 'string') return;
  const versionAtRequest = ctx.versionToken;
  const cached = ctx.gltfCache.get(resolved);
  const promise = cached || new Promise((resolve, reject) => {
    ctx.gltfLoader.load(resolved, (gltf) => resolve(gltf.scene), undefined, reject);
  });
  if (!cached) ctx.gltfCache.set(resolved, promise);
  promise.then((sourceScene) => {
    if (ctx.getVersion() !== versionAtRequest) return;
    if (!proxyMesh.parent || proxyMesh.parent !== parentGroup) return;
    const container = new THREE.Group();
    const clone = sourceScene.clone(true);
    container.add(clone);
    // Fit clone to OBB — compute its axis-aligned bounds in local space, then
    // uniformly scale so it fits within OBB without distortion.
    const bbox = new THREE.Box3().setFromObject(clone);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    if (size.x > 0 && size.y > 0 && size.z > 0) {
      const scale = Math.min(
        obb.size_x / size.x,
        obb.size_y / size.y,
        obb.size_z / size.z,
      );
      clone.scale.setScalar(scale);
      const center = new THREE.Vector3();
      bbox.getCenter(center);
      clone.position.sub(center.multiplyScalar(scale));
    }
    container.position.set(obb.center.x, obb.center.y, obb.center.z);
    container.rotation.z = (obb.yaw_degrees || 0) * Math.PI / 180;
    container.userData = { canonical_id: canonicalId, kind, class: className, asset_backed: true };
    parentGroup.add(container);
    parentGroup.remove(proxyMesh);
    disposeTree(proxyMesh);
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('glTF load failed for', resolved, err);
    // Box proxy stays in place.
  });
}

function makeOBBMesh(obb, color, roughness) {
  if (!obb) return null;
  const sx = Math.max(0.02, obb.size_x || 0);
  const sy = Math.max(0.02, obb.size_y || 0);
  const sz = Math.max(0.02, obb.size_z || 0);
  const geom = new THREE.BoxGeometry(sx, sy, sz);
  const mat = new THREE.MeshStandardMaterial({ color, roughness });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(obb.center.x, obb.center.y, obb.center.z);
  mesh.rotation.z = (obb.yaw_degrees || 0) * Math.PI / 180;
  return mesh;
}

function groupOpeningsBySurface(openings) {
  const map = new Map();
  for (const opening of openings ?? []) {
    if (!opening.host_surface_id) continue;
    if (!map.has(opening.host_surface_id)) map.set(opening.host_surface_id, []);
    map.get(opening.host_surface_id).push(opening);
  }
  return map;
}

function shoelaceSignedArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += (b.x - a.x) * (b.y + a.y);
  }
  return sum;
}

function stripDataUrlPrefix(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

function fitCameraToRoom(camera, controls, room) {
  const verts = room.shell.floor_polygon.vertices;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of verts) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const ceiling = room.shell.ceiling_height || 2.6;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const diag = Math.hypot(maxX - minX, maxY - minY);
  camera.position.set(cx + diag * 0.4, cy - diag * 1.1, ceiling + diag * 1.0);
  controls.target.set(cx, cy, ceiling * 0.15);
  controls.update();
}

function setLayerDeep(obj, layer) {
  obj.layers.set(layer);
  obj.traverse((child) => child.layers.set(layer));
}

function disposeTree(obj) {
  obj.traverse((node) => {
    if (node.geometry) node.geometry.dispose();
    if (node.material) {
      if (Array.isArray(node.material)) {
        for (const m of node.material) m.dispose();
      } else {
        node.material.dispose();
      }
    }
  });
}

const NAMED_COLORS = {
  oak: 0xb08d57,
  walnut: 0x5d432c,
  cherry: 0x8b3a3a,
  maple: 0xd4a66a,
  pine: 0xd8b98a,
  soft_white: 0xf2efe8,
  warm_white: 0xf3ead5,
  off_white: 0xeeeae0,
  cream: 0xece6d4,
  slate: 0x4a5568,
  charcoal: 0x2d3139,
  sand: 0xc7ae86,
  sage: 0x9aa98a,
  navy: 0x1f2a44,
  linen: 0xe7dfcd,
  terracotta: 0xb56c4f,
  beige: 0xc8b99c,
  white: 0xf3f3f1,
  gray: 0x8a8a8a,
  grey: 0x8a8a8a,
  black: 0x1a1a1a,
};

function materialColor(materialState, fallback) {
  if (!materialState?.color) return fallback;
  const key = String(materialState.color).toLowerCase();
  return NAMED_COLORS[key] ?? fallback;
}

const CLASS_PALETTE = {
  bed: 0x8c6f53,
  nightstand: 0x9e8a6a,
  desk: 0x6b6f8c,
  chair: 0x5c7a8c,
  table: 0x7f6b52,
  dresser: 0x6b5b47,
  bookshelf: 0x7a6648,
  sofa: 0x8c5f5c,
  rug: 0xa07c5a,
  lamp: 0xd4c28a,
  television: 0x1f2937,
  storage: 0x706547,
  generic_obstacle: 0x6e6e6e,
};

function objectColor(object) {
  const named = object.material_state?.color
    ? NAMED_COLORS[String(object.material_state.color).toLowerCase()]
    : undefined;
  if (named !== undefined) return named;
  return CLASS_PALETTE[object.class] ?? 0x7f7f7f;
}
