// Top-down 2D layout diagram of a canonical room.
// Renders floor, walls, openings, objects, fixed elements, hard-violation zones,
// clearance paths, access zones, and the selection outline.
//
// Source of truth is Scene.snapshot.state.room plus Scene.derived_state_cache.
// That matches the rendering contract in viewer.js so floorplan/synthetic
// ingestion (stretch.md Track 1 v1.2) lights up both views uniformly.

const SVG_NS = 'http://www.w3.org/2000/svg';
let ACTIVE_PREVIEW_OBBS = null;

export function mountLayoutView(container) {
  if (!container) throw new Error('mountLayoutView: missing container');
  container.innerHTML = '';
  const floorClipId = 'rv-layout-floor-clip-' + Math.random().toString(36).slice(2, 10);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.display = 'block';
  svg.style.background = '#0a0e1a';
  svg.style.cursor = 'crosshair';
  svg.style.touchAction = 'none';

  const defs = document.createElementNS(SVG_NS, 'defs');
  const floorClipPath = document.createElementNS(SVG_NS, 'clipPath');
  floorClipPath.setAttribute('id', floorClipId);
  floorClipPath.setAttribute('clipPathUnits', 'userSpaceOnUse');
  const floorClipPolygon = document.createElementNS(SVG_NS, 'polygon');
  floorClipPath.appendChild(floorClipPolygon);
  defs.appendChild(floorClipPath);
  svg.appendChild(defs);

  // Root has scale(1, -1) so we can draw directly in canonical room coords
  // (+x east, +y north). Consequence: rotations need their sign negated below.
  const root = document.createElementNS(SVG_NS, 'g');
  root.setAttribute('transform', 'scale(1 -1)');
  svg.appendChild(root);

  const layers = {};
  for (const name of [
    'floor',
    'zones',
    'violations',
    'paths',
    'walls',
    'openings',
    'fixed',
    'objects',
    'labels',
    'selection',
  ]) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-layer', name);
    layers[name] = g;
    root.appendChild(g);
  }
  layers.zones.setAttribute('clip-path', `url(#${floorClipId})`);

  let currentRoom = null;
  let currentDerived = null;
  let currentSelectionId = null;
  let onSelect = () => {};
  let onDragStart = () => {};
  let onDragMove = () => {};
  let onDragEnd = () => {};
  let dragEnabled = false;
  let suppressNextClick = false;
  let dragSession = null;
  const objectNodesById = new Map();
  const previewObbsByObjectId = new Map();
  ACTIVE_PREVIEW_OBBS = previewObbsByObjectId;

  svg.addEventListener('click', (evt) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    const handle = evt.target instanceof Element ? evt.target.closest('[data-transform-handle]') : null;
    if (handle) return;
    const el = evt.target instanceof Element ? evt.target.closest('[data-entity-id]') : null;
    onSelect(el ? el.getAttribute('data-entity-id') : null);
  });

  svg.addEventListener('pointerdown', (evt) => {
    if (!currentRoom) return;
    const pointer = clientToRoomPoint(evt, root);
    if (!pointer) return;
    const handle = evt.target instanceof Element ? evt.target.closest('[data-transform-handle]') : null;
    if (handle) {
      if (!dragEnabled) return;
      const objectId = handle.getAttribute('data-object-id');
      const object = currentRoom.objects.find((candidate) => candidate.object_id === objectId);
      const handleKind = handle.getAttribute('data-transform-handle');
      if (!object || !object.obb || !handleKind) return;
      evt.preventDefault();
      onSelect(objectId);
      dragSession = createHandleDragSession(evt, object, pointer, handleKind);
      if (!dragSession) return;
      svg.style.cursor = handleKind === 'rotate' ? 'crosshair' : 'nwse-resize';
      svg.setPointerCapture(evt.pointerId);
      return;
    }
    if (!dragEnabled) return;
    const el = evt.target instanceof Element ? evt.target.closest('[data-object-id]') : null;
    if (!el) return;
    const objectId = el.getAttribute('data-object-id');
    const object = currentRoom.objects.find((candidate) => candidate.object_id === objectId);
    if (!object) return;
    evt.preventDefault();
    evt.preventDefault();
    onSelect(objectId);
    dragSession = {
      mode: 'move',
      pointerId: evt.pointerId,
      objectId,
      startClientX: evt.clientX,
      startClientY: evt.clientY,
      startPoint: pointer,
      basePosition: { ...object.pose.position },
      previewObjectIds: collectPreviewObjectIds(currentRoom.objects, objectId),
      moved: false,
    };
    svg.style.cursor = 'grabbing';
    svg.setPointerCapture(evt.pointerId);
    onDragStart({
      objectId,
      target_position: { ...object.pose.position },
      include_children: dragSession.previewObjectIds.length > 1,
      moved: false,
    });
  });

  svg.addEventListener('pointermove', (evt) => {
    if (!dragSession || evt.pointerId !== dragSession.pointerId || !currentRoom) return;
    const pointer = clientToRoomPoint(evt, root);
    if (!pointer) return;
    if (dragSession.mode === 'rotate') {
      dragSession.moved = dragSession.moved || Math.hypot(evt.clientX - dragSession.startClientX, evt.clientY - dragSession.startClientY) >= 4;
      const angle = angleDegrees(dragSession.center, pointer);
      const yawDegrees = roundCoord(dragSession.baseYaw + normalizeAngleDegrees(angle - dragSession.startAngle));
      updatePreviewObb(currentRoom, dragSession.objectId, previewObbsByObjectId, { yaw_degrees: yawDegrees });
      applyPreviewTransforms(currentRoom, objectNodesById, previewObbsByObjectId);
      applySelectionHighlight(currentSelectionId);
      onDragMove({
        action: 'rotate',
        objectId: dragSession.objectId,
        yaw_degrees: yawDegrees,
        moved: dragSession.moved,
      });
      return;
    }
    if (dragSession.mode === 'resize') {
      dragSession.moved = dragSession.moved || Math.hypot(evt.clientX - dragSession.startClientX, evt.clientY - dragSession.startClientY) >= 4;
      const local = worldPointToLocalObb(pointer, dragSession.baseObb);
      const size_x = roundCoord(clamp(Math.abs(local.x) * 2, 0.15, 8));
      const size_y = roundCoord(clamp(Math.abs(local.y) * 2, 0.15, 8));
      updatePreviewObb(currentRoom, dragSession.objectId, previewObbsByObjectId, { size_x, size_y });
      applyPreviewTransforms(currentRoom, objectNodesById, previewObbsByObjectId);
      applySelectionHighlight(currentSelectionId);
      onDragMove({
        action: 'resize',
        objectId: dragSession.objectId,
        size_x,
        size_y,
        moved: dragSession.moved,
      });
      return;
    }
    const delta = {
      x: roundCoord(pointer.x - dragSession.startPoint.x),
      y: roundCoord(pointer.y - dragSession.startPoint.y),
      z: 0,
    };
    dragSession.moved = dragSession.moved || Math.hypot(evt.clientX - dragSession.startClientX, evt.clientY - dragSession.startClientY) >= 4;
    updatePreviewObbsForMove(currentRoom, dragSession.previewObjectIds, delta, previewObbsByObjectId);
    applyPreviewTransforms(currentRoom, objectNodesById, previewObbsByObjectId);
    applySelectionHighlight(currentSelectionId);
    onDragMove({
      action: 'move',
      objectId: dragSession.objectId,
      delta,
      target_position: {
        x: roundCoord(dragSession.basePosition.x + delta.x),
        y: roundCoord(dragSession.basePosition.y + delta.y),
        z: dragSession.basePosition.z,
      },
      include_children: dragSession.previewObjectIds.length > 1,
      moved: dragSession.moved,
    });
  });

  const finishDrag = (evt, cancelled) => {
    if (!dragSession || (evt && evt.pointerId !== dragSession.pointerId)) return;
    const session = dragSession;
    dragSession = null;
    svg.style.cursor = dragEnabled ? 'grab' : 'crosshair';
    if (!cancelled && svg.hasPointerCapture(session.pointerId)) {
      svg.releasePointerCapture(session.pointerId);
    }
    if (cancelled || !session.moved) {
      clearDragPreviewInternal();
      if (session.mode === 'move') {
        onDragEnd({
          action: 'move',
          objectId: session.objectId,
          target_position: { ...session.basePosition },
          include_children: session.previewObjectIds.length > 1,
          moved: false,
          cancelled: cancelled === true,
        });
      } else if (session.mode === 'rotate') {
        onDragEnd({
          action: 'rotate',
          objectId: session.objectId,
          yaw_degrees: session.baseYaw,
          moved: false,
          cancelled: cancelled === true,
        });
      } else if (session.mode === 'resize') {
        onDragEnd({
          action: 'resize',
          objectId: session.objectId,
          size_x: session.baseObb.size_x,
          size_y: session.baseObb.size_y,
          moved: false,
          cancelled: cancelled === true,
        });
      }
      return;
    }
    suppressNextClick = true;
    const previewObb = previewObbsByObjectId.get(session.objectId);
    if (session.mode === 'move') {
      onDragEnd({
        action: 'move',
        objectId: session.objectId,
        target_position: {
          x: roundCoord(session.basePosition.x + (previewObb ? previewObb.center.x - currentRoom.objects.find((candidate) => candidate.object_id === session.objectId).obb.center.x : 0)),
          y: roundCoord(session.basePosition.y + (previewObb ? previewObb.center.y - currentRoom.objects.find((candidate) => candidate.object_id === session.objectId).obb.center.y : 0)),
          z: session.basePosition.z,
        },
        include_children: session.previewObjectIds.length > 1,
        moved: true,
        cancelled: false,
      });
      return;
    }
    if (session.mode === 'rotate') {
      onDragEnd({
        action: 'rotate',
        objectId: session.objectId,
        yaw_degrees: previewObb ? previewObb.yaw_degrees : session.baseYaw,
        moved: true,
        cancelled: false,
      });
      return;
    }
    if (session.mode === 'resize') {
      onDragEnd({
        action: 'resize',
        objectId: session.objectId,
        size_x: previewObb ? previewObb.size_x : session.baseObb.size_x,
        size_y: previewObb ? previewObb.size_y : session.baseObb.size_y,
        moved: true,
        cancelled: false,
      });
    }
  };

  svg.addEventListener('pointerup', (evt) => finishDrag(evt, false));
  svg.addEventListener('pointercancel', (evt) => finishDrag(evt, true));
  svg.addEventListener('lostpointercapture', (evt) => finishDrag(evt, true));

  container.appendChild(svg);

  function setRoom(room, derived) {
    currentRoom = room;
    currentDerived = derived || null;
    previewObbsByObjectId.clear();
    objectNodesById.clear();
    clearAllLayers();
    if (!room) {
      floorClipPolygon.setAttribute('points', '');
      return;
    }
    const box = computeViewBox(room);
    svg.setAttribute('viewBox', box.viewBox);
    floorClipPolygon.setAttribute('points', room.shell.floor_polygon.vertices.map((v) => `${v.x},${v.y}`).join(' '));

    drawFloor(room, layers.floor);
    drawWalls(room, layers.walls);
    drawOpenings(room, layers.openings);
    drawFixedElements(room, layers.fixed);
    drawObjects(room, layers.objects, objectNodesById);
    drawZones(currentDerived, currentSelectionId, layers.zones);
    drawClearancePaths(currentDerived, layers.paths);
    drawViolations(currentDerived, room, layers.violations);
    drawLabels(room, layers.labels, box);
    applySelectionHighlight(currentSelectionId);
  }

  function setSelection(id) {
    currentSelectionId = id || null;
    clearLayer(layers.zones);
    drawZones(currentDerived, currentSelectionId, layers.zones);
    applySelectionHighlight(currentSelectionId);
  }

  function setOnSelect(fn) {
    onSelect = typeof fn === 'function' ? fn : () => {};
  }

  function setOnDragStart(fn) {
    onDragStart = typeof fn === 'function' ? fn : () => {};
  }

  function setOnDragMove(fn) {
    onDragMove = typeof fn === 'function' ? fn : () => {};
  }

  function setOnDragEnd(fn) {
    onDragEnd = typeof fn === 'function' ? fn : () => {};
  }

  function setDragEnabled(enabled) {
    dragEnabled = Boolean(enabled);
    svg.style.cursor = dragEnabled ? 'grab' : 'crosshair';
    if (!dragEnabled) {
      clearDragPreviewInternal();
    }
  }

  function clearDragPreviewInternal() {
    previewObbsByObjectId.clear();
    if (currentRoom) {
      applyPreviewTransforms(currentRoom, objectNodesById, previewObbsByObjectId);
      applySelectionHighlight(currentSelectionId);
    }
  }

  function clearDragPreview() {
    dragSession = null;
    clearDragPreviewInternal();
  }

  function applySelectionHighlight(id) {
    clearLayer(layers.selection);
    root.querySelectorAll('[data-entity-id]').forEach((el) => {
      if (el.getAttribute('data-entity-id') === id) {
        el.classList.add('rv-selected');
      } else {
        el.classList.remove('rv-selected');
      }
    });
    if (!id || !currentRoom) return;
    const outline = findEntityOutline(id, currentRoom);
    if (!outline) return;
    const node = shapeFromOutline(outline, {
      fill: 'none',
      stroke: '#fbbf24',
      strokeWidth: 0.06,
      strokeDasharray: '0.12 0.06',
    });
    node.setAttribute('pointer-events', 'none');
    layers.selection.appendChild(node);
    const selectedObject = currentRoom.objects.find((obj) => obj.object_id === id) || null;
    if (dragEnabled && selectedObject?.obb) {
      appendTransformHandles(layers.selection, selectedObject.obb, selectedObject.object_id);
    }
  }

  function dispose() {
    if (ACTIVE_PREVIEW_OBBS === previewObbsByObjectId) {
      ACTIVE_PREVIEW_OBBS = null;
    }
    container.innerHTML = '';
  }

  function clearLayer(layer) {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
  }
  function clearAllLayers() {
    for (const g of Object.values(layers)) clearLayer(g);
  }

  return {
    setRoom,
    setSelection,
    setOnSelect,
    setOnDragStart,
    setOnDragMove,
    setOnDragEnd,
    setDragEnabled,
    clearDragPreview,
    dispose,
  };
}

