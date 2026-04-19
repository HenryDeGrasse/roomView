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
    appearanceMode: 'editable',
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
    appearanceMode: 'capture',
    mountKind: 'scan',
  });
}

function mountThreeView(container, opts) {
  if (!container) throw new Error('mountThreeView: missing container element');
  const enabledLayers = opts?.enabledLayers ?? [LAYER_SHELL, LAYER_OBJECTS];
  const appearanceMode = opts?.appearanceMode ?? 'editable';
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

  // Scan-native object proxies. The scan pane enables LAYER_SPLAT; dropping
  // THREE.Points under this root at that layer makes the point clouds the
  // primary visible content in the scan pane (shell stays too, at LAYER_SHELL).
  const scanProxiesRoot = new THREE.Group();
  scanProxiesRoot.userData = { kind: 'scan_proxies' };
  scanProxiesRoot.layers.set(LAYER_SPLAT);
  scene.add(scanProxiesRoot);

  // Per-object OBB wireframes — drawn on top of the scan content so every
  // object (including the ones with no mesh/splat coverage) has a visible
  // presence and selection has something to highlight. Populated by
  // setObjectOutlines; cleared by the same call with null.
  const scanObjectOutlines = new THREE.Group();
  scanObjectOutlines.name = 'scan_object_outlines_root';
  scanObjectOutlines.renderOrder = 5;
  scanObjectOutlines.layers.set(LAYER_SPLAT);
  scene.add(scanObjectOutlines);

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

  // Dollhouse mode — when the camera moves OUTSIDE the room polygon,
  // hide the splat + mesh content so the shell reads as a clean box
  // from every exterior angle. The same FrontSide culling that makes
  // walls see-through from outside doesn't affect gaussian splats
  // (they're view-aligned sprites), so we gate them on a polygon
  // inside-test every tick.
  let dollhouseState = { inside: true, splatViewerGetter: null }; // start inside so splats show until we know otherwise
  const tick = () => {
    controls.update();
    if (mountKind === 'scan') {
      updateDollhouseVisibility(camera, roomsRoot, scanProxiesRoot, dollhouseState);
    }
    renderer.render(scene, camera);
    rafHandle = requestAnimationFrame(tick);
  };
  let rafHandle = 0;
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

  // Showcase Track B — Gaussian Splatting loader (scaffold).
  //
  // When a SplatAssetRecord transitions to `status: "ready"` and carries a
  // resolvable URI, the scan pane calls `setSplat({ uri, gaussian_count })`.
  // A real splat renderer gets dropped in below the `splatLoader` hook —
  // candidates: @mkkellogg/gaussian-splats-3d, gsplat.js, or a vendored
  // minimal renderer. Until the renderer is wired, we still surface the
  // splat metadata for debugging and emit a console note so the scan pane
  // UX can decorate itself ("Splat ready · 304k gaussians · renderer pending").
  //
  // setSplat is idempotent per URI — repeated calls with the same uri skip
  // reload. Passing null disposes any active splat. Graceful fallback: the
  // RoomPlan shell at LAYER_SHELL stays visible whether or not splats render,
  // so this scaffold never degrades the editor.
  let currentSplatUri = null;
  const splatMeta = { uri: null, gaussian_count: null, status: 'absent' };
  let splatLoader = null; // Week 4 follow-up: drop in gsplat.js or similar.
  // Optional accessor for the live DropInViewer — splat-loader.js wires
  // this up via setSplatViewerGetter so the dollhouse visibility toggle
  // can .visible it without chasing scene children every tick.
  let splatViewerGetter = null;

  function setSplatLoader(fn) {
    splatLoader = typeof fn === 'function' ? fn : null;
  }

  function setSplatViewerGetter(fn) {
    splatViewerGetter = typeof fn === 'function' ? fn : null;
    dollhouseState.splatViewerGetter = splatViewerGetter;
  }

  async function setSplat(descriptor) {
    if (!descriptor || !descriptor.uri) {
      splatMeta.uri = null;
      splatMeta.gaussian_count = null;
      splatMeta.status = 'absent';
      currentSplatUri = null;
      return { status: 'absent' };
    }
    if (currentSplatUri === descriptor.uri) {
      return { status: splatMeta.status };
    }
    currentSplatUri = descriptor.uri;
    splatMeta.uri = descriptor.uri;
    splatMeta.gaussian_count = typeof descriptor.gaussian_count === 'number'
      ? descriptor.gaussian_count
      : null;
    if (typeof splatLoader !== 'function') {
      splatMeta.status = 'metadata_only';
      return { status: 'metadata_only' };
    }
    try {
      const result = await splatLoader({ uri: descriptor.uri, scene, camera, layer: LAYER_SPLAT, THREE });
      splatMeta.status = result?.status ?? 'ready';
      return { status: splatMeta.status };
    } catch (err) {
      console.error('splat loader failed', err);
      splatMeta.status = 'failed';
      return { status: 'failed', error: err };
    }
  }

  function getSplatMeta() {
    return { ...splatMeta };
  }

  // Scan proxies — scan-native per-object content, produced by
  // apps/web/src/scan-proxies.js from captured_frames. Each map entry may be
  //   { points: THREE.Points }       (Tier 1: raw / symmetry-filled splat cloud)
  //   { mesh: THREE.Mesh }            (Tier 2: TSDF / Poisson reconstructed mesh)
  //   { object3d: THREE.Object3D }    (generic escape hatch)
  // Idempotent — calling with a new map disposes the previous attachments.
  // Passing null clears. After adding children, re-frames the camera to the
  // proxy bounds so the default scan-pane view lands on the actual scan
  // content rather than an empty shell interior.
  function setScanProxies(proxiesMap) {
    disposeScanProxies();
    if (!proxiesMap || typeof proxiesMap.forEach !== 'function') return;
    let added = 0;
    proxiesMap.forEach((entry) => {
      const child = entry?.mesh || entry?.points || entry?.object3d;
      if (!child) return;
      child.traverse((node) => node.layers.set(LAYER_SPLAT));
      scanProxiesRoot.add(child);
      added += 1;
    });
    if (added > 0) {
      fitCameraToScanProxies();
    }
  }

  function fitCameraToScanProxies() {
    if (scanProxiesRoot.children.length === 0) return;
    const bbox = new THREE.Box3();
    for (const child of scanProxiesRoot.children) {
      if (typeof child.geometry?.computeBoundingBox === 'function') {
        child.geometry.computeBoundingBox();
      }
      const childBox = new THREE.Box3().setFromObject(child);
      if (Number.isFinite(childBox.min.x) && Number.isFinite(childBox.max.x)) {
        bbox.union(childBox);
      }
    }
    if (bbox.isEmpty()) return;
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    bbox.getCenter(center);
    bbox.getSize(size);
    const radius = Math.max(size.x, size.y, size.z) || 1;
    // 45° FOV perspective: camera at ~2.4× radius frames with a bit of margin.
    const distance = Math.max(2.5, radius * 2.4);
    // Offset along +X,-Y,+Z so we get a 3/4 overhead angle that reads both
    // footprint and height.
    camera.position.set(
      center.x - distance * 0.6,
      center.y - distance * 0.9,
      center.z + distance * 0.75,
    );
    controls.target.copy(center);
    controls.update();
  }

  /**
   * Attach per-object OBB wireframes. `outlineGroup` is a THREE.Group whose
   * children carry userData.scan_obb + userData.object_id (produced by
   * scan-proxies.js buildObjectOutlines). Pass null to clear.
   */
  function setObjectOutlines(outlineGroup) {
    for (const prev of [...scanObjectOutlines.children]) {
      scanObjectOutlines.remove(prev);
      prev.traverse((n) => {
        if (n.geometry?.dispose) n.geometry.dispose();
        if (n.material?.dispose) n.material.dispose();
      });
    }
    if (!outlineGroup) return;
    outlineGroup.traverse((node) => node.layers.set(LAYER_SPLAT));
    scanObjectOutlines.add(outlineGroup);
  }

  /**
   * Highlight the selected object's OBB wireframe. Scoped to the scan pane
   * — the layout pane / main viewer have their own selection visuals.
   */
  function setScanSelection(objectId) {
    for (const outlineGroup of scanObjectOutlines.children) {
      for (const child of outlineGroup.children ?? []) {
        if (!child.userData?.scan_obb) continue;
        const isSelected = !!objectId && child.userData.object_id === objectId;
        if (child.material) {
          // Unselected: 0.35 opacity so the scene isn't cluttered, but
          // still visible. Selected: full opacity + tint pop.
          child.material.opacity = isSelected ? 1.0 : (objectId ? 0.22 : 0.55);
          child.material.needsUpdate = true;
        }
      }
    }
  }

  function disposeScanProxies() {
    for (const child of [...scanProxiesRoot.children]) {
      scanProxiesRoot.remove(child);
      if (child.geometry && typeof child.geometry.dispose === 'function') {
        child.geometry.dispose();
      }
      if (child.material && typeof child.material.dispose === 'function') {
        child.material.dispose();
      }
    }
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
      appearanceMode,
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
    disposeScanProxies();
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

  function getCurrentCameraView() {
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    const yawDegrees = Math.atan2(direction.y, direction.x) * 180 / Math.PI;
    return {
      camera_pose: {
        position: {
          x: roundCoord(camera.position.x),
          y: roundCoord(camera.position.y),
          z: roundCoord(camera.position.z),
        },
        yaw_degrees: roundCoord(yawDegrees),
      },
      fov: roundCoord(camera.fov),
      target: {
        x: roundCoord(controls.target.x),
        y: roundCoord(controls.target.y),
        z: roundCoord(controls.target.z),
      },
    };
  }

  // Showcase Track C — cinematic camera navigation.
  //
  // flyToPose animates the camera from its current position/orientation to a
  // target Pose3D (the same shape stored on CameraBookmark and CapturedFrame).
  // ease-in-out cubic over `duration_ms` so bookmark flights feel cinematic
  // rather than teleport-snappy. Any in-flight flight is cancelled when a new
  // one starts. Respects prefers-reduced-motion by clamping the duration to
  // zero (instant snap).
  //
  // Pose3D yaw_degrees is measured as atan2(look_dir.y, look_dir.x), matching
  // the projection used by getCurrentCameraView above. We translate the yaw
  // back into a forward vector on the horizontal plane and synthesize a
  // controls.target ~2.5m ahead so OrbitControls stays well-behaved after
  // the flight finishes.
  let currentFlightToken = 0;
  const prefersReducedMotion = typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function targetFromPose(pose) {
    const yawRadians = ((pose?.yaw_degrees ?? 0) * Math.PI) / 180;
    const forwardDistance = 2.5;
    const px = pose?.position?.x ?? 0;
    const py = pose?.position?.y ?? 0;
    const pz = pose?.position?.z ?? 0;
    return new THREE.Vector3(
      px + Math.cos(yawRadians) * forwardDistance,
      py + Math.sin(yawRadians) * forwardDistance,
      pz,
    );
  }

  function flyToPose(pose, options) {
    const durationMs = prefersReducedMotion
      ? 0
      : Math.max(0, options?.duration_ms ?? 900);
    const targetFov = typeof options?.fov === 'number' && Number.isFinite(options.fov) ? options.fov : null;
    const endPosition = new THREE.Vector3(
      pose?.position?.x ?? camera.position.x,
      pose?.position?.y ?? camera.position.y,
      pose?.position?.z ?? camera.position.z,
    );
    const endTarget = targetFromPose(pose);

    const token = ++currentFlightToken;
    if (durationMs === 0) {
      camera.position.copy(endPosition);
      controls.target.copy(endTarget);
      if (targetFov !== null) {
        camera.fov = targetFov;
        camera.updateProjectionMatrix();
      }
      controls.update();
      return Promise.resolve({ cancelled: false });
    }

    const startPosition = camera.position.clone();
    const startTarget = controls.target.clone();
    const startFov = camera.fov;
    const startedAt = performance.now();

    return new Promise((resolve) => {
      const step = (now) => {
        if (token !== currentFlightToken) {
          resolve({ cancelled: true });
          return;
        }
        const elapsed = now - startedAt;
        const raw = Math.min(1, elapsed / durationMs);
        const t = easeInOutCubic(raw);
        camera.position.lerpVectors(startPosition, endPosition, t);
        controls.target.lerpVectors(startTarget, endTarget, t);
        if (targetFov !== null) {
          camera.fov = startFov + (targetFov - startFov) * t;
          camera.updateProjectionMatrix();
        }
        controls.update();
        if (raw < 1) {
          requestAnimationFrame(step);
        } else {
          resolve({ cancelled: false });
        }
      };
      requestAnimationFrame(step);
    });
  }

  // Chains flyToPose across a sequence of poses with a dwell between each.
  // Resolves when the last pose completes, or early-resolves if another
  // flight interrupts it.
  async function flyThroughPoses(poses, options) {
    if (!Array.isArray(poses) || poses.length === 0) {
      return { cancelled: false, visited: 0 };
    }
    const dwellMs = Math.max(0, options?.dwell_ms ?? 500);
    const durationMs = Math.max(0, options?.duration_ms ?? 900);
    let visited = 0;
    for (const pose of poses) {
      const result = await flyToPose(pose, { duration_ms: durationMs });
      if (result?.cancelled) {
        return { cancelled: true, visited };
      }
      visited += 1;
      if (dwellMs > 0) {
        const waitToken = currentFlightToken;
        await new Promise((resolve) => setTimeout(resolve, dwellMs));
        if (waitToken !== currentFlightToken) {
          return { cancelled: true, visited };
        }
      }
    }
    return { cancelled: false, visited };
  }

  const api = {
    setRoom,
    setSelection,
    setOnSelect,
    setAssetUriResolver,
    setSplat,
    setSplatLoader,
    setSplatViewerGetter,
    getSplatMeta,
    setScanProxies,
    setObjectOutlines,
    setScanSelection,
    captureConditioning,
    getCurrentCameraView,
    flyToPose,
    flyThroughPoses,
    dispose,
  };
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
  // Stash the room payload so tick-time helpers (e.g. the dollhouse
  // visibility toggle) can read floor_polygon + ceiling_height without
  // threading state through the mount closure.
  group.userData = { kind: 'room', canonical_id: room.room_id, roomData: room };

  const shell = new THREE.Group();
  shell.userData = { kind: 'shell' };
  buildFloor(room, shell, ctx);
  buildWalls(room, shell, ctx);
  buildFixedElements(room, shell, ctx);
  // Scan pane only: solid inward-facing planes on every shell surface.
  // Fills in the walls/floor/ceiling that the splat never covered (e.g.
  // the 3 of 6 walls the ARKitScenes clip never imaged), while still
  // letting outside orbits see straight through via FrontSide culling.
  if (ctx?.appearanceMode === 'capture') {
    buildCaptureInpaintShell(room, shell);
  }
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

function buildFloor(room, parent, ctx) {
  const floorSurface = room.shell.surfaces.find((s) => s.type === 'floor');
  const polygon = room.shell.floor_polygon.vertices;
  if (!polygon || polygon.length < 3) return;
  const points = polygon.map((v) => new THREE.Vector2(v.x, v.y));
  if (shoelaceSignedArea(points) < 0) points.reverse();
  const shape = new THREE.Shape(points);
  const geom = new THREE.ShapeGeometry(shape);
  const isCapture = ctx?.appearanceMode === 'capture';
  const color = isCapture
    ? CAPTURE_SHELL_COLORS.floor
    : materialColor(floorSurface?.material_state, 0x6b5a3e);
  const mat = new THREE.MeshStandardMaterial({
    color,
    side: THREE.DoubleSide,
    roughness: 0.92,
    transparent: isCapture,
    opacity: isCapture ? 0.35 : 1.0,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData = { canonical_id: floorSurface?.surface_id, kind: 'floor' };
  parent.add(mesh);
}

function buildWalls(room, parent, ctx) {
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
    const color = ctx?.appearanceMode === 'capture'
      ? CAPTURE_SHELL_COLORS.wall
      : materialColor(wall.material_state, 0xd8d2c0);
    // In the scan pane the walls are spatial *context*, not a surface to
    // render. Solid walls box in the camera and hide the scan-native
    // proxies behind them. Draw just the wall outline (LineSegments from
    // the shape edges) so the room footprint reads, but the meshes and
    // point clouds stay unobstructed.
    const isCapture = ctx?.appearanceMode === 'capture';
    let mesh;
    if (isCapture) {
      const edges = new THREE.EdgesGeometry(geom);
      const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 });
      mesh = new THREE.LineSegments(edges, lineMat);
    } else {
      const mat = new THREE.MeshStandardMaterial({ color, side: THREE.FrontSide, roughness: 0.85 });
      mesh = new THREE.Mesh(geom, mat);
    }

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

/**
 * Toggle scan-pane splat + mesh content visibility based on whether
 * the camera is inside the room polygon. FrontSide culling hides the
 * inpaint walls from outside orbits, but gaussian splats render from
 * every angle — so we hide them explicitly when the camera is outside
 * the shell. The result is a clean dollhouse from exterior angles, and
 * full-content view from interior angles.
 *
 * Uses the ray-crossings point-in-polygon test against floor_polygon
 * vertices (handles the rotated rectangle produced by scan-to-shell.py
 * as well as any non-rectangular shape). Adds a 30cm horizontal margin
 * + a small Z band around the room so edge orbits aren't twitchy.
 */
function updateDollhouseVisibility(camera, roomsRoot, scanProxiesRoot, state) {
  // Find the first room's floor polygon and ceiling height.
  let shell = null;
  roomsRoot.traverse((node) => {
    if (shell) return;
    const room = node.userData?.roomData;
    if (room && room.shell) shell = room.shell;
  });
  if (!shell) return;
  const polygon = shell.floor_polygon?.vertices;
  if (!polygon || polygon.length < 3) return;
  const margin = 0.3;
  const ceilH = Number(shell.ceiling_height) || 2.4;
  const cx = camera.position.x;
  const cy = camera.position.y;
  const cz = camera.position.z;
  const insideZ = cz > -margin && cz < ceilH + margin;
  const insideXY = insideZ && pointInPolygonWithMargin(cx, cy, polygon, margin);
  if (insideXY !== state.inside) {
    state.inside = insideXY;
    // Toggle the .visible on the splat viewer (if installed) and on
    // the scan-native proxies root. We set .visible directly instead
    // of relying on camera.layers because the mkkellogg gaussian-splat
    // library renders through its own internal draw pass and doesn't
    // always honour the outer camera's layer mask.
    if (state.splatViewerGetter) {
      const viewer = state.splatViewerGetter();
      if (viewer) viewer.visible = insideXY;
    }
    if (scanProxiesRoot) scanProxiesRoot.visible = insideXY;
  }
}

function pointInPolygonWithMargin(px, py, vertices, margin) {
  // Expand polygon by `margin` along each edge's inward normal. Rather
  // than computing a Minkowski sum exactly, approximate by inflating
  // the point-in-polygon test: a point is "inside with margin" if it's
  // inside OR within `margin` of any edge.
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].x, yi = vertices[i].y;
    const xj = vertices[j].x, yj = vertices[j].y;
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  if (inside) return true;
  // Distance-to-edge fallback for the margin band.
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].x, yi = vertices[i].y;
    const xj = vertices[j].x, yj = vertices[j].y;
    const dx = xj - xi, dy = yj - yi;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((px - xi) * dx + (py - yi) * dy) / len2));
    const ex = xi + t * dx, ey = yi + t * dy;
    const d2 = (px - ex) * (px - ex) + (py - ey) * (py - ey);
    if (d2 <= margin * margin) return true;
  }
  return false;
}


