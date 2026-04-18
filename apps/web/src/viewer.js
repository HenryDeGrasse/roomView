// RoomView 3D viewer — slice 1 (shell + openings + objects + camera).
// Renders from canonical `Scene.snapshot.state.room` so floorplan/synthetic
// ingestion (stretch.md Track 1 v1.2) inherits the viewer without changes.
// Coordinate frame preserved as canonical +z up so future USD/DXF export
// (stretch.md Track 3 v2) walks the graph without root-rotation to undo.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const LAYER_SHELL = 0;
const LAYER_OBJECTS = 1;
const LAYER_SPLAT = 2;
const LAYER_GIZMO = 3;

export function mountViewer(container) {
  if (!container) throw new Error('mountViewer: missing container element');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.position.set(4, -3, 6);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
  camera.up.set(0, 0, 1);
  camera.position.set(6, -6, 4);
  camera.layers.enable(LAYER_SHELL);
  camera.layers.enable(LAYER_OBJECTS);

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

  function setRoom(room) {
    if (!room) return;
    disposeRoomsRoot();
    const roomGroup = buildRoomGroup(room);
    roomsRoot.add(roomGroup);
    if (room.room_id !== currentRoomId) {
      fitCameraToRoom(camera, controls, room);
      currentRoomId = room.room_id;
    }
  }

  function disposeRoomsRoot() {
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

  const api = { setRoom, dispose };
  // Dev/demo hook: lets the browser console (and later E2E harnesses) inspect
  // the scene graph, camera, and controls without re-plumbing through the UI.
  if (typeof window !== 'undefined') {
    window.__roomviewDebug = { api, scene, camera, controls, roomsRoot, THREE };
  }
  return api;
}

function buildRoomGroup(room) {
  const group = new THREE.Group();
  group.userData = { kind: 'room', canonical_id: room.room_id };

  const shell = new THREE.Group();
  shell.userData = { kind: 'shell' };
  buildFloor(room, shell);
  buildWalls(room, shell);
  buildFixedElements(room, shell);
  setLayerDeep(shell, LAYER_SHELL);
  group.add(shell);

  const objects = new THREE.Group();
  objects.userData = { kind: 'objects' };
  buildObjects(room, objects);
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

function buildFixedElements(room, parent) {
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
  }
}

function buildObjects(room, parent) {
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
  }
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