// ---------------- layout helpers ----------------

function computeViewBox(room) {
  const verts = room.shell.floor_polygon.vertices;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of verts) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const padding = 0.5;
  const viewMinX = minX - padding;
  const viewMaxY = maxY + padding;
  const viewW = (maxX - minX) + padding * 2;
  const viewH = (maxY - minY) + padding * 2;
  // viewBox y is negated because root group applies scale(1, -1).
  return { viewBox: `${viewMinX} ${-viewMaxY} ${viewW} ${viewH}`, minX, maxX, minY, maxY, padding };
}

// ---------------- drawing ----------------

function drawFloor(room, layer) {
  const poly = document.createElementNS(SVG_NS, 'polygon');
  poly.setAttribute('points', room.shell.floor_polygon.vertices.map((v) => `${v.x},${v.y}`).join(' '));
  poly.setAttribute('fill', '#1e293b');
  poly.setAttribute('stroke', 'none');
  layer.appendChild(poly);
}

function drawWalls(room, layer) {
  const walls = room.shell.surfaces.filter((s) => s.type === 'wall');
  for (const wall of walls) {
    const seg = wallFloorSegment(wall);
    if (!seg) continue;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', seg.a.x);
    line.setAttribute('y1', seg.a.y);
    line.setAttribute('x2', seg.b.x);
    line.setAttribute('y2', seg.b.y);
    line.setAttribute('stroke', '#cbd5e1');
    line.setAttribute('stroke-width', 0.09);
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('data-entity-id', wall.surface_id);
    layer.appendChild(line);
  }
}

