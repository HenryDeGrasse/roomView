import type { AssetManifestResponse, QuickRenderResponse, Scene } from "../../../packages/contracts/src/index.ts";
import {
  buildDeterministicQuickRender,
  CURATED_ASSET_MANIFEST,
} from "../../../packages/contracts/src/index.ts";

export function createAssetManifestResponse(): AssetManifestResponse {
  return {
    manifest: CURATED_ASSET_MANIFEST,
  };
}

export function createQuickRenderResponse(scene: Scene): QuickRenderResponse {
  const render_scene = buildDeterministicQuickRender(scene, CURATED_ASSET_MANIFEST);
  for (const miss of render_scene.diagnostics.fallback_misses) {
    console.warn(
      `[quick-render:fallback] scene=${render_scene.scene_id} version=${render_scene.scene_version} bound_to=${miss.bound_to} requested=${miss.requested_asset_id ?? "<none>"} resolved=${miss.resolved_asset_id} reason=${miss.reason}`
    );
  }
  return { render_scene };
}
