import { createServer, type Server, type ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { FixtureManifest, FixtureDescriptor, QuickRenderResponse, SceneReadResponse } from "../../../packages/contracts/src/index.ts";
import {
  buildDeterministicQuickRender,
  CURATED_ASSET_MANIFEST,
} from "../../../packages/contracts/src/index.ts";

const serverDir = dirname(fileURLToPath(import.meta.url));
const webAppRoot = resolve(serverDir, "..");
const repoRoot = resolve(serverDir, "..", "..", "..");
const viewerModulePath = resolve(serverDir, "viewer.js");
const layoutViewModulePath = resolve(serverDir, "layout-view.js");
const scanProxiesModulePath = resolve(serverDir, "scan-proxies.js");
const splatLoaderModulePath = resolve(serverDir, "splat-loader.js");
const designTokensPath = resolve(serverDir, "design-tokens.css");
const vendorThreeRoot = resolve(webAppRoot, "public", "vendor", "three");
const vendorModelsRoot = resolve(webAppRoot, "public", "vendor", "models");
const vendorGaussianSplatsRoot = resolve(webAppRoot, "public", "vendor", "gaussian-splats-3d");
const DEFAULT_FIXTURE_SCENE_ID = "fixture-bedroom-primary";
const DEFAULT_FIXTURE_MANIFEST_PATH = "fixtures/manifest.json";
export const DEFAULT_WEB_EDITOR_PORT = 4173;

export interface EditorFixtureSource {
  fixture_id: string;
  notes: string;
}

interface EditorFixtureRecord extends EditorFixtureSource {
  scene_response: SceneReadResponse;
  quick_render_response: QuickRenderResponse;
}

export interface RoomViewEditorServerOptions {
  default_api_base_url?: string;
}

export function createRoomViewEditorServer(options: RoomViewEditorServerOptions = {}): Server {
  const fixtures = loadFixtureScenes();
  const fixtureSources: EditorFixtureSource[] = fixtures.map(({ fixture_id, notes }) => ({ fixture_id, notes }));
  const defaultApiBaseUrl = options.default_api_base_url ?? "http://127.0.0.1:3000";

  return createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && requestUrl.pathname === "/") {
      sendHtml(response, renderEditorShellHtml({ defaultApiBaseUrl, fixtureSources }));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/viewer.js") {
      sendStaticFile(response, viewerModulePath, "application/javascript; charset=utf-8");
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/layout-view.js") {
      sendStaticFile(response, layoutViewModulePath, "application/javascript; charset=utf-8");
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/scan-proxies.js") {
      sendStaticFile(response, scanProxiesModulePath, "application/javascript; charset=utf-8");
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/splat-loader.js") {
      sendStaticFile(response, splatLoaderModulePath, "application/javascript; charset=utf-8");
      return;
    }

    if (request.method === "GET" && requestUrl.pathname.startsWith("/vendor/gaussian-splats-3d/")) {
      const rel = requestUrl.pathname.slice("/vendor/gaussian-splats-3d/".length);
      const resolved = resolve(vendorGaussianSplatsRoot, rel);
      if (!resolved.startsWith(vendorGaussianSplatsRoot + sep) && resolved !== vendorGaussianSplatsRoot) {
        sendJson(response, 400, { message: "Invalid vendor path." });
        return;
      }
      sendStaticFile(response, resolved, "application/javascript; charset=utf-8");
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/design-tokens.css") {
      sendStaticFile(response, designTokensPath, "text/css; charset=utf-8");
      return;
    }

    if (request.method === "GET" && requestUrl.pathname.startsWith("/vendor/three/")) {
      const rel = requestUrl.pathname.slice("/vendor/three/".length);
      const resolved = resolve(vendorThreeRoot, rel);
      if (!resolved.startsWith(vendorThreeRoot + sep) && resolved !== vendorThreeRoot) {
        sendJson(response, 400, { message: "Invalid vendor path." });
        return;
      }
      sendStaticFile(response, resolved, "application/javascript; charset=utf-8");
      return;
    }

    if (request.method === "GET" && requestUrl.pathname.startsWith("/vendor/models/")) {
      const rel = requestUrl.pathname.slice("/vendor/models/".length);
      const resolved = resolve(vendorModelsRoot, rel);
      if (!resolved.startsWith(vendorModelsRoot + sep) && resolved !== vendorModelsRoot) {
        sendJson(response, 400, { message: "Invalid vendor path." });
        return;
      }
      const ct = resolved.endsWith('.gltf') ? 'model/gltf+json' : 'model/gltf-binary';
      sendStaticFile(response, resolved, ct);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/dev/fixtures") {
      sendJson(response, 200, { fixtures: fixtureSources });
      return;
    }

    if (request.method === "GET") {
      const frameRequest = extractFixtureFrameRequest(requestUrl.pathname);
      if (frameRequest) {
        const fixture = fixtures.find((candidate) => candidate.fixture_id === frameRequest.fixture_id);
        if (!fixture) {
          sendJson(response, 404, { message: `Fixture ${frameRequest.fixture_id} was not found.` });
          return;
        }
        const fixtureDir = resolve(repoRoot, "fixtures", "roomplan", frameRequest.fixture_id, "frames");
        const resolved = resolve(fixtureDir, frameRequest.file);
        if (!resolved.startsWith(fixtureDir + sep) && resolved !== fixtureDir) {
          sendJson(response, 400, { message: "Invalid frame path." });
          return;
        }
        sendStaticFile(response, resolved, fixtureFrameContentType(frameRequest.file));
        return;
      }

      const meshRequest = extractFixtureMeshRequest(requestUrl.pathname);
      if (meshRequest) {
        const fixture = fixtures.find((candidate) => candidate.fixture_id === meshRequest.fixture_id);
        if (!fixture) {
          sendJson(response, 404, { message: `Fixture ${meshRequest.fixture_id} was not found.` });
          return;
        }
        const fixtureDir = resolve(repoRoot, "fixtures", "roomplan", meshRequest.fixture_id, "meshes");
        const resolved = resolve(fixtureDir, meshRequest.file);
        if (!resolved.startsWith(fixtureDir + sep) && resolved !== fixtureDir) {
          sendJson(response, 400, { message: "Invalid mesh path." });
          return;
        }
        sendStaticFile(response, resolved, fixtureMeshContentType(meshRequest.file));
        return;
      }

      const splatRequest = extractFixtureSplatRequest(requestUrl.pathname);
      if (splatRequest) {
        const fixture = fixtures.find((candidate) => candidate.fixture_id === splatRequest.fixture_id);
        if (!fixture) {
          sendJson(response, 404, { message: `Fixture ${splatRequest.fixture_id} was not found.` });
          return;
        }
        const fixtureDir = resolve(repoRoot, "fixtures", "roomplan", splatRequest.fixture_id, "splats");
        const resolved = resolve(fixtureDir, splatRequest.file);
        if (!resolved.startsWith(fixtureDir + sep) && resolved !== fixtureDir) {
          sendJson(response, 400, { message: "Invalid splat path." });
          return;
        }
        sendStaticFile(response, resolved, fixtureSplatContentType(splatRequest.file));
        return;
      }
    }

    const fixtureId = extractFixtureId(requestUrl.pathname);
    if (request.method === "GET" && fixtureId) {
      const fixture = fixtures.find((candidate) => candidate.fixture_id === fixtureId);
      if (!fixture) {
        sendJson(response, 404, { message: `Fixture ${fixtureId} was not found.` });
        return;
      }
      if (requestUrl.pathname.endsWith("/quick-render")) {
        sendJson(response, 200, fixture.quick_render_response);
        return;
      }
      sendJson(response, 200, fixture.scene_response);
      return;
    }

    sendJson(response, 404, { message: "Not found." });
  });
}

function extractFixtureId(pathname: string): string | null {
  const exactMatch = pathname.match(/^\/dev\/fixtures\/([^/]+)$/);
  if (exactMatch) {
    return decodeURIComponent(exactMatch[1]);
  }
  const quickRenderMatch = pathname.match(/^\/dev\/fixtures\/([^/]+)\/quick-render$/);
  return quickRenderMatch ? decodeURIComponent(quickRenderMatch[1]) : null;
}

function extractFixtureFrameRequest(pathname: string): { fixture_id: string; file: string } | null {
  const match = pathname.match(/^\/dev\/fixtures\/([^/]+)\/frames\/([^/]+)$/);
  if (!match) return null;
  return { fixture_id: decodeURIComponent(match[1]), file: decodeURIComponent(match[2]) };
}

function extractFixtureMeshRequest(pathname: string): { fixture_id: string; file: string } | null {
  const match = pathname.match(/^\/dev\/fixtures\/([^/]+)\/meshes\/([^/]+)$/);
  if (!match) return null;
  return { fixture_id: decodeURIComponent(match[1]), file: decodeURIComponent(match[2]) };
}

function extractFixtureSplatRequest(pathname: string): { fixture_id: string; file: string } | null {
  const match = pathname.match(/^\/dev\/fixtures\/([^/]+)\/splats\/([^/]+)$/);
  if (!match) return null;
  return { fixture_id: decodeURIComponent(match[1]), file: decodeURIComponent(match[2]) };
}

function fixtureFrameContentType(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".npy")) return "application/x-numpy";
  return "application/octet-stream";
}