function drawOpenings(room, layer) {
  const wallById = new Map(
    room.shell.surfaces.filter((s) => s.type === 'wall').map((w) => [w.surface_id, w]),
  );
  for (const opening of room.shell.openings) {
    const wall = wallById.get(opening.host_surface_id);
    if (!wall) continue;
    const { min_u, width } = opening.rect;
    const origin = wall.surface_frame.origin;
    const u = wall.surface_frame.u_axis;
    const a = { x: origin.x + u.x * min_u, y: origin.y + u.y * min_u };
    const b = { x: origin.x + u.x * (min_u + width), y: origin.y + u.y * (min_u + width) };
    const color = opening.type === 'door' ? '#fbbf24' : '#7dd3fc';
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', a.x);
    line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x);
    line.setAttribute('y2', b.y);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', 0.14);
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('data-entity-id', opening.opening_id);
    layer.appendChild(line);

    if (opening.swing_zone) {
      const arc = polygonNode(opening.swing_zone.vertices, {
        fill: color,
        fillOpacity: 0.08,
        stroke: color,
        strokeOpacity: 0.35,
        strokeWidth: 0.02,
        strokeDasharray: '0.1 0.08',
      });
      arc.setAttribute('data-entity-id', opening.opening_id);
      layer.appendChild(arc);
    }
  }
}