/**
 * Scan-pane inpaint: one inward-facing plane per shell surface (floor,
 * ceiling, every wall). Uses THREE.FrontSide culling so the plane only
 * renders when the camera is on the inside — orbits from outside see
 * straight through to the captured splat/mesh content. The color is a
 * neutral class default; at capture time 60%+ of the lattice-color-borrow
 * walls fell back to these defaults anyway, so skipping the lattice
 * approach costs little and frees 34k gaussians for the observed tiers.
 */
function buildCaptureInpaintShell(room, parent) {
  const shell = room?.shell;
  if (!shell) return;
  const ceilingHeight = Number(shell.ceiling_height) || 2.4;

  // Floor polygon → inward-facing +Z plane at z=0.
  const floorVertices = shell.floor_polygon?.vertices;
  if (floorVertices && floorVertices.length >= 3) {
    const points = floorVertices.map((v) => new THREE.Vector2(v.x, v.y));
    if (shoelaceSignedArea(points) < 0) points.reverse();
    const shape = new THREE.Shape(points);
    addInpaintSurface(parent, shape, 'floor',
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 });
    // Ceiling: lift the SAME polygon (in its natural +Y orientation)
    // to z=ceiling_height. We keep v_axis=+Y so (x, y) polygon vertices
    // land at (x, y, ceiling_h) — otherwise flipping v_axis to get a
    // -Z face normal mirrors the ceiling polygon through the Y axis
    // and the ceiling ends up rotated 180° off its walls. Instead
    // we keep the frame identical to the floor (face normal +Z) and
    // render with BackSide so it's only visible from BELOW — which is
    // the same dollhouse behavior we wanted from -Z + FrontSide.
    const ceilShape = new THREE.Shape(points);
    addInpaintSurface(parent, ceilShape, 'ceiling',
      { x: 0, y: 0, z: ceilingHeight },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { side: THREE.BackSide });
  }

  // Walls — each one has its own `surface_frame` pointing inward.
  const walls = (shell.surfaces || []).filter((s) => s.type === 'wall');
  for (const wall of walls) {
    const frame = wall.surface_frame;
    const boundary = wall.boundary?.vertices;
    if (!frame || !boundary || boundary.length < 3) continue;
    const points = boundary.map((v) => new THREE.Vector2(v.x, v.y));
    if (shoelaceSignedArea(points) < 0) points.reverse();
    const shape = new THREE.Shape(points);
    addInpaintSurface(parent, shape, 'wall',
      frame.origin, frame.u_axis, frame.v_axis, frame.normal);
  }
}

