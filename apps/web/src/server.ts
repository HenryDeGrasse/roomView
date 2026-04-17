import { createServer, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { FixtureManifest, FixtureDescriptor, QuickRenderResponse, SceneReadResponse } from "../../../packages/contracts/src/index.ts";
import {
  buildDeterministicQuickRender,
  CURATED_ASSET_MANIFEST,
} from "../../../packages/contracts/src/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
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

    if (request.method === "GET" && requestUrl.pathname === "/dev/fixtures") {
      sendJson(response, 200, { fixtures: fixtureSources });
      return;
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
  });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>RoomView MVP Editor</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        background: #0b1020;
        color: #e5e7eb;
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: #0b1020; color: #e5e7eb; }
      header {
        padding: 16px 20px;
        border-bottom: 1px solid #1f2937;
        background: #111827;
      }
      h1 { margin: 0 0 6px; font-size: 20px; }
      p { margin: 0; color: #9ca3af; }
      .toolbar {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        margin-top: 16px;
      }
      .card {
        background: #0f172a;
        border: 1px solid #1f2937;
        border-radius: 12px;
        padding: 14px;
      }
      .card h2 { margin: 0 0 10px; font-size: 15px; }
      label { display: block; font-size: 12px; color: #93c5fd; margin-bottom: 6px; }
      input, select, button, textarea {
        width: 100%;
        border-radius: 8px;
        border: 1px solid #374151;
        background: #111827;
        color: #f9fafb;
        padding: 10px 12px;
        font: inherit;
      }
      textarea { min-height: 82px; resize: vertical; }
      button {
        cursor: pointer;
        background: #2563eb;
        border-color: #2563eb;
        font-weight: 600;
      }
      button.secondary {
        background: #1f2937;
        border-color: #374151;
      }
      .actions { display: flex; gap: 10px; margin-top: 10px; }
      .actions > * { flex: 1; }
      #status {
        margin: 16px 20px 0;
        padding: 12px 14px;
        border-radius: 10px;
        border: 1px solid #1f2937;
        background: #0f172a;
        color: #cbd5e1;
      }
      main {
        display: grid;
        gap: 16px;
        padding: 16px 20px 24px;
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .pane {
        min-height: 520px;
        background: #0f172a;
        border: 1px solid #1f2937;
        border-radius: 14px;
        overflow: hidden;
      }
      .pane header {
        margin: 0;
        padding: 14px 16px;
        border: 0;
        border-bottom: 1px solid #1f2937;
        background: #111827;
      }
      .pane header h2 { margin: 0; font-size: 15px; }
      .pane header p { margin-top: 4px; font-size: 12px; }
      .pane-body { padding: 16px; }
      .badge {
        display: inline-block;
        margin-bottom: 10px;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(59, 130, 246, 0.15);
        color: #93c5fd;
        font-size: 12px;
        font-weight: 600;
      }
      .list { display: grid; gap: 8px; margin-top: 12px; }
      .list button {
        text-align: left;
        background: #111827;
        border-color: #374151;
      }
      .list button[data-selected="true"] {
        border-color: #60a5fa;
        box-shadow: 0 0 0 1px #60a5fa inset;
      }
      pre {
        margin: 0;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 12px;
        line-height: 1.5;
        color: #bfdbfe;
      }
      dl { margin: 0; display: grid; gap: 8px; }
      dt { font-size: 12px; color: #93c5fd; }
      dd { margin: 2px 0 0; color: #e5e7eb; }
      .muted { color: #9ca3af; }
      .chat-selection {
        margin-bottom: 10px;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid #374151;
        background: #111827;
        font-size: 12px;
        color: #cbd5e1;
      }
      .chat-thread {
        display: grid;
        gap: 10px;
        margin-top: 12px;
      }
      .chat-entry {
        border: 1px solid #1f2937;
        border-radius: 10px;
        padding: 10px 12px;
        background: #111827;
      }
      .chat-entry strong {
        display: block;
        margin-bottom: 6px;
        color: #93c5fd;
        font-size: 12px;
      }
      .chat-entry.error {
        border-color: #7f1d1d;
        background: rgba(127, 29, 29, 0.2);
      }
      .chat-entry.success {
        border-color: #14532d;
        background: rgba(20, 83, 45, 0.22);
      }
      .render-section { margin-top: 14px; }
      .gallery-grid {
        display: grid;
        gap: 10px;
        margin-top: 10px;
      }
      .gallery-item {
        border: 1px solid #374151;
        border-radius: 10px;
        padding: 10px 12px;
        background: #111827;
      }
      .gallery-item strong {
        display: block;
        margin-bottom: 6px;
        color: #93c5fd;
        font-size: 12px;
      }
      .hidden { display: none; }
      @media (max-width: 1100px) {
        main { grid-template-columns: 1fr; }
        .pane { min-height: 0; }
      }
    </style>
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
          <p class="muted">Use layout selection as context for prompts like “this wall” or “that chair.” Live API sessions enable preview/apply.</p>
          <label for="chat-selection">Current selection</label>
          <div id="chat-selection" class="chat-selection">No scene loaded.</div>
          <label for="chat-input">Prompt</label>
          <textarea id="chat-input" placeholder="Try: move the desk under the window"></textarea>
          <div class="actions">
            <button id="chat-send-button" type="button">Plan from chat</button>
            <button id="chat-clear-button" class="secondary" type="button">Clear thread</button>
          </div>
          <div id="chat-action-buttons" class="actions hidden">
            <button id="chat-accept-button" type="button">Accept preview</button>
            <button id="chat-reject-button" class="secondary" type="button">Reject preview</button>
          </div>
          <div id="chat-options" class="list"></div>
          <div id="chat-thread" class="chat-thread"></div>
        </section>
      </div>
    </header>

    <section id="status">Choose a live handoff or a development fixture scene.</section>

    <main>
      <section class="pane">
        <header>
          <h2>Scan pane</h2>
          <p>Read-only RoomPlan-derived shell and capture summary.</p>
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
      };

      const statusNode = document.getElementById("status");
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
      const chatClearButton = document.getElementById("chat-clear-button");
      const chatActionButtons = document.getElementById("chat-action-buttons");
      const chatAcceptButton = document.getElementById("chat-accept-button");
      const chatRejectButton = document.getElementById("chat-reject-button");
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
          setStatus("Loading development fixture…");
          const response = await fetch("/dev/fixtures/" + encodeURIComponent(fixtureSelect.value));
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.message || "Fixture load failed.");
          }
          state.scene = payload.scene;
          state.sceneId = payload.scene.head.scene_id;
          state.sessionId = null;
          state.selectionId = firstSelectableEntityId(state.scene);
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

      layoutPane.addEventListener("click", (event) => {
        const button = event.target instanceof HTMLElement ? event.target.closest("button[data-entity-id]") : null;
        if (!button) {
          return;
        }
        state.selectionId = button.getAttribute("data-entity-id");
        renderScene();
      });

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
        }
        const bookmarkButton = event.target instanceof HTMLElement ? event.target.closest("button[data-bookmark-id]") : null;
        if (bookmarkButton) {
          state.activeBookmarkId = bookmarkButton.getAttribute("data-bookmark-id");
          renderScene();
        }
      });

      chatSendButton.addEventListener("click", () => {
        void submitChatPrompt(chatInput.value);
      });

      chatClearButton.addEventListener("click", () => {
        resetChatState();
        renderChatPanel();
      });

      chatAcceptButton.addEventListener("click", () => {
        void acceptPendingPlannerResponse();
      });

      chatRejectButton.addEventListener("click", () => {
        if (state.pendingPlannerResponse) {
          appendChatMessage("assistant", "Preview rejected", "The pending preview was discarded.", "error");
        }
        state.pendingPlannerResponse = null;
        renderChatPanel();
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
        const scene = await fetchLiveScene();
        state.scene = scene;
        state.selectionId = firstSelectableEntityId(state.scene);
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
        const selectionId = state.selectionId;
        const activeBookmarkId = state.activeBookmarkId;
        const scene = await fetchLiveScene();
        state.scene = scene;
        state.selectionId = findSelectedEntity(scene, selectionId) ? selectionId : firstSelectableEntityId(scene);
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

      async function saveActiveBookmark() {
        if (!state.scene || !state.sceneId) {
          return;
        }
        if (!state.sessionId) {
          setStatus("Saving bookmarks requires a redeemed live scene session.", true);
          return;
        }
        const sourceBookmark = resolveActiveBookmark(state.scene);
        if (!sourceBookmark) {
          setStatus("No bookmark camera is available to save yet.", true);
          return;
        }
        const name = window.prompt("Bookmark name", sourceBookmark.name + " copy");
        if (!name) {
          return;
        }
        try {
          const bookmarkResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/bookmarks", {
            name,
            camera_pose: sourceBookmark.camera_pose,
            fov: sourceBookmark.fov,
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

      async function generatePhotorealFromActiveBookmark() {
        if (!state.scene || !state.sceneId) {
          return;
        }
        if (!state.sessionId) {
          setStatus("Photoreal generation requires a redeemed live scene session.", true);
          return;
        }
        try {
          const bookmark = resolveActiveBookmark(state.scene);
          const photorealResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/photoreal", {
            scene_snapshot_id: state.scene.snapshot.snapshot_id,
            bookmark_id: bookmark ? bookmark.bookmark_id : undefined,
            prompt_modifiers: [],
            idempotency_key: "render-photoreal-" + (++state.requestCounter),
          });
          const jobResponse = await getSceneJson("/jobs/" + encodeURIComponent(photorealResponse.job_id));
          state.lastPhotorealJobId = photorealResponse.job_id;
          if (!state.scene.photoreal_gallery.some((entry) => entry.entry_id === photorealResponse.photoreal_entry.entry_id)) {
            state.scene.photoreal_gallery = [...state.scene.photoreal_gallery, photorealResponse.photoreal_entry];
          }
          appendChatMessage(
            "assistant",
            "Photoreal ready",
            "Generated gallery asset " + photorealResponse.photoreal_entry.entry_id + " for scene version " + photorealResponse.photoreal_entry.scene_version + ". Job status: " + jobResponse.job.status + ".",
            "success"
          );
          setStatus("Photoreal gallery updated for immutable scene version " + photorealResponse.photoreal_entry.scene_version + ".");
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
          const request = {
            request_id: "chat-request-" + (++state.requestCounter),
            idempotency_key: "chat-request-" + state.requestCounter,
            scene_id: state.sceneId,
            expected_scene_version: state.scene.head.current_scene_version,
            selection_context: {
              selected_entity_ids: state.selectionId ? [state.selectionId] : [],
            },
            user_prompt: prompt,
          };
          const response = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/plan", request);
          handlePlannerResponse(response);
        } catch (error) {
          appendChatMessage("assistant", "Planner", error.message || "Failed to create a planner response.", "error");
        }
        renderChatPanel();
      }

      function handlePlannerResponse(response) {
        state.pendingPlannerResponse = response;
        if (response.response_kind === "operation_plan_preview") {
          appendChatMessage(
            "assistant",
            "Preview ready",
            response.preview.explanation + "\\n\\n" + JSON.stringify(response.preview.ops, null, 2),
            "success"
          );
          return;
        }
        if (response.response_kind === "command_request") {
          appendChatMessage("assistant", "Command ready", response.command.explanation, "success");
          return;
        }
        if (response.response_kind === "clarification_request") {
          appendChatMessage("assistant", "Need clarification", response.prompt);
          return;
        }
        appendChatMessage(
          "assistant",
          "Planner rejection",
          (response.reason_code ? response.reason_code + ": " : "") + response.message,
          "error"
        );
      }

      async function acceptPendingPlannerResponse() {
        if (!state.pendingPlannerResponse || !state.scene || !state.sceneId) {
          return;
        }
        try {
          if (state.pendingPlannerResponse.response_kind === "operation_plan_preview") {
            const preview = state.pendingPlannerResponse.preview;
            const applyResponse = await postSceneJson("/scenes/" + encodeURIComponent(state.sceneId) + "/apply", {
              preview_id: preview.preview_id,
              apply_token: preview.apply_token,
              canonical_plan_hash: preview.canonical_plan_hash,
              expected_scene_version: state.scene.head.current_scene_version,
              idempotency_key: "chat-apply-" + (++state.requestCounter),
            });
            state.scene = applyResponse.scene;
            state.quickRender = await loadLiveQuickRender();
            appendChatMessage("assistant", "Preview applied", "Committed scene version " + applyResponse.applied_scene_version + ".", "success");
            setStatus("Applied planner preview to scene version " + applyResponse.applied_scene_version + ".");
            state.pendingPlannerResponse = null;
            renderScene();
            return;
          }
          if (state.pendingPlannerResponse.response_kind === "command_request") {
            if (state.pendingPlannerResponse.command.command_kind === "undo_last_change") {
              const undoResponse = await postSceneJson(state.pendingPlannerResponse.command.endpoint, {
                expected_scene_version: state.scene.head.current_scene_version,
                idempotency_key: "chat-undo-" + (++state.requestCounter),
              });
              state.scene = undoResponse.scene;
              state.quickRender = await loadLiveQuickRender();
              appendChatMessage("assistant", "Undo applied", "Restored the last undoable change in scene version " + undoResponse.applied_scene_version + ".", "success");
              setStatus("Undo created scene version " + undoResponse.applied_scene_version + ".");
              state.pendingPlannerResponse = null;
              renderScene();
              return;
            }
            const bookmark = resolveActiveBookmark(state.scene);
            const photorealResponse = await postSceneJson(state.pendingPlannerResponse.command.endpoint, {
              scene_snapshot_id: state.scene.snapshot.snapshot_id,
              bookmark_id: bookmark ? bookmark.bookmark_id : undefined,
              prompt_modifiers: [],
              idempotency_key: "chat-photoreal-" + (++state.requestCounter),
            });
            const jobResponse = await getSceneJson("/jobs/" + encodeURIComponent(photorealResponse.job_id));
            state.lastPhotorealJobId = photorealResponse.job_id;
            if (!state.scene.photoreal_gallery.some((entry) => entry.entry_id === photorealResponse.photoreal_entry.entry_id)) {
              state.scene.photoreal_gallery = [...state.scene.photoreal_gallery, photorealResponse.photoreal_entry];
            }
            appendChatMessage("assistant", "Photoreal ready", "Generated gallery asset " + photorealResponse.photoreal_entry.entry_id + " with job status " + jobResponse.job.status + ".", "success");
            setStatus("Photoreal gallery updated for immutable scene version " + photorealResponse.photoreal_entry.scene_version + ".");
            state.pendingPlannerResponse = null;
            renderScene();
            return;
          }
        } catch (error) {
          appendChatMessage("assistant", "Command failed", (error.reasonCode ? error.reasonCode + ": " : "") + (error.message || "Request failed."), "error");
          setStatus(error.message || "Planner action failed.", true);
        }
        renderChatPanel();
      }

      function resetChatState() {
        state.chatMessages = [];
        state.pendingPlannerResponse = null;
      }

      function appendChatMessage(role, title, body, tone = "") {
        state.chatMessages.push({ role, title, body, tone });
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

      function firstSelectableEntityId(scene) {
        const room = scene.snapshot.state.room;
        return room.objects[0]?.object_id || room.shell.openings[0]?.opening_id || room.shell.surfaces[0]?.surface_id || null;
      }

      function renderScene() {
        if (!state.scene) {
          renderEmptyState();
          return;
        }
        scanPane.innerHTML = renderScanPane(state.scene);
        layoutPane.innerHTML = renderLayoutPane(state.scene, state.selectionId);
        renderPane.innerHTML = renderRenderPane(state.scene, state.quickRender, state.selectionId, state.loadedFrom);
        renderChatPanel();
        ensureSplatPolling();
      }

      function renderEmptyState() {
        clearSplatPolling();
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
        chatSendButton.disabled = !state.scene;
        const pending = state.pendingPlannerResponse;
        const canAccept = Boolean(
          pending &&
          (pending.response_kind === "operation_plan_preview" || pending.response_kind === "command_request") &&
          isLive
        );
        chatActionButtons.classList.toggle("hidden", !canAccept);
        chatAcceptButton.disabled = !canAccept;
        chatRejectButton.disabled = !canAccept;

        if (pending && pending.response_kind === "clarification_request") {
          chatOptions.innerHTML = pending.options.map((option) => {
            return '<button type="button" class="secondary" data-chat-option="' + escapeHtml(option) + '">' + escapeHtml(option) + '</button>';
          }).join('');
        } else {
          chatOptions.innerHTML = pending && !isLive
            ? '<p class="muted">Planner previews apply only after redeeming a live API handoff.</p>'
            : '';
        }

        chatThread.innerHTML = state.chatMessages.length === 0
          ? '<p class="muted">Chat transcripts, previews, clarifications, and reason-code messages appear here.</p>'
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

      function renderScanPane(scene) {
        const room = scene.snapshot.state.room;
        const scanMode = scene.splat?.status === "ready" ? "splat" : "roomplan_preview";
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
        };
        const statusMessage = !scene.splat
          ? 'No optional splat sidecar is attached. The RoomPlan preview remains the scan source.'
          : scene.splat.status === 'ready'
            ? 'Splat ready — scan pane has swapped from the RoomPlan placeholder to the splat asset sidecar.'
            : scene.splat.status === 'failed'
              ? 'Splat failed — the editor stays on the RoomPlan preview and the editable scene remains unchanged.'
              : scene.splat.job_id
                ? 'Splat upload accepted — polling the background job while the RoomPlan preview stays interactive.'
                : 'Waiting for an optional companion-app video upload token to be used. The RoomPlan preview stays active.';
        return [
          '<div class="badge">' + escapeHtml(scanMode === 'splat' ? 'Splat asset' : 'RoomPlan preview') + '</div>',
          '<p class="muted">' + escapeHtml(statusMessage) + '</p>',
          '<dl>',
          '<div><dt>Scene</dt><dd>' + escapeHtml(scene.head.scene_id) + '</dd></div>',
          '<div><dt>Snapshot</dt><dd>' + escapeHtml(scene.snapshot.snapshot_id) + '</dd></div>',
          '<div><dt>Selection summary</dt><dd>' + escapeHtml(scene.derived_state_cache?.selection_context_summary || 'Unavailable') + '</dd></div>',
          '</dl>',
          '<div style="margin-top:12px"><pre>' + escapeHtml(JSON.stringify(summary, null, 2)) + '</pre></div>'
        ].join('');
      }

      function renderLayoutPane(scene, selectionId) {
        const room = scene.snapshot.state.room;
        const selected = findSelectedEntity(scene, selectionId);
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

        return groups.map((group) => {
          const buttons = group.items.length === 0
            ? '<p class="muted">No ' + group.title.toLowerCase() + ' in scene.</p>'
            : '<div class="list">' + group.items.map((item) => {
                const selectedState = item.id === selectionId ? 'true' : 'false';
                return '<button type="button" data-entity-id="' + escapeHtml(item.id) + '" data-selected="' + selectedState + '">' + escapeHtml(item.label) + '</button>';
              }).join('') + '</div>';
          return '<section style="margin-bottom:16px"><div class="badge">' + escapeHtml(group.title) + '</div>' + buttons + '</section>';
        }).join('') + '<section><div class="badge">Selection</div>' + renderSelectedEntity(selected) + '</section>';
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

      function renderRenderPane(scene, quickRender, selectionId, loadedFrom) {
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
          ? '<p class="muted">No photoreal outputs yet. Use the button below to generate one from the active bookmark.</p>'
          : '<div class="gallery-grid">' + [...scene.photoreal_gallery].reverse().map((entry) => {
              const providerUri = entry.provider_metadata?.uri || '<none>';
              return '<div class="gallery-item"><strong>' + escapeHtml(entry.entry_id) + '</strong><pre>' + escapeHtml(JSON.stringify({ scene_version: entry.scene_version, scene_snapshot_id: entry.scene_snapshot_id, bookmark_id: entry.bookmark_id, asset_id: entry.asset_id, provider_uri: providerUri, created_at: entry.created_at }, null, 2)) + '</pre></div>';
            }).join('') + '</div>';
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
          '<section class="render-section"><div class="actions"><button type="button" data-render-action="save-bookmark">Save active bookmark</button><button type="button" class="secondary" data-render-action="generate-photoreal">Generate photoreal</button></div><p class="muted" style="margin-top:10px">Buttons are live only after redeeming an authenticated scene handoff. The current shell uses the active bookmark as the render camera scaffold.</p></section>',
          '<section class="render-section"><div class="badge">Photoreal gallery</div>' + gallery + '</section>',
          '<div style="margin-top:12px"><pre>' + escapeHtml(JSON.stringify(details, null, 2)) + '</pre></div>'
        ].join('');
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

      function setStatus(message, isError = false) {
        statusNode.textContent = message;
        statusNode.style.borderColor = isError ? '#7f1d1d' : '#1f2937';
        statusNode.style.color = isError ? '#fecaca' : '#cbd5e1';
        statusNode.style.background = isError ? 'rgba(127, 29, 29, 0.35)' : '#0f172a';
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