function drawFixedElements(room, layer) {
  for (const el of room.shell.fixed_elements || []) {
    if (!el.obb) continue;
    const rect = obbRectNode(el.obb, {
      fill: '#475569',
      fillOpacity: 0.75,
      stroke: '#94a3b8',
      strokeWidth: 0.02,
    });
    rect.setAttribute('data-entity-id', el.fixed_element_id);
    layer.appendChild(rect);
  }
}

function drawObjects(room, layer, objectNodesById) {
  for (const obj of room.objects) {
    if (!obj.obb) continue;
    const fill = objectFill(obj);
    const style = {
      fill,
      fillOpacity: obj.class === 'generic_obstacle' ? 0.4 : 0.78,
      stroke: '#e2e8f0',
      strokeWidth: 0.025,
    };
    // Prefer the tight mesh-derived footprint when present — renders the
    // actual object shape (chair-shaped, sofa-shaped) instead of a loose
    // OBB rectangle. Falls back to the OBB rect when no footprint yet.
    const fpVerts = obj.footprint_polygon?.vertices;
    const useFootprint = Array.isArray(fpVerts) && fpVerts.length >= 3;
    const group = useFootprint
      ? wrapInGroup(polygonNode(fpVerts, style))
      : obbRectNode(obj.obb, style);
    group.setAttribute('data-entity-id', obj.object_id);
    group.setAttribute('data-object-id', obj.object_id);
    group.setAttribute('data-object-class', obj.class);
    if (objectNodesById) {
      objectNodesById.set(obj.object_id, {
        group,
        rect: group.firstChild,
      });
    }
    layer.appendChild(group);
  }
}