function addInpaintSurface(parent, shape, category, origin, uAxis, vAxis, normal, opts = {}) {
  const geom = new THREE.ShapeGeometry(shape);
  const mat = new THREE.MeshBasicMaterial({
    color: CAPTURE_INPAINT_COLORS[category] ?? 0xbbbbbb,
    // FrontSide by default → auto-transparent from outside. Ceiling
    // passes side:BackSide because its shape is emitted with a +Z face
    // normal (to avoid a Y-flip) but we want it visible from below.
    side: opts.side ?? THREE.FrontSide,
    transparent: false,
    depthWrite: true,
  });
  const mesh = new THREE.Mesh(geom, mat);
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(uAxis.x, uAxis.y, uAxis.z),
    new THREE.Vector3(vAxis.x, vAxis.y, vAxis.z),
    new THREE.Vector3(normal.x, normal.y, normal.z),
  );
  basis.setPosition(origin.x, origin.y, origin.z);
  mesh.applyMatrix4(basis);
  mesh.renderOrder = -1;         // draw before splats so their alpha composes correctly
  mesh.userData = { kind: 'capture_inpaint', category };
  parent.add(mesh);
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
    clone.traverse((child) => {
      if (!child.isMesh) return;
      child.userData = {
        ...child.userData,
        canonical_id: canonicalId,
        kind,
        class: className,
      };
    });
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

