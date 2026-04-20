// Gaussian Splat loader — wires @mkkellogg/gaussian-splats-3d into the
// scan-pane viewer via the viewer's setSplatLoader hook.
//
// Two loading paths:
//   1. Single-PLY (legacy): one DropInViewer covers the whole scene.
//   2. Per-object split: N DropInViewers, one for each object_id plus a
//      shell viewer for walls/floor/ceiling. Each sub-viewer's Object3D
//      carries `userData.object_id` so the move-handle in viewer.js
//      translates its gaussians in lockstep with the mesh.
//
// The split path activates when setSplat receives a descriptor with
// `split_manifest_uri`. The viewer fetches the manifest, then fires off
// one DropInViewer per entry. All sub-viewers live under a single root
// group added to scene.children so the existing visibility toggle
// ("Splat" vs "Meshes" mode) can flip the whole tree at once.
//
// Format: Brush writes antimatter15/gsplat.js compatible PLYs. The
// vendored library detects the format from the URL extension.
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

let activeViewer = null;           // legacy: singleton DropInViewer
let activeSplatRoot = null;        // new: root Group holding all sub-viewers
let activeSubViewers = [];         // { viewer, object_id } entries
let lastDisposedAt = 0;

/** Returns the legacy DropInViewer for the dollhouse visibility toggle. */
export function getActiveSplatViewer() {
  return activeSplatRoot || activeViewer;
}

function disposeActive(scene) {
  if (activeViewer) {
    try {
      scene.remove(activeViewer);
      if (typeof activeViewer.dispose === 'function') activeViewer.dispose();
    } catch (err) {
      console.warn('[splat-loader] dispose legacy failed', err);
    }
    activeViewer = null;
  }
  if (activeSplatRoot) {
    try {
      for (const { viewer } of activeSubViewers) {
        if (viewer && typeof viewer.dispose === 'function') viewer.dispose();
      }
      scene.remove(activeSplatRoot);
    } catch (err) {
      console.warn('[splat-loader] dispose split failed', err);
    }
    activeSplatRoot = null;
    activeSubViewers = [];
  }
  lastDisposedAt = performance.now();
}

function makeDropInViewer() {
  return new GaussianSplats3D.DropInViewer({
    sharedMemoryForWorkers: false,
    gpuAcceleratedSort: false,
  });
}

function propagateLayer(object, layer) {
  object.traverse((child) => {
    if (child.layers && typeof child.layers.set === 'function') {
      child.layers.set(layer);
    }
  });
}

async function loadSingleSplat({ uri, scene, layer }) {
  const viewer = makeDropInViewer();
  viewer.addSplatScenes([
    {
      path: uri,
      splatAlphaRemovalThreshold: 5,
      showLoadingUI: false,
    },
  ])
    .then(() => propagateLayer(viewer, layer))
    .catch((err) => console.error('[splat-loader] addSplatScenes failed', err));
  scene.add(viewer);
  activeViewer = viewer;
  return { status: 'ready' };
}

async function loadSplitSplats({ splitManifestUri, scene, layer, THREE }) {
  const res = await fetch(splitManifestUri);
  if (!res.ok) {
    console.warn('[splat-loader] split manifest fetch failed', res.status, 'falling back to single-load');
    return null;
  }
  const manifest = await res.json();
  const entries = Array.isArray(manifest?.sub_splats) ? manifest.sub_splats : [];
  if (entries.length === 0) return null;

  const root = new THREE.Group();
  root.name = 'splat_sub_viewers_root';
  root.userData.kind = 'splat_sub_viewers';
  scene.add(root);

  for (const entry of entries) {
    if (!entry?.uri) continue;
    const wrapper = new THREE.Group();
    wrapper.name = `splat_sub_${entry.owner}`;
    // The shell sub-splat has owner === "shell"; object sub-splats carry
    // the actual object_id so viewer.js's move handler translates them
    // with the matching mesh via the existing `userData.object_id` test.
    if (entry.owner && entry.owner !== 'shell') {
      wrapper.userData.object_id = entry.owner;
    }
    wrapper.userData.kind = 'splat_sub_viewer';
    const viewer = makeDropInViewer();
    wrapper.add(viewer);
    root.add(wrapper);
    activeSubViewers.push({ viewer, object_id: entry.owner, wrapper });

    // Kick loading async; each viewer renders itself once its GPU
    // buffers are built. Layer propagation happens post-load so every
    // descendant (including buffers created during load) gets tagged.
    viewer
      .addSplatScenes([
        {
          path: entry.uri,
          splatAlphaRemovalThreshold: 5,
          showLoadingUI: false,
        },
      ])
      .then(() => propagateLayer(viewer, layer))
      .catch((err) => console.error('[splat-loader] sub addSplatScenes failed', entry.owner, err));
  }

  activeSplatRoot = root;
  return { status: 'ready', split: true, sub_count: entries.length };
}

/**
 * Register a splatLoader with the scan-pane viewer. The callback gets
 * `{ uri, splitManifestUri, scene, camera, layer, THREE }` from setSplat().
 * When a split manifest is provided we load N sub-splats (one per object
 * plus a shell); otherwise we fall back to a single-splat load.
 */
export async function loadSplatIntoScene(opts) {
  const { uri, splitManifestUri, scene, layer, THREE } = opts;
  disposeActive(scene);

  if (splitManifestUri) {
    try {
      const result = await loadSplitSplats({ splitManifestUri, scene, layer, THREE });
      if (result) return result;
    } catch (err) {
      console.warn('[splat-loader] split-load failed, falling back to single', err);
    }
  }
  return loadSingleSplat({ uri, scene, layer });
}

/**
 * Convenience helper that installs the loader on a scan-pane view.
 * Called once when the scan pane is created.
 */
export function installSplatLoader(scanView) {
  if (!scanView || typeof scanView.setSplatLoader !== 'function') return false;
  scanView.setSplatLoader(loadSplatIntoScene);
  if (typeof scanView.setSplatViewerGetter === 'function') {
    scanView.setSplatViewerGetter(getActiveSplatViewer);
  }
  return true;
}