function wrapInGroup(child) {
  // Polygon footprints are already in world coordinates, so the wrapping
  // <g> needs no transform — but we keep one around for parity with
  // obbRectNode's group (selection/drag helpers expect a group node).
  const g = document.createElementNS(SVG_NS, 'g');
  g.appendChild(child);
  return g;
}

function drawZones(derived, selectionId, layer) {
  if (!derived?.zones) return;
  for (const zone of derived.zones) {
    if (!selectionId || zone.entity_id !== selectionId) continue;
    if (!zone.polygon?.vertices?.length) continue;
    const poly = polygonNode(zone.polygon.vertices, {
      fill: '#38bdf8',
      fillOpacity: 0.06,
      stroke: '#38bdf8',
      strokeOpacity: 0.35,
      strokeWidth: 0.02,
      strokeDasharray: '0.15 0.08',
    });
    poly.setAttribute('data-zone-kind', zone.kind);
    layer.appendChild(poly);
  }
}

function drawClearancePaths(derived, layer) {
  if (!derived?.clearance_paths) return;
  for (const path of derived.clearance_paths) {
    if (!path.waypoints?.length) continue;
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', path.waypoints.map((w) => `${w.x},${w.y}`).join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', '#34d399');
    line.setAttribute('stroke-opacity', 0.6);
    line.setAttribute('stroke-width', Math.max(0.04, Math.min(0.14, (path.width_m || 0.5) * 0.18)));
    line.setAttribute('stroke-dasharray', '0.2 0.1');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    layer.appendChild(line);
  }
}

function drawViolations(derived, room, layer) {
  if (!derived?.hard_violations) return;
  const affected = new Set();
  for (const v of derived.hard_violations) {
    for (const id of collectViolationEntityIds(v)) affected.add(id);
  }
  for (const id of affected) {
    const outline = findEntityOutline(id, room);
    if (!outline) continue;
    const node = shapeFromOutline(outline, {
      fill: '#ef4444',
      fillOpacity: 0.22,
      stroke: '#f87171',
      strokeWidth: 0.04,
    });
    node.setAttribute('data-entity-id', id);
    node.setAttribute('data-violation', 'true');
    layer.appendChild(node);
  }
}

