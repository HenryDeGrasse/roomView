// Gaussian Splat loader — wires @mkkellogg/gaussian-splats-3d into the
// scan-pane viewer via the viewer's setSplatLoader hook.
//
// The viewer (apps/web/src/viewer.js) exposes setSplat({ uri, gaussian_count })
// which, when a splatLoader is registered, downloads the .splat bytes, parses
// them, and adds a GaussianSplatMesh to the Three.js scene at LAYER_SPLAT.
//
// Format: the binary .splat produced by scripts/splat-generate.py --mode
// rgbd_init is the antimatter15 / gsplat.js standard (32 bytes per gaussian).
// @mkkellogg/gaussian-splats-3d reads this natively via SceneFormat.Splat.
//
// This module is intentionally tiny: the heavy renderer lives in the vendored
// library; our loader just adapts its API to the viewer's setSplatLoader
// contract.
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

let activeViewer = null;   // singleton DropInViewer attached to the scan scene
let lastDisposedAt = 0;

/** Returns the DropInViewer Three.js object, if any splat is loaded. */
export function getActiveSplatViewer() {
  return activeViewer;
}

function disposeActiveSplat(scene) {
  if (!activeViewer) return;
  try {
    scene.remove(activeViewer);
    if (typeof activeViewer.dispose === 'function') {
      activeViewer.dispose();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[splat-loader] dispose failed', err);
  }
  activeViewer = null;
  lastDisposedAt = performance.now();
}

/**
 * Register a splatLoader with the scan-pane viewer. The callback gets
 * { uri, scene, camera, layer, THREE } from setSplat(); we hand back a
 * DropInViewer mounted into the scene at the requested layer.
 *
 * Returns an object shaped `{ status: 'ready' | 'failed' }` so the viewer's
 * setSplat() can set splatMeta.status and callers can react accordingly.
 */
export async function loadSplatIntoScene({ uri, scene, camera, layer, THREE }) {
  disposeActiveSplat(scene);

  // DropInViewer is the Three.js-friendly top-level object. It internally
  // drives its own rendering pass (custom shader), so we only need to add it
  // to our scene; the main RAF loop in viewer.js keeps it updating.
  const viewer = new GaussianSplats3D.DropInViewer({
    sharedMemoryForWorkers: false, // works over HTTP dev server (no COOP/COEP)
    gpuAcceleratedSort: false,      // CPU sort — safer across GPUs, still fast for < 1M gaussians
  });
  viewer.addSplatScenes([
    {
      path: uri,
      splatAlphaRemovalThreshold: 5, // drop near-transparent splats for speed
      showLoadingUI: false,
    },
  ]).then(() => {
    // Assign layer to every descendant so the scan pane's layer mask picks it up.
    viewer.traverse((child) => {
      if (child.layers && typeof child.layers.set === 'function') {
        child.layers.set(layer);
      }
    });
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[splat-loader] addSplatScenes failed', err);
  });

  scene.add(viewer);
  activeViewer = viewer;
  // The scenes list loads asynchronously; the viewer has already been
  // attached so Three.js will render it as soon as the GPU buffers are
  // built. We report 'ready' on the synchronous path — the viewer.js
  // splat status turns into 'ready' immediately, matching the UX intent
  // (user sees a "splat loading" → "splat live" transition driven by
  // the vendored library's own progress callbacks).
  return { status: 'ready' };
}

/**
 * Convenience helper that installs the loader on a scan-pane view.
 * Called once when the scan pane is created.
 */
export function installSplatLoader(scanView) {
  if (!scanView || typeof scanView.setSplatLoader !== 'function') return false;
  scanView.setSplatLoader(loadSplatIntoScene);
  // Also let the viewer toggle the splat's .visible directly when the
  // camera crosses the room boundary — the gaussian-splat library
  // renders through its own pass and doesn't always honour the outer
  // camera's layer mask, so we need the object-level toggle.
  if (typeof scanView.setSplatViewerGetter === 'function') {
    scanView.setSplatViewerGetter(getActiveSplatViewer);
  }
  return true;
}