function fixtureMeshContentType(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".ply")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function fixtureSplatContentType(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".splat")) return "application/octet-stream";
  if (lower.endsWith(".ply")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function loadFixtureScenes(): EditorFixtureRecord[] {
  const manifestPath = resolve(repoRoot, DEFAULT_FIXTURE_MANIFEST_PATH);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as FixtureManifest;

  return manifest.fixtures.map((fixture) => {
    const scene = readFixtureScene(fixture);
    return {
      fixture_id: fixture.fixture_id,
      notes: fixture.notes,
      scene_response: {
        scene,
      },
      quick_render_response: {
        render_scene: buildDeterministicQuickRender(scene, CURATED_ASSET_MANIFEST),
      },
    };
  });
}

function readFixtureScene(fixture: FixtureDescriptor): SceneReadResponse["scene"] {
  return JSON.parse(readFileSync(resolve(repoRoot, fixture.scene_path), "utf8")) as SceneReadResponse["scene"];
}

function renderEditorShellHtml(input: {
  defaultApiBaseUrl: string;
  fixtureSources: EditorFixtureSource[];
}): string {
  const bootstrapJson = safeJson({
    defaultApiBaseUrl: input.defaultApiBaseUrl,
    defaultFixtureId: DEFAULT_FIXTURE_SCENE_ID,
    fixtureSources: input.fixtureSources,
    curatedAssetManifest: CURATED_ASSET_MANIFEST,
  });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>RoomView MVP Editor</title>
    <script type="importmap">
      {
        "imports": {
          "three": "/vendor/three/three.module.js",
          "three/addons/": "/vendor/three/addons/",
          "@mkkellogg/gaussian-splats-3d": "/vendor/gaussian-splats-3d/gaussian-splats-3d.module.js"
        }
      }
    </script>
    <link rel="stylesheet" href="/design-tokens.css" />
  </head>
  <body>
    <header>
      <h1>RoomView MVP Editor</h1>
      <p>Redeem a one-time handoff or load a golden fixture. All pane content comes from server-supplied canonical scene JSON.</p>
      <div class="toolbar">
        <section class="card">
          <h2>Live API handoff</h2>
          <label for="api-base-url">API base URL</label>
          <input id="api-base-url" type="url" placeholder="http://127.0.0.1:3000" />
          <label for="handoff-input">Handoff token / handoff URL / QR payload JSON</label>
          <textarea id="handoff-input" placeholder="Paste a handoff token, https://.../handoff_token, or the qr_payload JSON"></textarea>
          <div class="actions">
            <button id="redeem-button" type="button">Redeem and load scene</button>
          </div>
        </section>
        <section class="card">
          <h2>Fixture-backed local load</h2>
          <label for="fixture-select">Fixture</label>
          <select id="fixture-select"></select>
          <div class="actions">
            <button id="fixture-button" class="secondary" type="button">Load local fixture</button>
          </div>
        </section>
        <section class="card">
          <h2>Chat planner</h2>
          <p class="muted">Use layout selection as context for prompts like “this wall” or “that chair.” Live API sessions auto-apply validated edits and keep Undo one click away.</p>
          <label for="chat-selection">Current selection</label>
          <div id="chat-selection" class="chat-selection">No scene loaded.</div>
          <label for="chat-input">Prompt</label>
          <textarea id="chat-input" placeholder="Try: move the desk under the window"></textarea>
          <div class="actions">
            <button id="chat-send-button" type="button">Plan from chat</button>
            <button id="undo-button" class="secondary" type="button">Undo last change</button>
            <button id="chat-clear-button" class="secondary" type="button">Clear thread</button>
          </div>
          <div id="chat-options" class="list"></div>
          <div id="chat-thread" class="chat-thread"></div>
        </section>
      </div>
    </header>

    <div id="toast-region" aria-live="polite" aria-atomic="true"></div>

    <main>
      <section class="pane">
        <header>
          <h2>Scan pane</h2>
          <p>Read-only capture preview (RoomPlan shell or splat sidecar) and scan summary.</p>
        </header>
        <div id="scan-pane" class="pane-body"></div>
      </section>
      <section class="pane">
        <header>
          <h2>Layout pane</h2>
          <p>Server-authored surfaces, openings, and objects with selection state.</p>
        </header>
        <div id="layout-pane" class="pane-body"></div>
      </section>
      <section class="pane">
        <header>
          <h2>Render pane</h2>
          <p>Derived cache, bookmarks, asset refs, and quick-render inputs.</p>
        </header>
        <div id="render-pane" class="pane-body"></div>
      </section>
    </main>

    <script id="roomview-bootstrap" type="application/json">${bootstrapJson}</script>
    <script>
      const bootstrap = JSON.parse(document.getElementById("roomview-bootstrap").textContent);
      function createClientRequestNamespace() {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
          return globalThis.crypto.randomUUID();
        }
        return "rv-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      }
      const state = {
        apiBaseUrl: bootstrap.defaultApiBaseUrl,
        scene: null,
        quickRender: null,
        sceneId: null,
        sessionId: null,
        selectionId: null,
        activeBookmarkId: null,
        lastPhotorealJobId: null,
        splatPollHandle: null,
        loadedFrom: null,
        chatMessages: [],
        pendingPlannerResponse: null,
        requestCounter: 0,
        clientRequestNamespace: createClientRequestNamespace(),
        sceneActionInFlight: false,
        dragPreviewRoom: null,
        dragPreviewSyncHandle: null,
        dragPreviewLastSyncedAt: 0,
        viewer: null,
        viewerLoading: null,
        layoutView: null,
        layoutViewLoading: null,
        scanView: null,
        scanViewLoading: null,
        scanProxiesSnapshotId: null,
        scanProxiesLoading: null,
      };

      const toastRegion = document.getElementById("toast-region");
      const scanPane = document.getElementById("scan-pane");
      const layoutPane = document.getElementById("layout-pane");
      const renderPane = document.getElementById("render-pane");
      const apiBaseUrlInput = document.getElementById("api-base-url");
      const handoffInput = document.getElementById("handoff-input");
      const fixtureSelect = document.getElementById("fixture-select");
      const redeemButton = document.getElementById("redeem-button");
      const fixtureButton = document.getElementById("fixture-button");
      const chatSelection = document.getElementById("chat-selection");
      const chatInput = document.getElementById("chat-input");
      const chatSendButton = document.getElementById("chat-send-button");
      const undoButton = document.getElementById("undo-button");
      const chatClearButton = document.getElementById("chat-clear-button");
      const chatOptions = document.getElementById("chat-options");
      const chatThread = document.getElementById("chat-thread");

      apiBaseUrlInput.value = state.apiBaseUrl;
      for (const fixture of bootstrap.fixtureSources) {
        const option = document.createElement("option");
        option.value = fixture.fixture_id;
        option.textContent = fixture.notes ? fixture.fixture_id + " — " + fixture.notes : fixture.fixture_id;
        if (fixture.fixture_id === bootstrap.defaultFixtureId) {
          option.selected = true;
        }
        fixtureSelect.appendChild(option);
      }

      redeemButton.addEventListener("click", async () => {
        try {
          state.apiBaseUrl = apiBaseUrlInput.value.trim() || bootstrap.defaultApiBaseUrl;
          const handoffToken = parseHandoffToken(handoffInput.value);
          if (!handoffToken) {
            throw new Error("Paste a handoff token, handoff URL, or qr_payload JSON first.");
          }
          setStatus("Redeeming handoff…");
          const redeemResponse = await postJson(new URL("/handoffs/redeem", state.apiBaseUrl).toString(), {
            handoff_token: handoffToken,
          });
          state.sessionId = redeemResponse.session_id;
          state.sceneId = redeemResponse.scene_id;
          state.loadedFrom = "live";
          clearSplatPolling();
          resetChatState();
          await loadLiveScene();
        } catch (error) {
          setStatus(error.message || "Failed to redeem handoff.", true);
        }
      });

      fixtureButton.addEventListener("click", async () => {
        try {
          stopDragPreview({ restoreCanonical: false });
          setStatus("Loading development fixture…");
          const response = await fetch("/dev/fixtures/" + encodeURIComponent(fixtureSelect.value));
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.message || "Fixture load failed.");
          }
          state.scene = payload.scene;
          state.sceneId = payload.scene.head.scene_id;
          state.sessionId = null;
          state.selectionId = normalizeSelectionId(state.scene, state.selectionId);
          state.activeBookmarkId = state.scene.bookmarks[0]?.bookmark_id || null;
          state.loadedFrom = "fixture";
          state.quickRender = await loadFixtureQuickRender(fixtureSelect.value);
          clearSplatPolling();
          resetChatState();
          renderScene();
          setStatus("Loaded fixture " + fixtureSelect.value + ".");
        } catch (error) {
          setStatus(error.message || "Failed to load fixture.", true);
        }
      });

      scanPane.addEventListener("click", (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (!target) return;
        const viewpointCard = target.closest("button.viewpoint-card");
        if (viewpointCard) {
          event.preventDefault();
          handleViewpointClick(viewpointCard);
          return;
        }
        const flythroughButton = target.closest("#scan-flythrough");
        if (flythroughButton) {
          event.preventDefault();
          handleFlythroughClick();
        }
      });

      function handleViewpointClick(buttonElement) {
        if (!state.scanView || typeof state.scanView.flyToPose !== "function") return;
        const poseRaw = buttonElement.getAttribute("data-viewpoint-pose");
        if (!poseRaw) return;
        let pose;
        try { pose = JSON.parse(poseRaw); } catch { pose = null; }
        if (!pose || typeof pose !== "object") return;
        const fovAttr = buttonElement.getAttribute("data-viewpoint-fov");
        const fov = fovAttr ? Number.parseFloat(fovAttr) : null;
        const options = fov && Number.isFinite(fov) ? { duration_ms: 900, fov } : { duration_ms: 900 };
        state.scanView.flyToPose(pose, options).catch((err) => console.error("flyToPose failed", err));
      }

      async function handleFlythroughClick() {
        if (!state.scanView || typeof state.scanView.flyThroughPoses !== "function") return;
        const frames = Array.isArray(state.scene?.captured_frames) ? state.scene.captured_frames : [];
        if (frames.length === 0) return;
        const button = document.getElementById("scan-flythrough");
        if (button) button.setAttribute("disabled", "disabled");
        try {
          await state.scanView.flyThroughPoses(
            frames.map((frame) => frame.camera_pose).filter((pose) => pose && typeof pose === "object"),
            { duration_ms: 900, dwell_ms: 600 },
          );
        } catch (err) {
          console.error("flyThroughPoses failed", err);
        } finally {
          if (button) button.removeAttribute("disabled");
        }
      }

      layoutPane.tabIndex = 0;
      layoutPane.addEventListener("pointerdown", () => {
        layoutPane.focus({ preventScroll: true });
      });

      layoutPane.addEventListener("click", (event) => {
        const actionButton = event.target instanceof HTMLElement ? event.target.closest("button[data-layout-action]") : null;
        if (actionButton) {
          const action = actionButton.getAttribute("data-layout-action");
          if (action === "size-up") {
            void resizeSelectedObject(1.15);
            return;
          }
          if (action === "size-down") {
            void resizeSelectedObject(0.85);
            return;
          }
          if (action === "rotate-ccw") {
            void rotateSelectedObject(-15);
            return;
          }
          if (action === "rotate-cw") {
            void rotateSelectedObject(15);
            return;
          }
        }
        const button = event.target instanceof HTMLElement ? event.target.closest("button[data-entity-id]") : null;
        if (!button) {
          return;
        }
        setSelection(button.getAttribute("data-entity-id"));
      });

      layoutPane.addEventListener("keydown", (event) => {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditableTextTarget(event.target)) {
          return;
        }
        const step = event.shiftKey ? 0.25 : 0.1;
        if (event.key === "ArrowUp") {
          event.preventDefault();
          void moveSelectedObjectBy({ x: 0, y: step, z: 0 });
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          void moveSelectedObjectBy({ x: 0, y: -step, z: 0 });
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          void moveSelectedObjectBy({ x: -step, y: 0, z: 0 });
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          void moveSelectedObjectBy({ x: step, y: 0, z: 0 });
          return;
        }
        if (event.key === "q" || event.key === "Q" || event.key === "[") {
          event.preventDefault();
          void rotateSelectedObject(-15);
          return;
        }
        if (event.key === "e" || event.key === "E" || event.key === "]") {
          event.preventDefault();
          void rotateSelectedObject(15);
          return;
        }
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          void resizeSelectedObject(1.15);
          return;
        }
        if (event.key === "-" || event.key === "_") {
          event.preventDefault();
          void resizeSelectedObject(0.85);
        }
      });

      layoutPane.addEventListener("wheel", (event) => {
        if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || !state.sessionId) {
          return;
        }
        const targetObject = event.target instanceof Element ? event.target.closest("[data-object-id]") : null;
        const objectId = targetObject ? targetObject.getAttribute("data-object-id") : null;
        if (!objectId) {
          return;
        }
        if (state.selectionId !== objectId) {
          setSelection(objectId);
        }
        event.preventDefault();
        void rotateSelectedObject(event.deltaY < 0 ? 15 : -15);
      }, { passive: false });

      renderPane.addEventListener("input", (event) => {
        const target = event.target instanceof HTMLInputElement ? event.target : null;
        if (!target || !target.classList.contains("before-after__range")) return;
        const container = target.closest(".before-after");
        if (!container) return;
        const value = Math.max(0, Math.min(100, Number(target.value) || 0));
        container.style.setProperty("--reveal", value + "%");
      });

      // Track C — live OBB preview on material-card hover.
      // Hovering a material card paints a preview outline on every OBB of the
      // same object_class in the layout pane, so the user can see *what* would
      // change before committing to the prompt. Pure CSS highlight, toggled by
      // a data-preview-class attribute on the layout-svg-mount element.
      renderPane.addEventListener("mouseenter", (event) => {
        const target = event.target instanceof HTMLElement ? event.target.closest("button.material-card") : null;
        if (!target) return;
        const cls = target.getAttribute("data-material-class");
        const layoutMount = document.getElementById("layout-svg-mount");
        if (cls && layoutMount) {
          layoutMount.setAttribute("data-preview-class", cls);
        }
      }, true);
      renderPane.addEventListener("mouseleave", (event) => {
        const target = event.target instanceof HTMLElement ? event.target.closest("button.material-card") : null;
        if (!target) return;
        const layoutMount = document.getElementById("layout-svg-mount");
        if (layoutMount) layoutMount.removeAttribute("data-preview-class");
      }, true);

      renderPane.addEventListener("click", (event) => {
        const actionButton = event.target instanceof HTMLElement ? event.target.closest("button[data-render-action]") : null;
        if (actionButton) {
          const action = actionButton.getAttribute("data-render-action");
          if (action === "save-bookmark") {
            void saveActiveBookmark();
            return;
          }
          if (action === "generate-photoreal") {
            void generatePhotorealFromActiveBookmark();
            return;
          }
          if (action === "generate-style-grid") {
            void generatePhotorealStyleGrid();
            return;
          }
        }
        const bookmarkButton = event.target instanceof HTMLElement ? event.target.closest("button[data-bookmark-id]") : null;
        if (bookmarkButton) {
          state.activeBookmarkId = bookmarkButton.getAttribute("data-bookmark-id");
          renderScene();
          return;
        }
        const materialCard = event.target instanceof HTMLElement ? event.target.closest("button.material-card") : null;
        if (materialCard) {
          event.preventDefault();
          const prompt = materialCard.getAttribute("data-material-prompt") || "";
          if (prompt && chatInput) {
            const existing = chatInput.value.trim();
            chatInput.value = existing ? existing + "\\n" + prompt : prompt;
            chatInput.focus();
            showToast({
              message: "Added '" + prompt + "' to the chat prompt.",
              level: "success",
              duration_ms: 3200,
            });
          }
        }
      });

      chatSendButton.addEventListener("click", () => {
        void submitChatPrompt(chatInput.value);
      });

      chatClearButton.addEventListener("click", () => {
        resetChatState();
        renderChatPanel();
      });

      undoButton.addEventListener("click", () => {
        void undoLastChange("toolbar");
      });

      chatOptions.addEventListener("click", (event) => {
        const button = event.target instanceof HTMLElement ? event.target.closest("button[data-chat-option]") : null;
        if (!button) {
          return;
        }
        chatInput.value = button.getAttribute("data-chat-option") || "";
        void submitChatPrompt(chatInput.value);
      });

      const params = new URLSearchParams(window.location.search);
      const queryApiBaseUrl = params.get("api_base_url");
      if (queryApiBaseUrl) {
        state.apiBaseUrl = queryApiBaseUrl;
        apiBaseUrlInput.value = queryApiBaseUrl;
      }

      if (params.get("fixture_id")) {
        fixtureSelect.value = params.get("fixture_id");
        void fixtureButton.click();
      } else if (params.get("handoff_token") || params.get("handoff_url")) {
        handoffInput.value = params.get("handoff_token") || params.get("handoff_url");
        void redeemButton.click();
      } else {
        renderEmptyState();
      }

      async function loadLiveScene() {
        stopDragPreview({ restoreCanonical: false });
        const scene = await fetchLiveScene();
        state.scene = scene;
        state.selectionId = normalizeSelectionId(state.scene, state.selectionId);
        state.activeBookmarkId = state.scene.bookmarks.some((bookmark) => bookmark.bookmark_id === state.activeBookmarkId)
          ? state.activeBookmarkId
          : state.scene.bookmarks[0]?.bookmark_id || null;
        state.quickRender = await loadLiveQuickRender();
        renderScene();
        setStatus("Loaded live scene " + state.scene.head.scene_id + " via authenticated read.");
      }

      async function fetchLiveScene() {
        const response = await fetch(new URL("/scenes/" + encodeURIComponent(state.sceneId), state.apiBaseUrl).toString(), {
          headers: {
            Authorization: "Bearer " + state.sessionId,
          },
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.message || payload.reason_code || "Scene read failed.");
        }
        return payload.scene;
      }

      async function refreshLiveSceneForSplat() {
        if (!state.sceneId || !state.sessionId) {
          return;
        }
        stopDragPreview({ restoreCanonical: false });
        const selectionId = state.selectionId;
        const activeBookmarkId = state.activeBookmarkId;
        const scene = await fetchLiveScene();
        state.scene = scene;
        state.selectionId = normalizeSelectionId(scene, selectionId);
        state.activeBookmarkId = scene.bookmarks.some((bookmark) => bookmark.bookmark_id === activeBookmarkId)
          ? activeBookmarkId
          : scene.bookmarks[0]?.bookmark_id || null;
      }

      async function loadLiveQuickRender() {
        const response = await fetch(new URL("/scenes/" + encodeURIComponent(state.sceneId) + "/quick-render", state.apiBaseUrl).toString(), {
          headers: {
            Authorization: "Bearer " + state.sessionId,
          },
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.message || payload.reason_code || "Quick render read failed.");
        }
        return payload.render_scene;
      }

      async function loadFixtureQuickRender(fixtureId) {
        const response = await fetch("/dev/fixtures/" + encodeURIComponent(fixtureId) + "/quick-render");
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.message || "Fixture quick render failed.");
        }
        return payload.render_scene;
      }

      async function postJson(url, body, headers = {}) {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify(body),
        });
        const payload = await response.json();
        if (!response.ok) {
          const error = new Error(payload.message || payload.reason_code || "Request failed.");
          error.reasonCode = payload.reason_code || null;
          throw error;
        }
        return payload;
      }

      async function postSceneJson(pathname, body) {
        if (!state.sessionId) {
          throw new Error("Live scene actions require a redeemed API handoff.");
        }
        return postJson(new URL(pathname, state.apiBaseUrl).toString(), body, {
          Authorization: "Bearer " + state.sessionId,
        });
      }

      async function getSceneJson(pathname) {
        if (!state.sessionId) {
          throw new Error("Live scene actions require a redeemed API handoff.");
        }
        const response = await fetch(new URL(pathname, state.apiBaseUrl).toString(), {
          headers: {
            Authorization: "Bearer " + state.sessionId,
          },
        });
        const payload = await response.json();
        if (!response.ok) {
          const error = new Error(payload.message || payload.reason_code || "Request failed.");
          error.reasonCode = payload.reason_code || null;
          throw error;
        }
        return payload;
      }

      function upsertGalleryEntry(entry) {
        if (!state.scene || !entry || !entry.entry_id) return;
        const existingIndex = state.scene.photoreal_gallery.findIndex((candidate) => candidate.entry_id === entry.entry_id);
        if (existingIndex >= 0) {
          state.scene.photoreal_gallery[existingIndex] = entry;
        } else {
          state.scene.photoreal_gallery = [...state.scene.photoreal_gallery, entry];
        }
      }

      function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      async function waitForPhotorealJob(jobId, options) {
        const timeoutMs = options && options.timeoutMs ? options.timeoutMs : 120000;
        const intervalMs = options && options.intervalMs ? options.intervalMs : 1500;
        const startedAt = Date.now();
        while (true) {
          const jobResponse = await getSceneJson('/jobs/' + encodeURIComponent(jobId));
          if (jobResponse.photoreal_entry) {
            upsertGalleryEntry(jobResponse.photoreal_entry);
          }
          if (jobResponse.job.status === 'ready' || jobResponse.job.status === 'failed') {
            return jobResponse;
          }
          if ((Date.now() - startedAt) >= timeoutMs) {
            throw new Error('Timed out waiting for photoreal job ' + jobId + '.');
          }
          await sleep(intervalMs);
        }
      }

      function resolveGalleryImageUrl(providerUri) {
        if (typeof providerUri !== 'string' || providerUri.length === 0) return null;
        if (providerUri.startsWith('data:')) return providerUri;
        if (providerUri.startsWith('/')) {
          return new URL(providerUri, state.apiBaseUrl).toString();
        }
        if (providerUri.startsWith('http://') || providerUri.startsWith('https://')) {
          return providerUri;
        }
        return null;
      }

      // Showcase Track C — gallery entry renderer.
      // When a photoreal entry carries captured_frame_id (Showcase flux_inpaint_stack
      // path) we pair it with the reference RGB from the captured frame and render a
      // before/after slider. Legacy synthetic-conditioning entries fall back to the
      // single-image layout.
      function renderGalleryEntry(entry, scene) {
        const providerUri = entry.provider_metadata?.uri || '<none>';
        const imageUrl = resolveGalleryImageUrl(entry.provider_metadata?.uri || null);
        const providerStatus = entry.provider_metadata?.status || 'ready';
        const styleTag = Array.isArray(entry.prompt_modifiers) && entry.prompt_modifiers.length > 0
          ? entry.prompt_modifiers.join(', ')
          : null;
        const styleBadge = styleTag
          ? '<div class="badge warm">' + escapeHtml(styleTag) + '</div>'
          : '';
        const capturedFrame = entry.captured_frame_id
          ? (scene.captured_frames || []).find((frame) => frame.frame_id === entry.captured_frame_id) || null
          : null;
        const referenceUrl = capturedFrame ? resolveGalleryImageUrl(capturedFrame.rgb?.uri || null) : null;

        const visualHtml = imageUrl && referenceUrl
          ? renderBeforeAfter(imageUrl, referenceUrl, entry.entry_id)
          : imageUrl
            ? '<img class="gallery-item__image" src="' + escapeHtml(imageUrl) + '" alt="Photoreal render ' + escapeHtml(entry.entry_id) + '" />'
            : '';

        const metadataPre = '<pre>' + escapeHtml(JSON.stringify({
          scene_version: entry.scene_version,
          scene_snapshot_id: entry.scene_snapshot_id,
          bookmark_id: entry.bookmark_id,
          asset_id: entry.asset_id,
          provider_uri: providerUri,
          created_at: entry.created_at,
          render_group_id: entry.render_group_id || undefined,
          captured_frame_id: entry.captured_frame_id || undefined,
        }, null, 2)) + '</pre>';

        const materialsHtml = renderPinnedMaterialsList(entry, scene);
        const statusBadge = '<div class="badge">' + escapeHtml(String(providerStatus)) + '</div>';
        const headerBadges = [styleBadge, statusBadge].filter(Boolean).join('');
        return '<div class="gallery-item">'
          + '<div class="gallery-item__badges">' + headerBadges + '</div>'
          + visualHtml
          + '<strong>' + escapeHtml(entry.entry_id) + '</strong>'
          + metadataPre
          + materialsHtml
          + '</div>';
      }

      // Showcase Track C — materials list pinned to each gallery render.
      // Walks the snapshot's editing_asset_refs (or scene.snapshot.state.room
      // objects) and emits a small row per material with the BOM catalog's
      // retailer link when available. This is where Track 3 ("professional
      // outputs") pays rent inside every rendered image.
      function renderPinnedMaterialsList(entry, scene) {
        const refs = Array.isArray(scene.snapshot?.editing_asset_refs) ? scene.snapshot.editing_asset_refs : [];
        if (refs.length === 0) return '';
        const manifest = bootstrap.curatedAssetManifest;
        const assetsById = new Map();
        if (manifest && Array.isArray(manifest.assets)) {
          for (const asset of manifest.assets) assetsById.set(asset.asset_id, asset);
        }
        const roomObjects = scene.snapshot?.state?.room?.objects || [];
        const objectsById = new Map();
        for (const obj of roomObjects) objectsById.set(obj.object_id, obj);
        // Cap at 5 so the card stays compact — gallery thumbnails shouldn't
        // scroll. A "+N more" hint replaces the overflow.
        const rows = refs.slice(0, 5).map((ref) => {
          const asset = assetsById.get(ref.asset_id) || null;
          const obj = objectsById.get(ref.bound_to) || null;
          const className = obj?.class ? obj.class.replace(/_/g, " ") : (asset?.object_class || "asset");
          const material = asset?.material_state || obj?.material_state || null;
          const swatch = swatchColorFor(material);
          const materialBits = [material?.color, material?.finish].filter(Boolean).join(" · ");
          const retailer = ref.retailer_url || asset?.uri;
          const retailerName = ref.retailer_name || null;
          const linkText = retailerName || (retailer ? "spec" : null);
          const priceBits = typeof ref.price_cents === "number"
            ? [(ref.price_cents / 100).toFixed(2), (ref.currency || "USD").toUpperCase()].join(" ")
            : null;
          const metaParts = [];
          if (materialBits) metaParts.push(escapeHtml(materialBits));
          if (priceBits) metaParts.push(escapeHtml(priceBits));
          if (retailer && linkText) {
            metaParts.push('<a href="' + escapeHtml(retailer) + '" target="_blank" rel="noopener">' + escapeHtml(linkText) + '</a>');
          }
          const metaHtml = metaParts.length ? '<span class="gallery-item__material-meta">' + metaParts.join(" · ") + '</span>' : '';
          return '<div class="gallery-item__material-row">'
            + '<span class="gallery-item__material-swatch" style="background:' + swatch + '"></span>'
            + '<span class="gallery-item__material-label">' + escapeHtml(className) + '</span>'
            + metaHtml
            + '</div>';
        }).join("");
        const overflow = refs.length > 5
          ? '<span class="muted" style="font-size:var(--font-size-xs)">+ ' + (refs.length - 5) + ' more</span>'
          : '';
        return '<div class="gallery-item__materials">'
          + '<div class="gallery-item__materials-heading">Materials in this render</div>'
          + rows
          + overflow
          + '</div>';
      }

      function renderBeforeAfter(renderedUrl, referenceUrl, entryId) {
        const safeEntry = escapeHtml(entryId);
        return '<div class="before-after" data-before-after style="--reveal:50%">'
          + '<img class="before-after__before" src="' + escapeHtml(referenceUrl) + '" alt="Reference capture for ' + safeEntry + '" />'
          + '<img class="before-after__after" src="' + escapeHtml(renderedUrl) + '" alt="Photoreal render ' + safeEntry + '" />'
          + '<div class="before-after__handle" aria-hidden="true"></div>'
          + '<div class="before-after__labels"><span>Before</span><span>After</span></div>'
          + '<input type="range" class="before-after__range" min="0" max="100" value="50" step="1" aria-label="Reveal after render" />'
          + '</div>';
      }

      function cloneValue(value) {
        if (typeof structuredClone === "function") {
          return structuredClone(value);
        }
        return JSON.parse(JSON.stringify(value));
      }

      function roundCoord(value) {
        return Math.round(value * 1000) / 1000;
      }

      function nextClientRequestKey(prefix) {
        return prefix + "-" + state.clientRequestNamespace + "-" + (++state.requestCounter);
      }

      function createPreviewRequestEnvelope(prefix) {
        const key = nextClientRequestKey(prefix);
        return {
          request_id: key,
          idempotency_key: key,
        };
      }

      function isEditableTextTarget(target) {
        if (!(target instanceof HTMLElement)) {
          return false;
        }
        if (target.isContentEditable) {
          return true;
        }
        const tagName = target.tagName;
        return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
      }

      function canResizeLayoutObject(selected) {
        return Boolean(selected && ["bed", "nightstand", "desk", "chair", "table", "dresser", "bookshelf", "sofa", "rug", "storage"].includes(selected.class));
      }

      function setSelection(selectionId) {
        state.selectionId = selectionId || null;
        if (state.layoutView) {
          try {
            state.layoutView.setSelection(state.selectionId);
          } catch (err) {
            console.error("layoutView.setSelection failed", err);
          }
        }
        if (state.viewer) {
          try {
            state.viewer.setSelection(state.selectionId);
          } catch (err) {
            console.error("viewer.setSelection failed", err);
          }
        }
        if (state.scene && document.getElementById("layout-info-mount")) {
          document.getElementById("layout-info-mount").innerHTML = renderLayoutPaneInfo(state.scene, state.selectionId, Boolean(state.sessionId));
        }
        if (state.scene && document.getElementById("render-info-mount")) {
          document.getElementById("render-info-mount").innerHTML = renderRenderPaneInfo(state.scene, state.quickRender, state.selectionId, state.loadedFrom);
        }
        renderChatPanel();
      }

      function syncViewerRoom(room) {
        if (!state.viewer || !room || !state.scene) {
          return;
        }
        state.viewer.setRoom(room, {
          editing_asset_refs: state.scene.snapshot.editing_asset_refs || [],
        });
        state.viewer.setSelection(state.selectionId);
      }

      function stopDragPreview(options = {}) {
        if (state.dragPreviewSyncHandle !== null) {
          clearTimeout(state.dragPreviewSyncHandle);
          state.dragPreviewSyncHandle = null;
        }
        state.dragPreviewLastSyncedAt = 0;
        state.dragPreviewRoom = null;
        if (options.restoreCanonical) {
          if (state.layoutView && typeof state.layoutView.clearDragPreview === "function") {
            state.layoutView.clearDragPreview();
          }
          if (state.scene) {
            try {
              syncViewerRoom(state.scene.snapshot.state.room);
            } catch (err) {
              console.error("viewer canonical restore failed", err);
            }
          }
        }
      }

      function syncDragPreviewNow() {
        if (state.dragPreviewSyncHandle !== null) {
          clearTimeout(state.dragPreviewSyncHandle);
          state.dragPreviewSyncHandle = null;
        }
        if (!state.dragPreviewRoom) {
          return;
        }
        state.dragPreviewLastSyncedAt = Date.now();
        try {
          syncViewerRoom(state.dragPreviewRoom);
        } catch (err) {
          console.error("drag preview sync failed", err);
        }
      }

      function scheduleDragPreviewSync(force = false) {
        if (!state.dragPreviewRoom || !state.viewer) {
          return;
        }
        const elapsed = Date.now() - state.dragPreviewLastSyncedAt;
        if (force || elapsed >= 50) {
          syncDragPreviewNow();
          return;
        }
        if (state.dragPreviewSyncHandle !== null) {
          return;
        }
        state.dragPreviewSyncHandle = setTimeout(() => {
          syncDragPreviewNow();
        }, Math.max(0, 50 - elapsed));
      }

      function translateDraftObject(object, delta) {
        object.pose.position = {
          x: roundCoord(object.pose.position.x + delta.x),
          y: roundCoord(object.pose.position.y + delta.y),
          z: roundCoord(object.pose.position.z + delta.z),
        };
        object.obb.center = {
          x: roundCoord(object.obb.center.x + delta.x),
          y: roundCoord(object.obb.center.y + delta.y),
          z: roundCoord(object.obb.center.z + delta.z),
        };
      }

      function collectMoveWithParentDescendantIds(objects, parentId, into = []) {
        for (const candidate of objects || []) {
          if (candidate.parent_id !== parentId || candidate.child_movement_policy !== "move_with_parent") {
            continue;
          }
          into.push(candidate.object_id);
          collectMoveWithParentDescendantIds(objects, candidate.object_id, into);
        }
        return into;
      }

      function buildDraggedRoom(scene, detail) {
        const room = cloneValue(scene.snapshot.state.room);
        const object = room.objects.find((candidate) => candidate.object_id === detail.objectId);
        if (!object) {
          return null;
        }
        const delta = {
          x: roundCoord(detail.target_position.x - object.pose.position.x),
          y: roundCoord(detail.target_position.y - object.pose.position.y),
          z: roundCoord(detail.target_position.z - object.pose.position.z),
        };
        translateDraftObject(object, delta);
        if (detail.include_children) {
          const descendantIds = collectMoveWithParentDescendantIds(room.objects, detail.objectId);
          for (const childId of descendantIds) {
            const child = room.objects.find((candidate) => candidate.object_id === childId);
            if (child) {
              translateDraftObject(child, delta);
            }
          }
        }
        return room;
      }

      function updateDragPreview(detail, force = false) {
        if (!state.scene || !detail?.moved) {
          return;
        }
        const room = buildDraggedRoom(state.scene, detail);
        if (!room) {
          return;
        }
        state.dragPreviewRoom = room;
        scheduleDragPreviewSync(force);
      }

      async function undoLastChange(source = "manual") {
        if (!state.scene || !state.sceneId) {
          return;
        }
        if (!state.sessionId) {
          setStatus("Undo requires a redeemed live scene session.", true);
          return;
        }
        if (state.sceneActionInFlight) {
          return;
        }
        state.sceneActionInFlight = true;
        renderChatPanel();
        try {
          const undoResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/undo", {
            expected_scene_version: state.scene.head.current_scene_version,
            idempotency_key: nextClientRequestKey(source + "-undo"),
          });
          stopDragPreview({ restoreCanonical: false });
          state.scene = undoResponse.scene;
          state.quickRender = await loadLiveQuickRender();
          appendChatMessage("assistant", "Undo applied", "Restored the last undoable change in scene version " + undoResponse.applied_scene_version + ".", "success");
          setStatus("Undo created scene version " + undoResponse.applied_scene_version + ".");
          renderScene();
        } catch (error) {
          appendChatMessage("assistant", "Undo failed", (error.reasonCode ? error.reasonCode + ": " : "") + (error.message || "Request failed."), "error");
          setStatus(error.message || "Undo failed.", true);
          renderChatPanel();
        } finally {
          state.sceneActionInFlight = false;
          renderChatPanel();
        }
      }

      function getSelectedLayoutObject() {
        if (!state.scene || !state.selectionId) {
          return null;
        }
        const selected = findSelectedEntity(state.scene, state.selectionId);
        if (!selected || !selected.object_id || !selected.pose || !selected.obb) {
          return null;
        }
        return selected;
      }

      async function moveSelectedObjectBy(delta) {
        if (!state.scene || !state.sceneId || !state.sessionId) {
          return;
        }
        if (state.sceneActionInFlight) {
          return;
        }
        const selected = getSelectedLayoutObject();
        if (!selected) {
          return;
        }
        const includeChildren = collectMoveWithParentDescendantIds(state.scene.snapshot.state.room.objects, selected.object_id).length > 0;
        await commitDraggedMove({
          objectId: selected.object_id,
          target_position: {
            x: roundCoord(selected.pose.position.x + delta.x),
            y: roundCoord(selected.pose.position.y + delta.y),
            z: roundCoord(selected.pose.position.z + (delta.z || 0)),
          },
          include_children: includeChildren,
          moved: true,
          cancelled: false,
        });
      }

      async function resizeSelectedObject(scaleFactor) {
        if (!state.scene || !state.sceneId || !state.sessionId) {
          return;
        }
        if (state.sceneActionInFlight) {
          return;
        }
        const selected = getSelectedLayoutObject();
        if (!selected) {
          return;
        }
        if (!canResizeLayoutObject(selected)) {
          setStatus("That object type cannot be resized yet.", true);
          return;
        }
        state.sceneActionInFlight = true;
        renderChatPanel();
        try {
          const previewEnvelope = createPreviewRequestEnvelope("layout-resize-preview");
          const previewResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/preview", {
            request_id: previewEnvelope.request_id,
            idempotency_key: previewEnvelope.idempotency_key,
            expected_scene_version: state.scene.head.current_scene_version,
            ops: [{
              op: "resize_object",
              object_id: selected.object_id,
              size_x: roundCoord(selected.obb.size_x * scaleFactor),
              size_y: roundCoord(selected.obb.size_y * scaleFactor),
            }],
            explanation: scaleFactor >= 1 ? "Make object larger from layout pane." : "Make object smaller from layout pane.",
          });
          const applyResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/apply", {
            preview_id: previewResponse.preview.preview_id,
            apply_token: previewResponse.preview.apply_token,
            canonical_plan_hash: previewResponse.preview.canonical_plan_hash,
            expected_scene_version: state.scene.head.current_scene_version,
            idempotency_key: nextClientRequestKey("layout-resize-apply"),
          });
          state.scene = applyResponse.scene;
          state.quickRender = await loadLiveQuickRender();
          appendChatMessage("assistant", "Layout resize applied", (scaleFactor >= 1 ? "Resized up " : "Resized down ") + selected.object_id + " and committed scene version " + applyResponse.applied_scene_version + ".", "success");
          setStatus("Resized object in the layout pane. Use Undo last change to revert it.");
          renderScene();
        } catch (error) {
          appendChatMessage("assistant", "Layout resize failed", (error.reasonCode ? error.reasonCode + ": " : "") + (error.message || "Request failed."), "error");
          setStatus(error.message || "Resize failed.", true);
          renderChatPanel();
        } finally {
          state.sceneActionInFlight = false;
          renderChatPanel();
        }
      }

      async function commitLayoutTransform(detail) {
        if (!detail || !detail.action) {
          return;
        }
        if (detail.action === "move") {
          await commitDraggedMove(detail);
          return;
        }
        if (detail.action === "rotate") {
          await commitRotatedHandle(detail);
          return;
        }
        if (detail.action === "resize") {
          await commitResizedHandle(detail);
        }
      }

      async function commitRotatedHandle(detail) {
        if (!detail.moved) {
          stopDragPreview({ restoreCanonical: true });
          return;
        }
        if (!state.scene || !state.sceneId || !state.sessionId) {
          stopDragPreview({ restoreCanonical: true });
          return;
        }
        if (state.sceneActionInFlight) {
          stopDragPreview({ restoreCanonical: true });
          setStatus("Another scene action is already in flight.", true);
          return;
        }
        state.sceneActionInFlight = true;
        renderChatPanel();
        try {
          const previewEnvelope = createPreviewRequestEnvelope("layout-rotate-preview");
          const previewResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/preview", {
            request_id: previewEnvelope.request_id,
            idempotency_key: previewEnvelope.idempotency_key,
            expected_scene_version: state.scene.head.current_scene_version,
            ops: [{
              op: "rotate_object",
              object_id: detail.objectId,
              yaw_degrees: roundCoord(detail.yaw_degrees),
            }],
            explanation: "Rotate object from layout handle.",
          });
          const applyResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/apply", {
            preview_id: previewResponse.preview.preview_id,
            apply_token: previewResponse.preview.apply_token,
            canonical_plan_hash: previewResponse.preview.canonical_plan_hash,
            expected_scene_version: state.scene.head.current_scene_version,
            idempotency_key: nextClientRequestKey("layout-rotate-apply"),
          });
          state.scene = applyResponse.scene;
          state.quickRender = await loadLiveQuickRender();
          appendChatMessage("assistant", "Layout rotate applied", "Rotated " + detail.objectId + " and committed scene version " + applyResponse.applied_scene_version + ".", "success");
          setStatus("Rotated object in the layout pane. Use Undo last change to revert it.");
          renderScene();
        } catch (error) {
          stopDragPreview({ restoreCanonical: true });
          appendChatMessage("assistant", "Layout rotate failed", (error.reasonCode ? error.reasonCode + ": " : "") + (error.message || "Request failed."), "error");
          setStatus(error.message || "Rotation failed.", true);
          renderChatPanel();
        } finally {
          state.sceneActionInFlight = false;
          renderChatPanel();
        }
      }

      async function commitResizedHandle(detail) {
        if (!detail.moved) {
          stopDragPreview({ restoreCanonical: true });
          return;
        }
        if (!state.scene || !state.sceneId || !state.sessionId) {
          stopDragPreview({ restoreCanonical: true });
          return;
        }
        if (state.sceneActionInFlight) {
          stopDragPreview({ restoreCanonical: true });
          setStatus("Another scene action is already in flight.", true);
          return;
        }
        state.sceneActionInFlight = true;
        renderChatPanel();
        try {
          const previewEnvelope = createPreviewRequestEnvelope("layout-resize-preview");
          const previewResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/preview", {
            request_id: previewEnvelope.request_id,
            idempotency_key: previewEnvelope.idempotency_key,
            expected_scene_version: state.scene.head.current_scene_version,
            ops: [{
              op: "resize_object",
              object_id: detail.objectId,
              size_x: roundCoord(detail.size_x),
              size_y: roundCoord(detail.size_y),
            }],
            explanation: "Resize object from layout handle.",
          });
          const applyResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/apply", {
            preview_id: previewResponse.preview.preview_id,
            apply_token: previewResponse.preview.apply_token,
            canonical_plan_hash: previewResponse.preview.canonical_plan_hash,
            expected_scene_version: state.scene.head.current_scene_version,
            idempotency_key: nextClientRequestKey("layout-resize-apply"),
          });
          state.scene = applyResponse.scene;
          state.quickRender = await loadLiveQuickRender();
          appendChatMessage("assistant", "Layout resize applied", "Resized " + detail.objectId + " and committed scene version " + applyResponse.applied_scene_version + ".", "success");
          setStatus("Resized object in the layout pane. Use Undo last change to revert it.");
          renderScene();
        } catch (error) {
          stopDragPreview({ restoreCanonical: true });
          appendChatMessage("assistant", "Layout resize failed", (error.reasonCode ? error.reasonCode + ": " : "") + (error.message || "Request failed."), "error");
          setStatus(error.message || "Resize failed.", true);
          renderChatPanel();
        } finally {
          state.sceneActionInFlight = false;
          renderChatPanel();
        }
      }

      async function commitDraggedMove(detail) {
        if (!detail || !detail.objectId) {
          return;
        }
        if (!detail.moved) {
          stopDragPreview({ restoreCanonical: true });
          return;
        }
        if (!state.scene || !state.sceneId) {
          stopDragPreview({ restoreCanonical: true });
          return;
        }
        if (!state.sessionId) {
          stopDragPreview({ restoreCanonical: true });
          setStatus("Drag-to-move requires a redeemed live scene session.", true);
          return;
        }
        if (state.sceneActionInFlight) {
          stopDragPreview({ restoreCanonical: true });
          setStatus("Another scene action is already in flight.", true);
          return;
        }
        state.sceneActionInFlight = true;
        renderChatPanel();
        try {
          updateDragPreview(detail, true);
          const previewEnvelope = createPreviewRequestEnvelope("layout-drag-preview");
          const previewResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/preview", {
            request_id: previewEnvelope.request_id,
            idempotency_key: previewEnvelope.idempotency_key,
            expected_scene_version: state.scene.head.current_scene_version,
            ops: [{
              op: "move_object",
              object_id: detail.objectId,
              target_position: detail.target_position,
              include_children: detail.include_children === true,
            }],
            explanation: "Move object from layout drag.",
          });
          const applyResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/apply", {
            preview_id: previewResponse.preview.preview_id,
            apply_token: previewResponse.preview.apply_token,
            canonical_plan_hash: previewResponse.preview.canonical_plan_hash,
            expected_scene_version: state.scene.head.current_scene_version,
            idempotency_key: nextClientRequestKey("layout-drag-apply"),
          });
          stopDragPreview({ restoreCanonical: false });
          state.scene = applyResponse.scene;
          state.quickRender = await loadLiveQuickRender();
          appendChatMessage("assistant", "Layout move applied", "Moved " + detail.objectId + " and committed scene version " + applyResponse.applied_scene_version + ".", "success");
          setStatus("Moved object in the layout pane. Use Undo last change to revert it.");
          renderScene();
        } catch (error) {
          stopDragPreview({ restoreCanonical: true });
          appendChatMessage("assistant", "Layout move failed", (error.reasonCode ? error.reasonCode + ": " : "") + (error.message || "Request failed."), "error");
          setStatus(error.message || "Move failed.", true);
          renderChatPanel();
        } finally {
          state.sceneActionInFlight = false;
          renderChatPanel();
        }
      }

      async function rotateSelectedObject(deltaDegrees) {
        if (!state.scene || !state.sceneId || !state.selectionId) {
          return;
        }
        if (!state.sessionId) {
          setStatus("Rotation requires a redeemed live scene session.", true);
          return;
        }
        const selected = getSelectedLayoutObject();
        if (!selected) {
          setStatus("Select an object in the layout pane before rotating it.", true);
          return;
        }
        if (state.sceneActionInFlight) {
          setStatus("Another scene action is already in flight.", true);
          return;
        }
        state.sceneActionInFlight = true;
        renderChatPanel();
        try {
          const previewEnvelope = createPreviewRequestEnvelope("layout-rotate-preview");
          const previewResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/preview", {
            request_id: previewEnvelope.request_id,
            idempotency_key: previewEnvelope.idempotency_key,
            expected_scene_version: state.scene.head.current_scene_version,
            ops: [{
              op: "rotate_object",
              object_id: selected.object_id,
              yaw_degrees: roundCoord(selected.pose.yaw_degrees + deltaDegrees),
            }],
            explanation: deltaDegrees > 0 ? "Rotate object clockwise from layout pane." : "Rotate object counter-clockwise from layout pane.",
          });
          const applyResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/apply", {
            preview_id: previewResponse.preview.preview_id,
            apply_token: previewResponse.preview.apply_token,
            canonical_plan_hash: previewResponse.preview.canonical_plan_hash,
            expected_scene_version: state.scene.head.current_scene_version,
            idempotency_key: nextClientRequestKey("layout-rotate-apply"),
          });
          state.scene = applyResponse.scene;
          state.quickRender = await loadLiveQuickRender();
          appendChatMessage("assistant", "Layout rotate applied", "Rotated " + selected.object_id + " and committed scene version " + applyResponse.applied_scene_version + ".", "success");
          setStatus("Rotated object in the layout pane. Use Undo last change to revert it.");
          renderScene();
        } catch (error) {
          appendChatMessage("assistant", "Layout rotate failed", (error.reasonCode ? error.reasonCode + ": " : "") + (error.message || "Request failed."), "error");
          setStatus(error.message || "Rotation failed.", true);
          renderChatPanel();
        } finally {
          state.sceneActionInFlight = false;
          renderChatPanel();
        }
      }

      function resolveCurrentRenderCamera() {
        const liveView = state.viewer && typeof state.viewer.getCurrentCameraView === 'function'
          ? state.viewer.getCurrentCameraView()
          : null;
        if (liveView && liveView.camera_pose && typeof liveView.fov === 'number') {
          return {
            bookmark_id: null,
            camera_pose: liveView.camera_pose,
            fov: liveView.fov,
            source: 'viewer',
          };
        }
        const bookmark = resolveActiveBookmark(state.scene);
        if (!bookmark) {
          return null;
        }
        return {
          bookmark_id: bookmark.bookmark_id,
          camera_pose: bookmark.camera_pose,
          fov: bookmark.fov,
          source: 'bookmark',
        };
      }

      async function saveActiveBookmark() {
        if (!state.scene || !state.sceneId) {
          return;
        }
        if (!state.sessionId) {
          setStatus("Saving bookmarks requires a redeemed live scene session.", true);
          return;
        }
        const sourceBookmark = resolveActiveBookmark(state.scene);
        const currentCamera = resolveCurrentRenderCamera();
        if (!sourceBookmark && !currentCamera) {
          setStatus("No bookmark camera is available to save yet.", true);
          return;
        }
        const name = window.prompt("Bookmark name", (sourceBookmark?.name || 'Current camera') + " copy");
        if (!name) {
          return;
        }
        try {
          const bookmarkResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/bookmarks", {
            name,
            camera_pose: currentCamera ? currentCamera.camera_pose : sourceBookmark.camera_pose,
            fov: currentCamera ? currentCamera.fov : sourceBookmark.fov,
          });
          state.scene = bookmarkResponse.scene;
          state.activeBookmarkId = bookmarkResponse.bookmark.bookmark_id;
          appendChatMessage("assistant", "Bookmark saved", "Saved bookmark “" + bookmarkResponse.bookmark.name + "”.", "success");
          setStatus("Saved bookmark “" + bookmarkResponse.bookmark.name + "” without changing scene version " + state.scene.head.current_scene_version + ".");
          renderScene();
        } catch (error) {
          appendChatMessage("assistant", "Bookmark failed", (error.reasonCode ? error.reasonCode + ": " : "") + (error.message || "Request failed."), "error");
          setStatus(error.message || "Failed to save bookmark.", true);
          renderChatPanel();
        }
      }

      async function generatePhotorealStyleGrid() {
        if (!state.scene || !state.sceneId) return;
        if (!state.sessionId) {
          setStatus('Style-grid generation requires a redeemed live scene session.', true);
          return;
        }
        const styles = ['modern', 'cozy_warm', 'minimal_scandi', 'rustic_earthy'];
        const cameraView = resolveCurrentRenderCamera();
        const conditioning = safeCaptureConditioning();
        setStatus('Generating ' + styles.length + ' style variants in parallel...');
        const results = await Promise.allSettled(styles.map(async (style) => {
          const key = nextClientRequestKey('render-photoreal-style-' + style);
          const queued = await postSceneJson('/scenes/' + encodeURIComponent(state.sceneId) + '/photoreal', {
            scene_snapshot_id: state.scene.snapshot.snapshot_id,
            bookmark_id: cameraView && cameraView.source === 'bookmark' ? cameraView.bookmark_id : undefined,
            camera_pose: cameraView ? cameraView.camera_pose : undefined,
            fov: cameraView ? cameraView.fov : undefined,
            prompt_modifiers: [style],
            idempotency_key: key,
            conditioning,
          });
          if (queued.photoreal_entry) {
            upsertGalleryEntry(queued.photoreal_entry);
          }
          return waitForPhotorealJob(queued.job_id);
        }));
        let added = 0;
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value?.photoreal_entry) {
            const entry = r.value.photoreal_entry;
            const existed = state.scene.photoreal_gallery.some((e) => e.entry_id === entry.entry_id);
            upsertGalleryEntry(entry);
            if (!existed) added += 1;
          }
        }
        const failed = results.filter((r) => r.status === 'rejected').length;
        appendChatMessage(
          'assistant',
          'Style grid complete',
          'Added ' + added + ' variant(s). ' + (failed > 0 ? failed + ' failed.' : ''),
          failed > 0 ? 'error' : 'success'
        );
        setStatus('Style-grid generation complete: ' + added + ' new, ' + failed + ' failed.');
        renderScene();
      }

      async function generatePhotorealFromActiveBookmark() {
        if (!state.scene || !state.sceneId) {
          return;
        }
        if (!state.sessionId) {
          setStatus("Photoreal generation requires a redeemed live scene session.", true);
          return;
        }
        try {
          const cameraView = resolveCurrentRenderCamera();
          const conditioning = safeCaptureConditioning();
          const photorealResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/photoreal", {
            scene_snapshot_id: state.scene.snapshot.snapshot_id,
            bookmark_id: cameraView && cameraView.source === 'bookmark' ? cameraView.bookmark_id : undefined,
            camera_pose: cameraView ? cameraView.camera_pose : undefined,
            fov: cameraView ? cameraView.fov : undefined,
            prompt_modifiers: [],
            idempotency_key: nextClientRequestKey("render-photoreal"),
            conditioning,
          });
          if (photorealResponse.photoreal_entry) {
            upsertGalleryEntry(photorealResponse.photoreal_entry);
          }
          renderScene();
          const jobResponse = await waitForPhotorealJob(photorealResponse.job_id);
          state.lastPhotorealJobId = photorealResponse.job_id;
          if (jobResponse.photoreal_entry) {
            upsertGalleryEntry(jobResponse.photoreal_entry);
          }
          appendChatMessage(
            "assistant",
            jobResponse.job.status === 'ready' ? 'Photoreal ready' : 'Photoreal failed',
            "Generated gallery asset " + photorealResponse.photoreal_entry.entry_id + " for scene version " + photorealResponse.photoreal_entry.scene_version + ". Job status: " + jobResponse.job.status + ".",
            jobResponse.job.status === 'ready' ? 'success' : 'error'
          );
          setStatus(
            jobResponse.job.status === 'ready'
              ? ("Photoreal gallery updated for immutable scene version " + photorealResponse.photoreal_entry.scene_version + ".")
              : 'Photoreal generation failed.'
          );
          renderScene();
        } catch (error) {
          appendChatMessage("assistant", "Photoreal failed", (error.reasonCode ? error.reasonCode + ": " : "") + (error.message || "Request failed."), "error");
          setStatus(error.message || "Photoreal generation failed.", true);
          renderChatPanel();
        }
      }

      async function submitChatPrompt(rawPrompt) {
        const prompt = rawPrompt.trim();
        if (!prompt) {
          setStatus("Type a prompt before planning from chat.", true);
          return;
        }
        if (state.sceneActionInFlight) {
          setStatus("Wait for the current scene action to finish before sending another prompt.", true);
          return;
        }
        appendChatMessage("user", "You", prompt);
        chatInput.value = "";
        state.pendingPlannerResponse = null;
        if (!state.scene || !state.sceneId) {
          appendChatMessage("assistant", "Planner", "Load a scene before asking for a preview.", "error");
          renderChatPanel();
          return;
        }
        if (!state.sessionId) {
          appendChatMessage("assistant", "Planner", "Fixture mode keeps the chat UI visible, but live preview/apply requires a redeemed API handoff.", "error");
          renderChatPanel();
          return;
        }
        try {
          const requestEnvelope = createPreviewRequestEnvelope("chat-request");
          const request = {
            request_id: requestEnvelope.request_id,
            idempotency_key: requestEnvelope.idempotency_key,
            scene_id: state.sceneId,
            expected_scene_version: state.scene.head.current_scene_version,
            selection_context: {
              selected_entity_ids: state.selectionId ? [state.selectionId] : [],
            },
            user_prompt: prompt,
            conversation_history: buildConversationHistory(),
          };
          const response = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/plan", request);
          await handlePlannerResponse(response);
        } catch (error) {
          appendChatMessage("assistant", "Planner", error.message || "Failed to create a planner response.", "error");
        }
        renderChatPanel();
      }

      async function handlePlannerResponse(response) {
        if (response.response_kind === "operation_plan_preview") {
          state.pendingPlannerResponse = null;
          setStatus("Applying validated edit…");
          await applyPlannerPreview(response.preview);
          return;
        }
        if (response.response_kind === "command_request") {
          state.pendingPlannerResponse = null;
          setStatus("Running planner command…");
          await executePlannerCommand(response.command);
          return;
        }
        if (response.response_kind === "clarification_request") {
          state.pendingPlannerResponse = response;
          appendChatMessage("assistant", "Need clarification", response.prompt);
          return;
        }
        state.pendingPlannerResponse = null;
        appendChatMessage(
          "assistant",
          "Planner rejection",
          (response.reason_code ? response.reason_code + ": " : "") + response.message,
          "error"
        );
      }

      async function applyPlannerPreview(preview) {
        if (!preview || !state.scene || !state.sceneId) {
          return;
        }
        state.sceneActionInFlight = true;
        renderChatPanel();
        try {
          const applyResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/apply", {
            preview_id: preview.preview_id,
            apply_token: preview.apply_token,
            canonical_plan_hash: preview.canonical_plan_hash,
            expected_scene_version: state.scene.head.current_scene_version,
            idempotency_key: nextClientRequestKey("chat-apply"),
          });
          stopDragPreview({ restoreCanonical: false });
          state.scene = applyResponse.scene;
          state.quickRender = await loadLiveQuickRender();
          appendChatMessage("assistant", "Edit applied", preview.explanation + "\\n\\nCommitted scene version " + applyResponse.applied_scene_version + ". Use Undo last change to revert it.", "success");
          setStatus("Applied planner edit to scene version " + applyResponse.applied_scene_version + ". Use Undo last change to revert it.");
          renderScene();
        } catch (error) {
          appendChatMessage("assistant", "Apply failed", (error.reasonCode ? error.reasonCode + ": " : "") + (error.message || "Request failed."), "error");
          setStatus(error.message || "Planner apply failed.", true);
          renderChatPanel();
        } finally {
          state.sceneActionInFlight = false;
          renderChatPanel();
        }
      }

      async function executePlannerCommand(command) {
        if (!command) {
          return;
        }
        if (command.command_kind === "undo_last_change") {
          await undoLastChange("chat");
          return;
        }
        await generatePhotorealFromActiveBookmark();
      }

      function resetChatState() {
        state.chatMessages = [];
        state.pendingPlannerResponse = null;
      }

      function appendChatMessage(role, title, body, tone = "") {
        state.chatMessages.push({ role, title, body, tone });
      }

      function buildConversationHistory() {
        return state.chatMessages.slice(-12).map((entry) => ({
          role: entry.role === 'user' ? 'user' : 'assistant',
          content: entry.role === 'user'
            ? entry.body
            : (entry.title ? entry.title + ': ' : '') + entry.body,
        }));
      }

      function parseHandoffToken(rawValue) {
        const value = rawValue.trim();
        if (!value) {
          return null;
        }
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed.handoff_token === "string") {
            return parsed.handoff_token;
          }
        } catch {}
        try {
          const parsedUrl = new URL(value);
          const segments = parsedUrl.pathname.split("/").filter(Boolean);
          return segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]) : value;
        } catch {}
        return value;
      }

      function normalizeSelectionId(scene, selectionId) {
        if (!scene || !selectionId) {
          return null;
        }
        return findSelectedEntity(scene, selectionId) ? selectionId : null;
      }

      function renderScene() {
        if (!state.scene) {
          renderEmptyState();
          return;
        }
        ensureScanPaneSkeleton();
        document.getElementById('scan-info-mount').innerHTML = renderScanPaneInfo(state.scene);
        syncScanView();
        ensureLayoutPaneSkeleton();
        document.getElementById('layout-info-mount').innerHTML = renderLayoutPaneInfo(state.scene, state.selectionId, Boolean(state.sessionId));
        syncLayoutView();
        ensureRenderPaneSkeleton();
        document.getElementById('render-info-mount').innerHTML = renderRenderPaneInfo(state.scene, state.quickRender, state.selectionId, state.loadedFrom);
        syncViewer();
        renderChatPanel();
        ensureSplatPolling();
      }

      function ensureScanPaneSkeleton() {
        if (document.getElementById('scan-viewer-mount') && document.getElementById('scan-info-mount')) return;
        scanPane.innerHTML = '<div class="scan-viewer"><div id="scan-viewer-mount" style="width:100%;height:100%"></div><span class="scan-mode-badge" id="scan-mode-badge">RoomPlan preview</span></div><div id="scan-info-mount"></div>';
      }

      function syncScanView() {
        const room = state.scene && state.scene.snapshot && state.scene.snapshot.state && state.scene.snapshot.state.room;
        if (!room) return;
        updateScanModeBadge();
        if (state.scanView) {
          try { state.scanView.setRoom(room); } catch (err) { console.error('scanView.setRoom failed', err); }
          void installSplatOnScanView();
          return;
        }
        if (state.scanViewLoading) return;
        state.scanViewLoading = (async () => {
          try {
            const mod = await import('/viewer.js');
            const mount = document.getElementById('scan-viewer-mount');
            if (!mount) return null;
            const view = mod.mountScanView(mount);
            state.scanView = view;
            // Register the Gaussian Splatting renderer (Track B). Guarded import so a
            // failure in the renderer never breaks the scan pane — setSplat simply
            // reports 'metadata_only' and the RoomPlan shell + scan proxies stay.
            try {
              const splatMod = await import('/splat-loader.js');
              if (typeof splatMod.installSplatLoader === 'function') {
                splatMod.installSplatLoader(view);
              }
            } catch (splatErr) {
              console.warn('splat-loader unavailable; scan pane will fall back to meshes/shell', splatErr);
            }
            if (state.scene && state.scene.snapshot) {
              view.setRoom(state.scene.snapshot.state.room);
            }
            await installSplatOnScanView();
            return view;
          } catch (err) {
            console.error('scan view failed to load', err);
            return null;
          } finally {
            state.scanViewLoading = null;
          }
        })();
      }

      async function installSplatOnScanView() {
        if (!state.scanView || typeof state.scanView.setSplat !== 'function') return;
        const splat = state.scene?.splat;
        if (splat && splat.status === 'ready' && splat.uri) {
          try {
            await state.scanView.setSplat({
              uri: splat.uri,
              gaussian_count: splat.gaussian_count ?? null,
            });
          } catch (err) {
            console.error('setSplat failed', err);
          }
        } else {
          try { await state.scanView.setSplat(null); } catch { /* noop */ }
        }
        updateScanModeBadge();
        void installScanProxies();
      }

      // Build scan-native object proxies (per-object point clouds from
      // captured_frames) and hand them to the scan view. Idempotent per
      // scene snapshot. Prefers Tier 2 committed meshes when available
      // (fixtures/roomplan/{id}/meshes/manifest.json), falls back to the
      // Tier 1 point-cloud proxies for objects without a cached mesh.
      async function installScanProxies() {
        const scene = state.scene;
        if (!scene || !state.scanView || typeof state.scanView.setScanProxies !== 'function') return;
        const frames = Array.isArray(scene.captured_frames) ? scene.captured_frames : [];
        if (frames.length === 0) {
          try { state.scanView.setScanProxies(null); } catch { /* noop */ }
          state.scanProxiesSnapshotId = null;
          return;
        }
        const snapshotId = scene.snapshot?.snapshot_id || null;
        if (snapshotId && state.scanProxiesSnapshotId === snapshotId) return;
        if (state.scanProxiesLoading) return;
        const fixtureId = state.loadedFrom === 'fixture' ? fixtureSelect.value : null;
        state.scanProxiesLoading = (async () => {
          try {
            const mod = await import('/scan-proxies.js');
            const t0 = performance.now();
            const meshResult = fixtureId ? await mod.loadScanMeshes(fixtureId) : null;
            const meshMap = meshResult?.meshes || new Map();
            const meshMode = meshResult?.manifest?.mode || null;
            const proxies = await mod.buildScanProxies(scene);
            // Prefer meshes where available; keep point-cloud proxies for
            // objects the Tier 2 pipeline couldn't reconstruct (sparse
            // coverage). Compose into one map the viewer consumes.
            const combined = new Map();
            proxies.forEach((entry, objectId) => combined.set(objectId, entry));
            meshMap.forEach((mesh, objectId) => {
              combined.set(objectId, { mesh, stats: { vertex_count: mesh.userData?.vertex_count || 0, tier: 'mesh:' + (meshMode || 'tsdf') } });
            });
            const ms = Math.round(performance.now() - t0);
            if (state.scene !== scene) return;
            state.scanView.setScanProxies(combined);
            state.scanProxiesSnapshotId = snapshotId;
            const meshCount = meshMap.size;
            const pointCount = proxies.size - meshCount >= 0 ? Math.max(0, proxies.size - meshCount) : 0;
            const detail = meshCount > 0
              ? meshCount + ' mesh' + (meshCount === 1 ? '' : 'es') + ' (' + (meshMode || 'tsdf') + ')' + (pointCount > 0 ? ' · ' + pointCount + ' point proxy' + (pointCount === 1 ? '' : 's') : '')
              : proxies.size + ' object' + (proxies.size === 1 ? '' : 's');
            showToast({
              message: 'Scan proxies ready · ' + detail + ' · ' + ms + ' ms',
              level: 'success',
              duration_ms: 3600,
            });
          } catch (err) {
            console.error('scan proxies failed', err);
            showToast({ message: 'Scan proxies failed: ' + (err?.message || err), level: 'error' });
          } finally {
            state.scanProxiesLoading = null;
          }
        })();
      }

      function updateScanModeBadge() {
        const badge = document.getElementById('scan-mode-badge');
        if (!badge) return;
        const splat = state.scene?.splat;
        if (splat && splat.status === 'ready') {
          // The splat loader is a Week 4 scaffold — metadata is plumbed through the
          // viewer even though the real renderer (gsplat.js / GaussianSplats3D) isn't
          // wired yet. The badge reflects what the viewer actually did: showed the
          // splat ("Splat ready") vs. accepted the URI but is still drawing the
          // RoomPlan shell because no loader is installed ("Splat metadata only").
          const meta = state.scanView && typeof state.scanView.getSplatMeta === 'function'
            ? state.scanView.getSplatMeta()
            : null;
          if (meta && meta.status === 'ready') {
            badge.textContent = 'Splat live';
          } else if (meta && meta.status === 'metadata_only') {
            badge.textContent = 'Splat metadata only';
          } else if (meta && meta.status === 'failed') {
            badge.textContent = 'Splat load failed';
          } else {
            badge.textContent = 'Splat ready';
          }
          badge.classList.add('splat');
        } else if (splat && splat.status === 'processing') {
          badge.textContent = 'Splat processing';
          badge.classList.remove('splat');
        } else {
          badge.textContent = 'RoomPlan preview';
          badge.classList.remove('splat');
        }
      }

      function installAssetUriResolver(api) {
        if (!api || typeof api.setAssetUriResolver !== 'function') return;
        // Default: no resolver. Each canonical asset:// URI stays unresolved
        // and the viewer falls back to box proxies. Add ?asset_demo=1 to map
        // all furniture asset:// URIs to a shared demo model — proves the glTF
        // pipeline end-to-end. Real behavior comes from the curated library
        // (stretch Track 3 v1) once assets are sourced.
        const url = new URL(window.location.href);
        if (url.searchParams.get('asset_demo') === '1') {
          const demoUri = url.searchParams.get('asset_demo_uri') || '/vendor/models/placeholder.glb';
          api.setAssetUriResolver((uri) => {
            if (typeof uri === 'string' && uri.startsWith('asset://')) {
              return demoUri;
            }
            return null;
          });
        }
      }

      function safeCaptureConditioning() {
        if (!state.viewer || typeof state.viewer.captureConditioning !== 'function') return null;
        try {
          return state.viewer.captureConditioning();
        } catch (err) {
          console.error('captureConditioning failed', err);
          return null;
        }
      }

      function disposeScanView() {
        if (!state.scanView) return;
        try { state.scanView.dispose(); } catch (err) { console.error('scanView.dispose failed', err); }
        state.scanView = null;
      }

      function ensureLayoutPaneSkeleton() {
        if (document.getElementById('layout-svg-mount') && document.getElementById('layout-info-mount')) {
          return;
        }
        layoutPane.innerHTML = '<div class="layout-svg-mount" id="layout-svg-mount"></div><div id="layout-info-mount"></div>';
      }

      function syncLayoutView() {
        const room = state.scene && state.scene.snapshot && state.scene.snapshot.state && state.scene.snapshot.state.room;
        if (!room) return;
        const derived = state.scene.derived_state_cache || null;
        if (state.layoutView) {
          try {
            state.layoutView.setRoom(room, derived);
            state.layoutView.setSelection(state.selectionId);
            state.layoutView.setDragEnabled(Boolean(state.sessionId));
          } catch (err) {
            console.error('layoutView.setRoom failed', err);
          }
          return;
        }
        if (state.layoutViewLoading) return;
        state.layoutViewLoading = (async () => {
          try {
            const mod = await import('/layout-view.js');
            const mount = document.getElementById('layout-svg-mount');
            if (!mount) return null;
            const view = mod.mountLayoutView(mount);
            view.setOnSelect((id) => {
              setSelection(id);
            });
            view.setOnDragStart((detail) => {
              setSelection(detail.objectId);
            });
            view.setOnDragMove((detail) => {
              if (detail?.action === 'move') {
                updateDragPreview(detail);
              }
            });
            view.setOnDragEnd((detail) => {
              void commitLayoutTransform(detail);
            });
            state.layoutView = view;
            const liveScene = state.scene;
            if (liveScene && liveScene.snapshot) {
              view.setRoom(liveScene.snapshot.state.room, liveScene.derived_state_cache || null);
              view.setSelection(state.selectionId);
              view.setDragEnabled(Boolean(state.sessionId));
            }
            return view;
          } catch (err) {
            console.error('layout view failed to load', err);
            setStatus('Layout diagram failed to load; falling back to entity list.', true);
            return null;
          } finally {
            state.layoutViewLoading = null;
          }
        })();
      }

      function disposeLayoutView() {
        if (!state.layoutView) return;
        try { state.layoutView.dispose(); } catch (err) { console.error('layoutView.dispose failed', err); }
        state.layoutView = null;
      }

      function ensureRenderPaneSkeleton() {
        if (document.getElementById('render-info-mount') && document.getElementById('render-viewer-mount')) {
          return;
        }
        renderPane.innerHTML = '<div class="render-viewer" id="render-viewer-mount"></div><div id="render-info-mount"></div>';
      }

      function syncViewer() {
        const room = state.scene && state.scene.snapshot && state.scene.snapshot.state && state.scene.snapshot.state.room;
        if (!room) {
          return;
        }
        const editingAssetRefs = state.scene.snapshot.editing_asset_refs || [];
        if (state.viewer) {
          try {
            state.viewer.setRoom(room, { editing_asset_refs: editingAssetRefs });
            state.viewer.setSelection(state.selectionId);
          } catch (err) {
            console.error('viewer.setRoom failed', err);
          }
          return;
        }
        if (state.viewerLoading) {
          return;
        }
        state.viewerLoading = (async () => {
          try {
            const mod = await import('/viewer.js');
            const mount = document.getElementById('render-viewer-mount');
            if (!mount) {
              return null;
            }
            const api = mod.mountViewer(mount);
            api.setOnSelect((id) => {
              setSelection(id);
            });
            installAssetUriResolver(api);
            state.viewer = api;
            if (state.scene && state.scene.snapshot) {
              api.setRoom(state.scene.snapshot.state.room, {
                editing_asset_refs: state.scene.snapshot.editing_asset_refs || [],
              });
              api.setSelection(state.selectionId);
            }
            return api;
          } catch (err) {
            console.error('3D viewer failed to load', err);
            setStatus('3D viewer failed to load; info panel below still reflects current scene state.', true);
            state.viewer = null;
            return null;
          } finally {
            state.viewerLoading = null;
          }
        })();
      }

      function disposeViewer() {
        if (!state.viewer) {
          return;
        }
        try {
          state.viewer.dispose();
        } catch (err) {
          console.error('viewer.dispose failed', err);
        }
        state.viewer = null;
      }

      function renderEmptyState() {
        stopDragPreview({ restoreCanonical: false });
        clearSplatPolling();
        disposeViewer();
        disposeLayoutView();
        disposeScanView();
        scanPane.innerHTML = emptyPane("Redeem a handoff or load a fixture to populate the read-only scan pane.");
        layoutPane.innerHTML = emptyPane("Selection state appears here once the server returns a scene.");
        renderPane.innerHTML = emptyPane("Quick-render inputs and derived cache details appear here once a scene is loaded.");
        renderChatPanel();
      }

      function clearSplatPolling() {
        if (state.splatPollHandle !== null) {
          clearTimeout(state.splatPollHandle);
          state.splatPollHandle = null;
        }
      }

      function ensureSplatPolling() {
        clearSplatPolling();
        if (!state.sessionId || !state.scene || !state.scene.splat) {
          return;
        }
        const splat = state.scene.splat;
        if (splat.status === "ready" || splat.status === "failed") {
          return;
        }
        state.splatPollHandle = setTimeout(async () => {
          try {
            if (!state.scene?.splat) {
              return;
            }
            if (!state.scene.splat.job_id) {
              await refreshLiveSceneForSplat();
            } else {
              const jobResponse = await getSceneJson("/jobs/" + encodeURIComponent(state.scene.splat.job_id));
              if (state.scene) {
                state.scene.splat = jobResponse.splat_asset_record || state.scene.splat;
              }
              if (jobResponse.job.status === "ready") {
                setStatus("Splat asset is ready for scan pane preview.");
              }
              if (jobResponse.job.status === "failed") {
                setStatus("Splat job failed. The RoomPlan preview remains available.", true);
              }
            }
          } catch (error) {
            setStatus(error.message || "Splat job polling failed.", true);
          }
          renderScene();
        }, 1200);
      }

      function renderChatPanel() {
        chatSelection.textContent = describeSelectionLabel(state.scene, state.selectionId);
        const isLive = Boolean(state.sessionId);
        chatSendButton.disabled = !state.scene || state.sceneActionInFlight;
        undoButton.disabled = !state.scene || !isLive || state.sceneActionInFlight;
        const pending = state.pendingPlannerResponse;

        if (pending && pending.response_kind === "clarification_request") {
          chatOptions.innerHTML = pending.options.map((option) => {
            return '<button type="button" class="secondary" data-chat-option="' + escapeHtml(option) + '">' + escapeHtml(option) + '</button>';
          }).join('');
        } else {
          chatOptions.innerHTML = pending && !isLive
            ? '<p class="muted">Planner actions apply only after redeeming a live API handoff.</p>'
            : '';
        }

        chatThread.innerHTML = state.chatMessages.length === 0
          ? '<p class="muted">Chat transcripts, auto-applied edits, clarifications, and reason-code messages appear here.</p>'
          : state.chatMessages.map((entry) => {
              const tone = entry.tone ? ' ' + entry.tone : '';
              return '<div class="chat-entry' + tone + '"><strong>' + escapeHtml(entry.title) + '</strong><pre>' + escapeHtml(entry.body) + '</pre></div>';
            }).join('');
      }

      function describeSelectionLabel(scene, selectionId) {
        if (!scene || !selectionId) {
          return 'No entity selected.';
        }
        const selected = findSelectedEntity(scene, selectionId);
        if (!selected) {
          return 'No entity selected.';
        }
        return selected.class
          ? selected.class + ' · ' + selectionId
          : selected.type
            ? selected.type + ' · ' + selectionId
            : selectionId;
      }

      function renderScanPaneInfo(scene) {
        const room = scene.snapshot.state.room;
        const scanMode = scene.splat?.status === "ready" ? "splat" : "roomplan_preview";
        const capturedFrames = Array.isArray(scene.captured_frames) ? scene.captured_frames : [];
        const summary = {
          scene_id: scene.head.scene_id,
          scene_version: scene.head.current_scene_version,
          room_type: room.room_type,
          room_id: room.room_id,
          source: scene.head.source,
          units: scene.head.units,
          surfaces: room.shell.surfaces.length,
          openings: room.shell.openings.length,
          fixed_elements: room.shell.fixed_elements.length,
          objects: room.objects.length,
          scan_mode: scanMode,
          splat_status: scene.splat ? scene.splat.status : null,
          splat_job_id: scene.splat?.job_id ?? null,
          splat_asset_id: scene.splat?.asset_id ?? null,
          splat_uri: scene.splat?.uri ?? null,
          captured_frame_count: capturedFrames.length,
        };
        const statusMessage = !scene.splat
          ? 'No optional splat sidecar is attached. The scan pane stays on the read-only RoomPlan preview.'
          : scene.splat.status === 'ready'
            ? 'Splat ready — scan pane has swapped from the RoomPlan placeholder to the read-only splat sidecar.'
            : scene.splat.status === 'failed'
              ? 'Splat failed — the editor stays on the read-only RoomPlan preview and the editable scene remains unchanged.'
              : scene.splat.job_id
                ? 'Splat upload accepted — polling the background job while the read-only RoomPlan preview stays interactive.'
                : 'Waiting for an optional companion-app video upload token to be used. The read-only RoomPlan preview stays active.';
        return [
          '<div class="badge">' + escapeHtml(scanMode === 'splat' ? 'Splat asset' : 'RoomPlan preview') + '</div>',
          '<p class="muted">' + escapeHtml(statusMessage) + '</p>',
          '<dl>',
          '<div><dt>Scene</dt><dd>' + escapeHtml(scene.head.scene_id) + '</dd></div>',
          '<div><dt>Snapshot</dt><dd>' + escapeHtml(scene.snapshot.snapshot_id) + '</dd></div>',
          '<div><dt>Selection summary</dt><dd>' + escapeHtml(scene.derived_state_cache?.selection_context_summary || 'Unavailable') + '</dd></div>',
          '</dl>',
          renderCapturedViewsStrip(capturedFrames),
          '<div style="margin-top:12px"><pre>' + escapeHtml(JSON.stringify(summary, null, 2)) + '</pre></div>'
        ].join('');
      }

      function renderCapturedViewsStrip(capturedFrames) {
        if (!capturedFrames || capturedFrames.length === 0) {
          return '<div class="badge" style="margin-top:12px">Captured views</div>'
            + '<p class="muted">No captured evidence frames uploaded yet. The iPhone app attaches these after a scan completes.</p>';
        }
        const items = capturedFrames.map((frame) => {
          const rgbUrl = resolveGalleryImageUrl(frame.rgb?.uri || null);
          const depthUrl = resolveGalleryImageUrl(frame.depth?.uri || null);
          const confidenceUrl = resolveGalleryImageUrl(frame.confidence?.uri || null);
          const imageHtml = rgbUrl
            ? '<img src="' + escapeHtml(rgbUrl) + '" alt="Captured frame ' + escapeHtml(frame.frame_id) + '" />'
            : '<div class="muted viewpoint-card__placeholder">RGB unavailable</div>';
          const linkHtmlParts = [];
          if (depthUrl) linkHtmlParts.push('<a href="' + escapeHtml(depthUrl) + '" target="_blank" rel="noopener">depth</a>');
          if (confidenceUrl) linkHtmlParts.push('<a href="' + escapeHtml(confidenceUrl) + '" target="_blank" rel="noopener">confidence</a>');
          const links = linkHtmlParts.length ? linkHtmlParts.join(' · ') : '<span class="muted">no sidecars</span>';
          const poseJson = escapeHtml(JSON.stringify(frame.camera_pose || null));
          const fovAttr = typeof frame.intrinsics?.fy === 'number' && typeof frame.intrinsics?.height === 'number'
            ? String(2 * Math.atan(frame.intrinsics.height / (2 * frame.intrinsics.fy)) * 180 / Math.PI)
            : '';
          return '<button type="button" class="viewpoint-card"'
            + ' data-viewpoint-pose="' + poseJson + '"'
            + (fovAttr ? ' data-viewpoint-fov="' + escapeHtml(fovAttr) + '"' : '')
            + ' data-viewpoint-id="' + escapeHtml(frame.frame_id) + '"'
            + ' aria-label="Fly scan camera to ' + escapeHtml(frame.frame_id) + '">'
            + '<div class="viewpoint-card__media">' + imageHtml + '<span class="viewpoint-card__hint">Fly here</span></div>'
            + '<strong>' + escapeHtml(frame.frame_id) + '</strong>'
            + '<p class="muted viewpoint-card__timestamp">' + escapeHtml(frame.captured_at || '') + '</p>'
            + '<p class="viewpoint-card__links">' + links + '</p>'
            + '</button>';
        }).join('');
        const flyThroughDisabled = capturedFrames.length < 2 ? ' disabled' : '';
        return '<div class="captured-views-toolbar">'
          + '<div class="badge">Captured views · ' + capturedFrames.length + '</div>'
          + '<button type="button" class="secondary viewpoint-flythrough-button" id="scan-flythrough"' + flyThroughDisabled + '>'
          + 'Fly through ' + capturedFrames.length + ' views'
          + '</button>'
          + '</div>'
          + '<div class="viewpoint-grid">' + items + '</div>';
      }

      function renderLayoutPaneInfo(scene, selectionId, hasLiveSession) {
        const room = scene.snapshot.state.room;
        const selected = findSelectedEntity(scene, selectionId);
        const derived = scene.derived_state_cache || null;
        const violationsBlock = renderViolationsSummary(derived);
        const scoresBlock = renderSoftScores(derived);
        const canResizeSelection = canResizeLayoutObject(selected);
        const selectedObjectControls = selected && selected.object_id && selected.pose
          ? '<section style="margin-bottom:16px"><div class="badge">Selected object controls</div>'
            + (hasLiveSession
              ? (canResizeSelection
                  ? '<div class="actions" style="margin-top:8px"><button type="button" class="secondary" data-layout-action="size-down">Smaller -15%</button><button type="button" class="secondary" data-layout-action="size-up">Bigger +15%</button></div>'
                  : '<p class="muted" style="margin-top:8px">Resize is enabled for beds, desks, rugs, sofas, tables, dressers, bookshelves, storage, chairs, and nightstands.</p>')
                + '<div class="actions" style="margin-top:8px"><button type="button" class="secondary" data-layout-action="rotate-ccw">Rotate -15°</button><button type="button" class="secondary" data-layout-action="rotate-cw">Rotate +15°</button></div><p class="muted" style="margin-top:8px">Selected objects now show on-canvas rotate and resize handles. You can also click the layout pane to focus it, then use Arrow keys to nudge by 10 cm, Shift + Arrow for 25 cm, Q / E to rotate, + / - to resize, or Shift + mouse wheel over the selected object to rotate in place.</p>'
              : '<p class="muted">Redeem a live scene handoff to rotate objects from the layout pane.</p>')
            + '</section>'
          : '';
        const legendBlock = '<div class="layout-scores">Green dashed lines = door-to-furniture clearance paths. Blue dashed fills = the selected object\\'s recommended access zone. Red overlays = hard-violation regions. Constraint overlays are clipped to the room boundary.</div>';
        const groups = [
          {
            title: 'Objects',
            items: room.objects.map((item) => ({ id: item.object_id, label: item.class + ' · ' + item.object_id }))
          },
          {
            title: 'Openings',
            items: room.shell.openings.map((item) => ({ id: item.opening_id, label: item.type + ' · ' + item.opening_id }))
          },
          {
            title: 'Surfaces',
            items: room.shell.surfaces.map((item) => ({ id: item.surface_id, label: item.type + ' · ' + item.surface_id }))
          }
        ];

        return violationsBlock + scoresBlock + legendBlock + selectedObjectControls + groups.map((group) => {
          const buttons = group.items.length === 0
            ? '<p class="muted">No ' + group.title.toLowerCase() + ' in scene.</p>'
            : '<div class="list">' + group.items.map((item) => {
                const selectedState = item.id === selectionId ? 'true' : 'false';
                return '<button type="button" data-entity-id="' + escapeHtml(item.id) + '" data-selected="' + selectedState + '">' + escapeHtml(item.label) + '</button>';
              }).join('') + '</div>';
          return '<section style="margin-bottom:16px"><div class="badge">' + escapeHtml(group.title) + '</div>' + buttons + '</section>';
        }).join('') + '<section><div class="badge">Selection</div>' + renderSelectedEntity(selected) + '</section>';
      }

      function renderViolationsSummary(derived) {
        if (!derived || !derived.hard_violations || derived.hard_violations.length === 0) {
          return '<div class="layout-scores">No hard violations.</div>';
        }
        const items = derived.hard_violations.map((v) => {
          const reason = v.reason_code || 'VIOLATION';
          const msg = v.message || (v.blocked_by ? 'blocked_by ' + v.blocked_by.join(', ') : 'affects ' + (v.entity_ids || [v.entity_id]).filter(Boolean).join(', '));
          return '<li>' + escapeHtml(reason) + ' — ' + escapeHtml(msg) + '</li>';
        }).join('');
        return '<div class="layout-violations-summary"><strong>' + derived.hard_violations.length + ' hard violation(s)</strong><ul>' + items + '</ul></div>';
      }

      function renderBomStrip(scene) {
        const refs = (scene.snapshot.editing_asset_refs || []);
        const objects = scene.snapshot.state.room.objects || [];
        const classByObjectId = new Map(objects.map((o) => [o.object_id, o.class]));
        let totalCents = 0;
        let priceCount = 0;
        const rows = refs.map((ref) => {
          const cls = classByObjectId.get(ref.bound_to) || '—';
          const price = typeof ref.price_cents === 'number' ? ref.price_cents : null;
          if (price !== null) { totalCents += price; priceCount += 1; }
          const priceStr = price !== null ? (ref.currency || 'USD') + ' ' + (price / 100).toFixed(2) : '—';
          const link = ref.retailer_url ? '<a href="' + escapeHtml(ref.retailer_url) + '" target="_blank" rel="noopener" style="color:#93c5fd">' + escapeHtml(ref.retailer_name || 'link') + '</a>' : '—';
          return '<tr><td>' + escapeHtml(cls) + '</td><td>' + escapeHtml(ref.asset_id) + '</td><td>' + priceStr + '</td><td>' + link + '</td></tr>';
        }).join('');
        const totalRow = priceCount > 0 ? '<tr style="border-top:1px solid #374151"><td colspan="2"><strong>Subtotal (' + priceCount + ' items)</strong></td><td><strong>USD ' + (totalCents / 100).toFixed(2) + '</strong></td><td></td></tr>' : '';
        const summary = refs.length === 0
          ? '<p class="muted">No asset bindings attached to this snapshot.</p>'
          : '<details style="margin-top:8px"><summary style="cursor:pointer;color:#93c5fd">' + refs.length + ' asset binding(s)' + (priceCount === 0 ? ' — retailer metadata not yet populated (stretch Track 3 v1.2)' : '') + '</summary>'
            + '<table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:8px"><thead><tr style="text-align:left;color:#94a3b8"><th>Class</th><th>Asset</th><th>Price</th><th>Retailer</th></tr></thead><tbody>'
            + rows + totalRow + '</tbody></table></details>';
        return '<div class="badge">Furniture BOM</div>' + summary;
      }

      function renderSoftScores(derived) {
        if (!derived || !derived.soft_scores) return '';
        const entries = Object.entries(derived.soft_scores);
        if (entries.length === 0) return '';
        const parts = entries.map(([name, value]) => {
          const v = typeof value === 'number' ? value.toFixed(2) : String(value);
          return escapeHtml(name) + ' ' + v;
        });
        return '<div class="layout-scores">Soft scores: ' + parts.join(' · ') + '</div>';
      }

      function renderSelectedEntity(selected) {
        if (!selected) {
          return '<p class="muted">Select an entity from the server-authored layout lists.</p>';
        }
        return '<pre>' + escapeHtml(JSON.stringify(selected, null, 2)) + '</pre>';
      }

      function resolveActiveBookmark(scene) {
        if (!scene || scene.bookmarks.length === 0) {
          return null;
        }
        return scene.bookmarks.find((bookmark) => bookmark.bookmark_id === state.activeBookmarkId) || scene.bookmarks[0];
      }

      function renderRenderPaneInfo(scene, quickRender, selectionId, loadedFrom) {
        const selection = findSelectedEntity(scene, selectionId);
        const selectedBinding = quickRender
          ? quickRender.asset_bindings.find((binding) => binding.bound_to === selectionId) || null
          : null;
        const versionSynchronized = quickRender
          ? quickRender.scene_version === scene.head.current_scene_version && quickRender.scene_snapshot_id === scene.snapshot.snapshot_id
          : false;
        const activeBookmark = resolveActiveBookmark(scene);
        const bookmarkList = scene.bookmarks.length === 0
          ? '<p class="muted">No bookmarks saved yet.</p>'
          : '<div class="list">' + scene.bookmarks.map((bookmark) => {
              const selectedState = bookmark.bookmark_id === activeBookmark?.bookmark_id ? 'true' : 'false';
              return '<button type="button" data-bookmark-id="' + escapeHtml(bookmark.bookmark_id) + '" data-selected="' + selectedState + '">' + escapeHtml(bookmark.name + ' · ' + bookmark.bookmark_id) + '</button>';
            }).join('') + '</div>';
        const gallery = scene.photoreal_gallery.length === 0
          ? '<p class="muted">No photoreal outputs yet. Use the buttons below to generate one from the active bookmark, or request a grid of style variants.</p>'
          : renderPhotorealGallery(scene);
        const details = {
          loaded_from: loadedFrom,
          layout_scene_version: scene.head.current_scene_version,
          quick_render_scene_version: quickRender?.scene_version ?? null,
          quick_render_snapshot_id: quickRender?.scene_snapshot_id ?? null,
          version_synchronized: versionSynchronized,
          style_tags: scene.snapshot.state.style_tags,
          active_bookmark_id: activeBookmark?.bookmark_id ?? null,
          editing_asset_refs: scene.snapshot.editing_asset_refs,
          selected_entity_id: selectionId,
          selected_entity: selection,
          selected_asset_binding: selectedBinding,
          last_photoreal_job_id: state.lastPhotorealJobId,
          quick_render_diagnostics: quickRender?.diagnostics ?? null,
          quick_render_objects: quickRender?.objects ?? [],
        };
        return [
          '<div class="badge">Deterministic quick render</div>',
          '<dl>',
          '<div><dt>Bookmarks</dt><dd>' + escapeHtml(String(scene.bookmarks.length)) + '</dd></div>',
          '<div><dt>Gallery entries</dt><dd>' + escapeHtml(String(scene.photoreal_gallery.length)) + '</dd></div>',
          '<div><dt>Asset refs</dt><dd>' + escapeHtml(String(scene.snapshot.editing_asset_refs.length)) + '</dd></div>',
          '<div><dt>Fallback misses</dt><dd>' + escapeHtml(String(quickRender?.diagnostics.proxy_fallback_count ?? 0)) + '</dd></div>',
          '<div><dt>Version sync</dt><dd>' + escapeHtml(versionSynchronized ? 'synchronized' : 'mismatch') + '</dd></div>',
          '</dl>',
          '<section class="render-section"><div class="badge">Bookmarks</div>' + bookmarkList + '</section>',
          '<section class="render-section"><div class="actions"><button type="button" data-render-action="save-bookmark">Save current camera as bookmark</button><button type="button" class="secondary" data-render-action="generate-photoreal">Generate photoreal</button><button type="button" class="secondary" data-render-action="generate-style-grid">Generate 4 styles</button></div><p class="muted" style="margin-top:10px">Buttons are live only after redeeming an authenticated scene handoff. Photoreal generation now uses the current render-camera position when available, not just the last saved bookmark. “Generate 4 styles” fires parallel /photoreal requests with different prompt modifiers ([stretch.md Track 2 v1.3] Photoreal style exploration).</p></section>',
          '<section class="render-section">' + renderMaterialLibrary() + '</section>',
          '<section class="render-section"><div class="badge">Photoreal gallery</div>' + gallery + '</section>',
          '<section class="render-section">' + renderBomStrip(scene) + '</section>',
          '<div style="margin-top:12px"><pre>' + escapeHtml(JSON.stringify(details, null, 2)) + '</pre></div>'
        ].join('');
      }

      // Showcase Track C — BOM catalog browser.
      // Renders CURATED_ASSET_MANIFEST as a grid of swatch cards grouped by
      // object class. Each card shows the material color as a swatch dot,
      // the class + style tags, and clicks populate the chat prompt so the
      // planner can act on it ("replace the chair with modern walnut").
      const MATERIAL_SWATCH_COLORS = {
        oatmeal: "#e6ddc8",
        walnut: "#5a3924",
        oak: "#b58a5e",
        ash: "#d5c4a1",
        charcoal: "#3a3d42",
        sage: "#93a480",
        terracotta: "#c97b56",
        cream: "#f2ead6",
        navy: "#2a3858",
        black: "#1f2024",
        white: "#f6f6f2",
        linen: "#eadfce",
        slate: "#626a75",
        brass: "#b08947",
        "warm-gray": "#8a8680",
      };
      function swatchColorFor(material) {
        if (!material) return "var(--color-surface-raised-high)";
        const key = String(material.color || "").toLowerCase().trim();
        if (MATERIAL_SWATCH_COLORS[key]) return MATERIAL_SWATCH_COLORS[key];
        // Fallback: hash the color name to a stable pastel so unknown tags still
        // render something distinct rather than collapsing to one generic swatch.
        let hash = 0;
        for (let i = 0; i < key.length; i += 1) {
          hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
        }
        const hue = Math.abs(hash) % 360;
        return "hsl(" + hue + " 30% 55%)";
      }

      function renderMaterialLibrary() {
        const manifest = bootstrap.curatedAssetManifest || null;
        const entries = manifest && Array.isArray(manifest.assets) ? manifest.assets : [];
        if (entries.length === 0) {
          return '<div class="badge">Material library</div>'
            + '<p class="muted">Curated asset manifest unavailable.</p>';
        }
        // Group by object_class so the catalog reads like a product directory
        // (beds with beds, chairs with chairs), not a flat dump.
        const groups = new Map();
        for (const entry of entries) {
          const key = entry.object_class || "other";
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(entry);
        }
        const groupOrder = [...groups.keys()].sort();
        const groupedHtml = groupOrder.map((cls) => {
          const items = groups.get(cls).map((entry) => {
            const swatch = swatchColorFor(entry.material_state);
            const materialLabel = entry.material_state
              ? [entry.material_state.color, entry.material_state.finish].filter(Boolean).join(" · ")
              : "";
            const tags = Array.isArray(entry.style_tags) && entry.style_tags.length > 0
              ? entry.style_tags.slice(0, 3).map((t) => '<span class="material-card__tag">' + escapeHtml(t) + '</span>').join('')
              : '';
            const promptHint = 'Replace with ' + (entry.style_tags?.[0] || 'modern') + ' ' + cls.replace(/_/g, ' ');
            return '<button type="button" class="material-card"'
              + ' data-material-asset="' + escapeHtml(entry.asset_id) + '"'
              + ' data-material-class="' + escapeHtml(cls) + '"'
              + ' data-material-prompt="' + escapeHtml(promptHint) + '"'
              + ' aria-label="Use ' + escapeHtml(entry.asset_id) + ' in chat prompt">'
              + '<div class="material-card__swatch" style="background:' + swatch + '"></div>'
              + '<div class="material-card__body">'
              + '<strong>' + escapeHtml(cls.replace(/_/g, ' ')) + '</strong>'
              + (materialLabel ? '<span class="material-card__material muted">' + escapeHtml(materialLabel) + '</span>' : '')
              + (tags ? '<div class="material-card__tags">' + tags + '</div>' : '')
              + '</div>'
              + '</button>';
          }).join('');
          return '<div class="material-group">'
            + '<div class="material-group__heading">' + escapeHtml(cls.replace(/_/g, ' ')) + '</div>'
            + '<div class="material-card-grid">' + items + '</div>'
            + '</div>';
        }).join('');
        const manifestVersion = manifest.manifest_version || 'unknown';
        return '<div class="material-library__heading">'
          + '<div class="badge">Material library</div>'
          + '<span class="muted material-library__version">v' + escapeHtml(manifestVersion) + ' · ' + entries.length + ' assets</span>'
          + '</div>'
          + '<p class="muted">Click any material to stage a replace prompt. The planner resolves the asset and emits a validated edit.</p>'
          + groupedHtml;
      }

      function findSelectedEntity(scene, selectionId) {
        if (!selectionId) {
          return null;
        }
        const room = scene.snapshot.state.room;
        return room.objects.find((item) => item.object_id === selectionId)
          || room.shell.openings.find((item) => item.opening_id === selectionId)
          || room.shell.surfaces.find((item) => item.surface_id === selectionId)
          || null;
      }

      function emptyPane(message) {
        return '<p class="muted">' + escapeHtml(message) + '</p>';
      }

      // Showcase Track C — photoreal gallery rendering.
      // Groups entries by render_group_id so multi-view renders of the same
      // edit show up as a small cluster (3 viewpoints of "paint north wall
      // sage") instead of three disconnected tiles. Entries without a group
      // id render as standalone tiles. Newest first for both groups and
      // standalones.
      function renderPhotorealGallery(scene) {
        const entries = [...scene.photoreal_gallery].reverse();
        const groups = new Map();
        const standalones = [];
        const ordered = [];
        for (const entry of entries) {
          const key = entry.render_group_id || null;
          if (key) {
            if (!groups.has(key)) {
              const bucket = { key, entries: [] };
              groups.set(key, bucket);
              ordered.push({ kind: "group", bucket });
            }
            groups.get(key).entries.push(entry);
          } else {
            const item = { kind: "solo", entry };
            standalones.push(item);
            ordered.push(item);
          }
        }
        const blocks = ordered.map((item) => {
          if (item.kind === "group") {
            const { key, entries } = item.bucket;
            const cards = entries.map((entry) => renderGalleryEntry(entry, scene)).join("");
            return '<div class="render-group">'
              + '<div class="render-group__heading">'
              + '<div class="badge warm">Multi-view · ' + entries.length + '</div>'
              + '<span class="muted render-group__key">' + escapeHtml(key) + '</span>'
              + '</div>'
              + '<div class="gallery-grid gallery-grid--compact">' + cards + '</div>'
              + '</div>';
          }
          return '<div class="gallery-grid">' + renderGalleryEntry(item.entry, scene) + '</div>';
        });
        return blocks.join('');
      }

      // Showcase Track C toast system.
      // Replaces the persistent #status bar with a stacked, auto-dismissing
      // queue anchored to the viewport. Success / info / error levels render
      // with the same accent tokens as the badges so the visual language stays
      // consistent across the app.
      const TOAST_DEFAULT_DURATION_MS = 4200;
      const TOAST_ERROR_DURATION_MS = 6500;

      function setStatus(message, isError = false) {
        showToast({ message, level: isError ? "error" : "info" });
      }

      function showToast(options) {
        if (!toastRegion) return;
        const level = options?.level === "error" ? "error"
          : options?.level === "success" ? "success"
          : "info";
        const message = String(options?.message ?? "");
        if (!message) return;
        const durationMs = typeof options?.duration_ms === "number" && options.duration_ms > 0
          ? options.duration_ms
          : level === "error" ? TOAST_ERROR_DURATION_MS : TOAST_DEFAULT_DURATION_MS;
        const toast = document.createElement("div");
        toast.className = "toast toast--" + level;
        toast.setAttribute("role", level === "error" ? "alert" : "status");
        const dot = document.createElement("span");
        dot.className = "toast__dot";
        const body = document.createElement("div");
        body.className = "toast__body";
        body.textContent = message;
        const close = document.createElement("button");
        close.type = "button";
        close.className = "toast__close";
        close.setAttribute("aria-label", "Dismiss notification");
        close.textContent = "×";
        toast.appendChild(dot);
        toast.appendChild(body);
        toast.appendChild(close);
        toastRegion.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add("toast--visible"));
        const dismiss = () => {
          if (toast.classList.contains("toast--dismissing")) return;
          toast.classList.add("toast--dismissing");
          toast.addEventListener("transitionend", () => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
          }, { once: true });
          // Safety net in case transitionend doesn't fire (reduced-motion, display:none).
          setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
          }, 600);
        };
        close.addEventListener("click", dismiss);
        setTimeout(dismiss, durationMs);
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }
    </script>
  </body>
</html>`;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sendHtml(response: ServerResponse, html: string): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html);
}

function sendStaticFile(response: ServerResponse, absolutePath: string, contentType: string): void {
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      sendJson(response, 404, { message: "Not found." });
      return;
    }
    const body = readFileSync(absolutePath);
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType);
    response.setHeader("Content-Length", String(body.byteLength));
    response.end(body);
  } catch {
    sendJson(response, 404, { message: "Not found." });
  }
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isMainModule()) {
  const port = Number(process.env.PORT ?? DEFAULT_WEB_EDITOR_PORT);
  const server = createRoomViewEditorServer({
    default_api_base_url: process.env.ROOMVIEW_API_BASE_URL,
  });
  server.listen(port, () => {
    console.log(`RoomView web editor listening on http://127.0.0.1:${port}`);
  });
}