function drawLabels(room, layer, box) {
  const fontSize = Math.max(0.12, Math.min(0.18, (box.maxX - box.minX) * 0.035));
  for (const obj of room.objects) {
    if (!obj.obb) continue;
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', obj.obb.center.x);
    // Text lives outside the flipped root so needs explicit y handling — but
    // since labels sit inside the `labels` layer (which is under root's flip),
    // we need another local flip so text isn't drawn upside down.
    text.setAttribute('y', -obj.obb.center.y);
    text.setAttribute('transform', 'scale(1 -1)');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('fill', '#f1f5f9');
    text.setAttribute('font-size', fontSize);
    text.setAttribute('font-family', 'Inter, system-ui, sans-serif');
    text.setAttribute('pointer-events', 'none');
    text.textContent = obj.class;
    layer.appendChild(text);
  }
}

// ---------------- primitives ----------------

function obbRectNode(obb, style) {
  const g = document.createElementNS(SVG_NS, 'g');
  // In canonical frame yaw_degrees is CCW about +z. Root has scale(1,-1),
  // which flips the visual handedness, so we negate the angle here to keep
  // the apparent rotation consistent with canonical state.
  g.setAttribute('transform', objectTransformForObb(obb));
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', -obb.size_x / 2);
  rect.setAttribute('y', -obb.size_y / 2);
  rect.setAttribute('width', obb.size_x);
  rect.setAttribute('height', obb.size_y);
  rect.setAttribute('rx', 0.03);
  applyStyle(rect, style);
  g.appendChild(rect);
  return g;
}

function objectTransformForObb(obb, overrideCenter) {
  const center = overrideCenter || obb.center;
  return `translate(${center.x} ${center.y}) rotate(${-(obb.yaw_degrees || 0)})`;
}

function polygonNode(vertices, style) {
  const poly = document.createElementNS(SVG_NS, 'polygon');
  poly.setAttribute('points', vertices.map((v) => `${v.x},${v.y}`).join(' '));
  applyStyle(poly, style);
  return poly;
}

function applyStyle(node, style) {
  if (!style) return;
  for (const [k, v] of Object.entries(style)) {
    const attr = kebab(k);
    node.setAttribute(attr, v);
  }
}

function kebab(s) {
  return s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

function wallFloorSegment(wall) {
  if (!wall.surface_frame || !wall.boundary?.vertices?.length) return null;
  const xs = wall.boundary.vertices.map((v) => v.x);
  const uMin = Math.min(...xs);
  const uMax = Math.max(...xs);
  const o = wall.surface_frame.origin;
  const u = wall.surface_frame.u_axis;
  return {
    a: { x: o.x + u.x * uMin, y: o.y + u.y * uMin },
    b: { x: o.x + u.x * uMax, y: o.y + u.y * uMax },
  };
}

function findEntityOutline(id, room) {
  if (!id || !room) return null;
  for (const obj of room.objects || []) {
    if (obj.object_id === id && obj.obb) {
      const previewCenter = previewCenterForObject(id);
      return previewCenter
        ? { kind: 'obb', obb: { ...obj.obb, center: previewCenter } }
        : { kind: 'obb', obb: obj.obb };
    }
  }
  for (const fe of room.shell.fixed_elements || []) {
    if (fe.fixed_element_id === id && fe.obb) return { kind: 'obb', obb: fe.obb };
  }
  for (const opening of room.shell.openings || []) {
    if (opening.opening_id === id) {
      const wall = room.shell.surfaces.find((s) => s.surface_id === opening.host_surface_id);
      if (!wall) return null;
      const { min_u, width } = opening.rect;
      const o = wall.surface_frame.origin;
      const u = wall.surface_frame.u_axis;
      const a = { x: o.x + u.x * min_u, y: o.y + u.y * min_u };
      const b = { x: o.x + u.x * (min_u + width), y: o.y + u.y * (min_u + width) };
      return { kind: 'segment', a, b };
    }
  }
  for (const s of room.shell.surfaces || []) {
    if (s.surface_id === id && s.type === 'wall') {
      const seg = wallFloorSegment(s);
      if (seg) return { kind: 'segment', ...seg };
    }
  }
  return null;
}

function previewCenterForObject(id) {
  return ACTIVE_PREVIEW_OBBS?.get(id)?.center || null;
}

function previewObbForObject(id) {
  return ACTIVE_PREVIEW_OBBS?.get(id) || null;
}

function clientToRoomPoint(event, root) {
  const matrix = root?.getScreenCTM?.();
  if (!matrix) return null;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  return { x: point.x, y: point.y };
}

function collectPreviewObjectIds(objects, rootId) {
  const ids = [rootId];
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift();
    for (const candidate of objects || []) {
      if (candidate.parent_id !== parentId || candidate.child_movement_policy !== 'move_with_parent') continue;
      ids.push(candidate.object_id);
      queue.push(candidate.object_id);
    }
  }
  return ids;
}

