// Top-down 2D layout diagram of a canonical room.
// Renders floor, walls, openings, objects, fixed elements, hard-violation zones,
// clearance paths, access zones, and the selection outline.
//
// Source of truth is Scene.snapshot.state.room plus Scene.derived_state_cache.
// That matches the rendering contract in viewer.js so floorplan/synthetic
// ingestion (stretch.md Track 1 v1.2) lights up both views uniformly.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function mountLayoutView(container) {
  if (!container) throw new Error('mountLayoutView: missing container');
  container.innerHTML = '';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.display = 'block';
  svg.style.background = '#0a0e1a';
  svg.style.cursor = 'crosshair';

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

  let currentRoom = null;
  let currentDerived = null;
  let currentSelectionId = null;
  let onSelect = () => {};

  svg.addEventListener('click', (evt) => {
    const el = evt.target instanceof Element ? evt.target.closest('[data-entity-id]') : null;
    onSelect(el ? el.getAttribute('data-entity-id') : null);
  });

  container.appendChild(svg);

  function setRoom(room, derived) {
    currentRoom = room;
    currentDerived = derived || null;
    clearAllLayers();
    if (!room) return;
    const box = computeViewBox(room);
    svg.setAttribute('viewBox', box.viewBox);

    drawFloor(room, layers.floor);
    drawWalls(room, layers.walls);
    drawOpenings(room, layers.openings);
    drawFixedElements(room, layers.fixed);
    drawObjects(room, layers.objects);
    drawZones(currentDerived, layers.zones);
    drawClearancePaths(currentDerived, layers.paths);
    drawViolations(currentDerived, room, layers.violations);
    drawLabels(room, layers.labels, box);
    applySelectionHighlight(currentSelectionId);
  }

  function setSelection(id) {
    currentSelectionId = id || null;
    applySelectionHighlight(currentSelectionId);
  }

  function setOnSelect(fn) {
    onSelect = typeof fn === 'function' ? fn : () => {};
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
    layers.selection.appendChild(node);
  }

  function dispose() {
    container.innerHTML = '';
  }

  function clearLayer(layer) {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
  }
  function clearAllLayers() {
    for (const g of Object.values(layers)) clearLayer(g);
  }

  return { setRoom, setSelection, setOnSelect, dispose };
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

function drawObjects(room, layer) {
  for (const obj of room.objects) {
    if (!obj.obb) continue;
    const fill = objectFill(obj);
    const rect = obbRectNode(obj.obb, {
      fill,
      fillOpacity: obj.class === 'generic_obstacle' ? 0.4 : 0.78,
      stroke: '#e2e8f0',
      strokeWidth: 0.025,
    });
    rect.setAttribute('data-entity-id', obj.object_id);
    rect.setAttribute('data-object-class', obj.class);
    layer.appendChild(rect);
  }
}

function drawZones(derived, layer) {
  if (!derived?.zones) return;
  for (const zone of derived.zones) {
    if (!zone.polygon?.vertices?.length) continue;
    const poly = polygonNode(zone.polygon.vertices, {
      fill: '#38bdf8',
      fillOpacity: 0.08,
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
  g.setAttribute(
    'transform',
    `translate(${obb.center.x} ${obb.center.y}) rotate(${-(obb.yaw_degrees || 0)})`,
  );
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
    if (obj.object_id === id && obj.obb) return { kind: 'obb', obb: obj.obb };
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