function roundCoord(value) {
  return Math.round(value * 1000) / 1000;
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
  blue: 0x2563eb,
  green: 0x22c55e,
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
  const raw = String(materialState.color).toLowerCase().trim();
  const key = raw.replace(/\s+/g, '_');
  if (NAMED_COLORS[key] !== undefined) return NAMED_COLORS[key];
  try {
    return new THREE.Color(raw).getHex();
  } catch {
    return fallback;
  }
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

const CAPTURE_SHELL_COLORS = {
  floor: 0x384152,
  wall: 0xcfd7e3,
};

// Colors for the inpainted fallback shell surfaces rendered in capture mode
// when a splat lands without coverage on the room's walls/floor/ceiling.
// Neutral warm palette so the synthesized fill doesn't dominate the captured
// content — these appear only as the inward face, so outside orbits see
// straight through to the observed RGBD/mesh tiers.
const CAPTURE_INPAINT_COLORS = {
  floor:   0xa38560,   // medium oak
  ceiling: 0xeae6e0,   // warm off-white
  wall:    0xd8d1c4,   // soft beige
};

function objectColor(object) {
  const named = object.material_state?.color
    ? materialColor(object.material_state, CLASS_PALETTE[object.class] ?? 0x7f7f7f)
    : undefined;
  if (named !== undefined) return named;
  return CLASS_PALETTE[object.class] ?? 0x7f7f7f;
}