function updatePreviewObbsForMove(room, objectIds, delta, previewObbsByObjectId) {
  previewObbsByObjectId.clear();
  for (const objectId of objectIds) {
    const object = room.objects.find((candidate) => candidate.object_id === objectId);
    if (!object?.obb?.center) continue;
    previewObbsByObjectId.set(objectId, {
      ...object.obb,
      center: {
        x: roundCoord(object.obb.center.x + delta.x),
        y: roundCoord(object.obb.center.y + delta.y),
        z: roundCoord(object.obb.center.z + delta.z),
      },
    });
  }
}

function updatePreviewObb(room, objectId, previewObbsByObjectId, patch) {
  const object = room.objects.find((candidate) => candidate.object_id === objectId);
  if (!object?.obb) return;
  previewObbsByObjectId.set(objectId, {
    ...object.obb,
    ...patch,
    center: patch.center ? { ...patch.center } : { ...object.obb.center },
  });
}

function applyPreviewTransforms(room, objectNodesById, previewObbsByObjectId) {
  for (const object of room.objects || []) {
    const node = objectNodesById.get(object.object_id);
    if (!node || !object.obb) continue;
    const previewObb = previewObbsByObjectId.get(object.object_id) || object.obb;
    syncObjectNodeToObb(node, previewObb);
  }
}

function syncObjectNodeToObb(node, obb) {
  if (!node?.group || !node?.rect || !obb) return;
  node.group.setAttribute('transform', objectTransformForObb(obb));
  node.rect.setAttribute('x', -obb.size_x / 2);
  node.rect.setAttribute('y', -obb.size_y / 2);
  node.rect.setAttribute('width', obb.size_x);
  node.rect.setAttribute('height', obb.size_y);
}

function createHandleDragSession(evt, object, pointer, handleKind) {
  if (handleKind === 'rotate') {
    return {
      mode: 'rotate',
      pointerId: evt.pointerId,
      objectId: object.object_id,
      startClientX: evt.clientX,
      startClientY: evt.clientY,
      center: { ...object.obb.center },
      baseYaw: object.pose?.yaw_degrees ?? object.obb.yaw_degrees ?? 0,
      startAngle: angleDegrees(object.obb.center, pointer),
      moved: false,
    };
  }
  if (handleKind === 'resize') {
    return {
      mode: 'resize',
      pointerId: evt.pointerId,
      objectId: object.object_id,
      startClientX: evt.clientX,
      startClientY: evt.clientY,
      baseObb: { ...object.obb, center: { ...object.obb.center } },
      moved: false,
    };
  }
  return null;
}

function appendTransformHandles(layer, obb, objectId) {
  const rotateStart = localPointToWorld(obb, obb.size_x / 2, 0);
  const rotateEnd = localPointToWorld(obb, obb.size_x / 2 + 0.28, 0);
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', rotateStart.x);
  line.setAttribute('y1', rotateStart.y);
  line.setAttribute('x2', rotateEnd.x);
  line.setAttribute('y2', rotateEnd.y);
  line.setAttribute('stroke', '#fbbf24');
  line.setAttribute('stroke-width', 0.03);
  line.setAttribute('stroke-dasharray', '0.08 0.05');
  line.setAttribute('pointer-events', 'none');
  layer.appendChild(line);

  const rotateHandle = document.createElementNS(SVG_NS, 'circle');
  rotateHandle.setAttribute('cx', rotateEnd.x);
  rotateHandle.setAttribute('cy', rotateEnd.y);
  rotateHandle.setAttribute('r', 0.09);
  rotateHandle.setAttribute('fill', '#fbbf24');
  rotateHandle.setAttribute('stroke', '#111827');
  rotateHandle.setAttribute('stroke-width', 0.03);
  rotateHandle.setAttribute('data-transform-handle', 'rotate');
  rotateHandle.setAttribute('data-object-id', objectId);
  layer.appendChild(rotateHandle);

  const resizeHandleCenter = localPointToWorld(obb, obb.size_x / 2, obb.size_y / 2);
  const resizeHandle = document.createElementNS(SVG_NS, 'rect');
  resizeHandle.setAttribute('x', resizeHandleCenter.x - 0.09);
  resizeHandle.setAttribute('y', resizeHandleCenter.y - 0.09);
  resizeHandle.setAttribute('width', 0.18);
  resizeHandle.setAttribute('height', 0.18);
  resizeHandle.setAttribute('fill', '#38bdf8');
  resizeHandle.setAttribute('stroke', '#111827');
  resizeHandle.setAttribute('stroke-width', 0.03);
  resizeHandle.setAttribute('transform', `rotate(${-(obb.yaw_degrees || 0)} ${resizeHandleCenter.x} ${resizeHandleCenter.y})`);
  resizeHandle.setAttribute('data-transform-handle', 'resize');
  resizeHandle.setAttribute('data-object-id', objectId);
  layer.appendChild(resizeHandle);
}

