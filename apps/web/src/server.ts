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
        loadedFrom: null,
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
          state.loadedFrom = "fixture";
          state.quickRender = await loadFixtureQuickRender(fixtureSelect.value);
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
        const response = await fetch(new URL("/scenes/" + encodeURIComponent(state.sceneId), state.apiBaseUrl).toString(), {
          headers: {
            Authorization: "Bearer " + state.sessionId,
          },
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.message || payload.reason_code || "Scene read failed.");
        }
        state.scene = payload.scene;
        state.selectionId = firstSelectableEntityId(state.scene);
        state.quickRender = await loadLiveQuickRender();
        renderScene();
        setStatus("Loaded live scene " + state.scene.head.scene_id + " via authenticated read.");
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

      async function postJson(url, body) {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.message || payload.reason_code || "Request failed.");
        }
        return payload;
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
      }

      function renderEmptyState() {
        scanPane.innerHTML = emptyPane("Redeem a handoff or load a fixture to populate the read-only scan pane.");
        layoutPane.innerHTML = emptyPane("Selection state appears here once the server returns a scene.");
        renderPane.innerHTML = emptyPane("Quick-render inputs and derived cache details appear here once a scene is loaded.");
      }

      function renderScanPane(scene) {
        const room = scene.snapshot.state.room;
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
          splat_status: scene.splat ? scene.splat.status : null,
        };
        return [
          '<div class="badge">Read-only scan source</div>',
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

      function renderRenderPane(scene, quickRender, selectionId, loadedFrom) {
        const selection = findSelectedEntity(scene, selectionId);
        const selectedBinding = quickRender
          ? quickRender.asset_bindings.find((binding) => binding.bound_to === selectionId) || null
          : null;
        const versionSynchronized = quickRender
          ? quickRender.scene_version === scene.head.current_scene_version && quickRender.scene_snapshot_id === scene.snapshot.snapshot_id
          : false;
        const details = {
          loaded_from: loadedFrom,
          layout_scene_version: scene.head.current_scene_version,
          quick_render_scene_version: quickRender?.scene_version ?? null,
          quick_render_snapshot_id: quickRender?.scene_snapshot_id ?? null,
          version_synchronized: versionSynchronized,
          style_tags: scene.snapshot.state.style_tags,
          bookmark_ids: scene.bookmarks.map((bookmark) => bookmark.bookmark_id),
          editing_asset_refs: scene.snapshot.editing_asset_refs,
          selected_entity_id: selectionId,
          selected_entity: selection,
          selected_asset_binding: selectedBinding,
          quick_render_diagnostics: quickRender?.diagnostics ?? null,
          quick_render_objects: quickRender?.objects ?? [],
        };
        return [
          '<div class="badge">Deterministic quick render</div>',
          '<dl>',
          '<div><dt>Bookmarks</dt><dd>' + escapeHtml(String(scene.bookmarks.length)) + '</dd></div>',
          '<div><dt>Asset refs</dt><dd>' + escapeHtml(String(scene.snapshot.editing_asset_refs.length)) + '</dd></div>',
          '<div><dt>Fallback misses</dt><dd>' + escapeHtml(String(quickRender?.diagnostics.proxy_fallback_count ?? 0)) + '</dd></div>',
          '<div><dt>Version sync</dt><dd>' + escapeHtml(versionSynchronized ? 'synchronized' : 'mismatch') + '</dd></div>',
          '</dl>',
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