function localPointToWorld(obb, localX, localY) {
  const radians = degreesToRadians(obb.yaw_degrees || 0);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: roundCoord(obb.center.x + localX * cos - localY * sin),
    y: roundCoord(obb.center.y + localX * sin + localY * cos),
  };
}

function worldPointToLocalObb(point, obb) {
  const radians = degreesToRadians(-(obb.yaw_degrees || 0));
  const dx = point.x - obb.center.x;
  const dy = point.y - obb.center.y;
  return {
    x: roundCoord(dx * Math.cos(radians) - dy * Math.sin(radians)),
    y: roundCoord(dx * Math.sin(radians) + dy * Math.cos(radians)),
  };
}

function angleDegrees(from, to) {
  return Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI;
}

function normalizeAngleDegrees(value) {
  return ((((value % 360) + 540) % 360) - 180);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

function roundCoord(value) {
  return Math.round(value * 1000) / 1000;
}

function shapeFromOutline(outline, style) {
  if (outline.kind === 'obb') return obbRectNode(outline.obb, style);
  if (outline.kind === 'segment') {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', outline.a.x);
    line.setAttribute('y1', outline.a.y);
    line.setAttribute('x2', outline.b.x);
    line.setAttribute('y2', outline.b.y);
    applyStyle(line, style);
    return line;
  }
  return document.createElementNS(SVG_NS, 'g');
}

function collectViolationEntityIds(violation) {
  const ids = [];
  if (violation.entity_id) ids.push(violation.entity_id);
  if (Array.isArray(violation.entity_ids)) ids.push(...violation.entity_ids);
  if (Array.isArray(violation.blocked_by)) ids.push(...violation.blocked_by);
  return ids;
}

// ---------------- palette (mirrors viewer.js) ----------------

const NAMED_COLORS = {
  oak: '#b08d57',
  walnut: '#5d432c',
  cherry: '#8b3a3a',
  maple: '#d4a66a',
  pine: '#d8b98a',
  soft_white: '#f2efe8',
  warm_white: '#f3ead5',
  off_white: '#eeeae0',
  cream: '#ece6d4',
  slate: '#4a5568',
  charcoal: '#2d3139',
  sand: '#c7ae86',
  sage: '#9aa98a',
  navy: '#1f2a44',
  linen: '#e7dfcd',
  terracotta: '#b56c4f',
  beige: '#c8b99c',
  white: '#f3f3f1',
  gray: '#8a8a8a',
  grey: '#8a8a8a',
  black: '#1a1a1a',
};

const CLASS_PALETTE = {
  bed: '#8c6f53',
  nightstand: '#9e8a6a',
  desk: '#6b6f8c',
  chair: '#5c7a8c',
  table: '#7f6b52',
  dresser: '#6b5b47',
  bookshelf: '#7a6648',
  sofa: '#8c5f5c',
  rug: '#a07c5a',
  lamp: '#d4c28a',
  television: '#1f2937',
  storage: '#706547',
  generic_obstacle: '#6e6e6e',
};

function objectFill(obj) {
  const key = obj.material_state?.color ? String(obj.material_state.color).toLowerCase() : null;
  if (key && NAMED_COLORS[key]) return NAMED_COLORS[key];
  return CLASS_PALETTE[obj.class] || '#7f7f7f';
}
