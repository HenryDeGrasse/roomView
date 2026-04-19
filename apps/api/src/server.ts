import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  ApplyPlanRequest,
  CaptureFramesRequest,
  CreateBookmarkRequest,
  FinalizeCaptureRequest,
  GeneratePhotorealRequest,
  HandoffRedeemRequest,
  JobReadResponse,
  OperationPlanRequest,
  RoomPlanCaptureRequest,
  SceneReadResponse,
  ScenePreviewRequest,
  UndoLastChangeRequest,
  VideoUploadRequest,
} from "@roomview/contracts";

import {
  createAssetManifestResponse,
  createQuickRenderResponse,
} from "./quick-render";
import { createConsoleObservabilitySink, ObservabilityRecorder } from "./observability";
import {
  RoomPlanCaptureError,
  RoomPlanCaptureService,
  type RoomPlanCaptureServiceOptions,
} from "./roomplan-ingest";
import { checkPipelinePrerequisites } from "./capture-pipeline";

const serverDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(serverDir, "..", "..", "..");

export const DEFAULT_ROOMPLAN_CAPTURE_STORAGE_DIRECTORY = resolve(
  serverDir,
  "..",
  "data",
  "roomplan-captures"
);

const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 8;

export interface RoomPlanApiServerOptions extends RoomPlanCaptureServiceOptions {
  storage_directory?: string;
}

interface SceneSessionRecord {
  session_id: string;
  scene_id: string;
  expires_at: string;
}

interface RoomPlanApiRequestContext {
  service: RoomPlanCaptureService;
  session_ttl_ms: number;
  sceneSessionsById: Map<string, SceneSessionRecord>;
}

export function createRoomPlanApiServer(options: RoomPlanApiServerOptions = {}): Server {
  const observability = options.observability ?? new ObservabilityRecorder({
    sink: createConsoleObservabilitySink("roomview_api"),
  });
  const service = new RoomPlanCaptureService({
    ...options,
    observability,
    storage_directory: options.storage_directory ?? DEFAULT_ROOMPLAN_CAPTURE_STORAGE_DIRECTORY,
    fixture_repo_root: options.fixture_repo_root ?? repoRoot,
    // Defaults to port 4288 to match `npm run dev:web`. If you point the
    // iPhone at a LAN IP, override via ROOMVIEW_WEB_BASE_URL so the returned
    // fixture_url works from the phone too.
    fixture_web_base_url: options.fixture_web_base_url ?? process.env.ROOMVIEW_WEB_BASE_URL ?? "http://127.0.0.1:4288",
  });
  const context: RoomPlanApiRequestContext = {
    service,
    session_ttl_ms: options.session_ttl_ms ?? DEFAULT_SESSION_TTL_MS,
    sceneSessionsById: new Map(),
  };

  // Pre-flight check: warn early if `uv` is missing. Doesn't prevent the
  // server from starting — the editor and all non-finalize endpoints still
  // work — but finalize will fail until it's installed.
  const uvWarning = checkPipelinePrerequisites();
  if (uvWarning) {
    // eslint-disable-next-line no-console
    console.warn(`[roomview-api] capture pipeline preflight: ${uvWarning}`);
  }

  return createServer((request, response) => {
    void handleRequest(request, response, context);
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RoomPlanApiRequestContext
): Promise<void> {
  try {
    applyCorsHeaders(response);

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    // Unauthenticated health probe — the iPhone pings this pre-upload to
    // confirm LAN reachability and capture-pipeline readiness.
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      const uvIssue = checkPipelinePrerequisites();
      sendJson(response, 200, {
        status: "ok",
        capture_pipeline_ready: uvIssue === null,
        capture_pipeline_error: uvIssue,
        now: new Date().toISOString(),
      });
      return;
    }

    const photorealArtifactPath = extractPhotorealArtifactPath(requestUrl.pathname);
    if (request.method === "GET" && photorealArtifactPath) {
      const artifact = context.service.getPhotorealArtifact(photorealArtifactPath.scene_id, photorealArtifactPath.asset_id);
      if (!artifact) {
        sendJson(response, 404, { message: "Not found." });
        return;
      }
      applyCorsHeaders(response);
      response.statusCode = 200;
      response.setHeader("Content-Type", artifact.content_type);
      response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      response.end(artifact.bytes);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/captures/roomplan") {
      const captureRequest = await readJsonBody<RoomPlanCaptureRequest>(request);
      const captureResponse = context.service.postRoomPlanCapture(captureRequest);
      sendJson(response, 200, captureResponse);
      return;
    }

    const captureVideoSceneId = extractCaptureVideoSceneId(requestUrl.pathname);
    if (request.method === "POST" && captureVideoSceneId) {
      const uploadRequest = await readJsonBody<VideoUploadRequest>(request);
      const uploadResponse = context.service.postCaptureVideo(captureVideoSceneId, uploadRequest);
      sendJson(response, 200, uploadResponse);
      return;
    }

    const captureFramesSceneId = extractCaptureFramesSceneId(requestUrl.pathname);
    if (request.method === "POST" && captureFramesSceneId) {
      const framesRequest = await readJsonBody<CaptureFramesRequest>(request);
      const framesResponse = context.service.postCaptureFrames(captureFramesSceneId, framesRequest);
      sendJson(response, 200, framesResponse);
      return;
    }

    const captureFinalizeSceneId = extractCaptureFinalizeSceneId(requestUrl.pathname);
    if (request.method === "POST" && captureFinalizeSceneId) {
      const finalizeRequest = await readJsonBody<FinalizeCaptureRequest>(request);
      const finalizeResponse = context.service.finalizeCapture(captureFinalizeSceneId, finalizeRequest);
      sendJson(response, 200, finalizeResponse);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/handoffs/redeem") {
      const redeemRequest = await readJsonBody<HandoffRedeemRequest>(request);
      const redeemResponse = context.service.redeemHandoff(redeemRequest);
      context.sceneSessionsById.set(redeemResponse.session_id, {
        session_id: redeemResponse.session_id,
        scene_id: redeemResponse.scene_id,
        expires_at: redeemResponse.expires_at,
      });
      sendJson(response, 200, redeemResponse);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/assets/manifest") {
      sendJson(response, 200, createAssetManifestResponse());
      return;
    }

    const mutationSceneId = extractMutationSceneId(requestUrl.pathname);
    if (request.method === "POST" && mutationSceneId && requestUrl.pathname.endsWith("/plan")) {
      requireAuthenticatedSceneSession(request, mutationSceneId, context);
      const planRequest = await readJsonBody<OperationPlanRequest>(request);
      const planResponse = await context.service.planSceneOperationInteractive(mutationSceneId, planRequest);
      sendJson(response, 200, planResponse);
      return;
    }

    if (request.method === "POST" && mutationSceneId && requestUrl.pathname.endsWith("/bookmarks")) {
      requireAuthenticatedSceneSession(request, mutationSceneId, context);
      const bookmarkRequest = await readJsonBody<CreateBookmarkRequest>(request);
      const bookmarkResponse = context.service.createBookmark(mutationSceneId, bookmarkRequest);
      sendJson(response, 200, bookmarkResponse);
      return;
    }

    if (request.method === "POST" && mutationSceneId && requestUrl.pathname.endsWith("/preview")) {
      requireAuthenticatedSceneSession(request, mutationSceneId, context);
      const previewRequest = await readJsonBody<ScenePreviewRequest>(request);
      const previewResponse = context.service.createScenePreview(mutationSceneId, previewRequest);
      sendJson(response, 200, previewResponse);
      return;
    }

    if (request.method === "POST" && mutationSceneId && requestUrl.pathname.endsWith("/apply")) {
      requireAuthenticatedSceneSession(request, mutationSceneId, context);
      const applyRequest = await readJsonBody<ApplyPlanRequest>(request);
      const applyResponse = context.service.applyScenePreview(mutationSceneId, applyRequest);
      sendJson(response, 200, applyResponse);
      return;
    }

    if (request.method === "POST" && mutationSceneId && requestUrl.pathname.endsWith("/undo")) {
      requireAuthenticatedSceneSession(request, mutationSceneId, context);
      const undoRequest = await readJsonBody<UndoLastChangeRequest>(request);
      const undoResponse = context.service.undoLastChange(mutationSceneId, undoRequest);
      sendJson(response, 200, undoResponse);
      return;
    }

    if (request.method === "POST" && mutationSceneId && requestUrl.pathname.endsWith("/photoreal")) {
      requireAuthenticatedSceneSession(request, mutationSceneId, context);
      const photorealRequest = await readJsonBody<GeneratePhotorealRequest>(request);
      const photorealResponse = context.service.generatePhotoreal(mutationSceneId, photorealRequest);
      sendJson(response, 200, photorealResponse);
      return;
    }

    const jobId = extractJobId(requestUrl.pathname);
    if (request.method === "GET" && jobId) {
      const knownJob = context.service.getJob(jobId);
      if (!knownJob) {
        throw new RoomPlanCaptureError("TARGET_NOT_FOUND", `Job ${jobId} was not found.`);
      }
      requireAuthenticatedSceneSession(request, knownJob.scene_id, context);
      const job = context.service.pollJob(jobId) ?? knownJob;
      const scene = context.service.getScene(knownJob.scene_id);
      const photorealEntry = scene?.photoreal_gallery.find((entry) => entry.asset_id === job.output_asset_id) ?? null;
      const capturePipelineResult = job.job_kind === "capture_pipeline"
        ? context.service.getCapturePipelineResult(job.job_id)
        : null;
      const jobResponse: JobReadResponse = {
        job,
        photoreal_entry: photorealEntry,
        splat_asset_record: scene?.splat ?? null,
        capture_pipeline_result: capturePipelineResult,
      };
      sendJson(response, 200, jobResponse);
      return;
    }

    const readableSceneId = extractReadableSceneId(requestUrl.pathname);
    if (request.method === "GET" && readableSceneId) {
      requireAuthenticatedSceneSession(request, readableSceneId, context);
      const scene = context.service.getScene(readableSceneId);
      if (!scene) {
        throw new RoomPlanCaptureError("TARGET_NOT_FOUND", `Scene ${readableSceneId} was not found.`);
      }
      if (requestUrl.pathname.endsWith("/quick-render")) {
        sendJson(response, 200, createQuickRenderResponse(scene));
        return;
      }
      const readResponse: SceneReadResponse = { scene };
      sendJson(response, 200, readResponse);
      return;
    }

    sendJson(response, 404, { message: "Not found." });
  } catch (error) {
    if (error instanceof RoomPlanCaptureError) {
      sendJson(response, statusCodeForCaptureError(error), {
        reason_code: error.reason_code,
        message: error.message,
      });
      return;
    }

    if (error instanceof SyntaxError) {
      sendJson(response, 400, {
        reason_code: "INVALID_CAPTURE",
        message: "Request body must be valid JSON.",
      });
      return;
    }

    sendJson(response, 500, {
      reason_code: "INVALID_CAPTURE",
      message: "Unexpected server error.",
    });
  }
}

function requireAuthenticatedSceneSession(
  request: IncomingMessage,
  scene_id: string,
  context: RoomPlanApiRequestContext
): SceneSessionRecord {
  const sessionId = readSessionId(request);
  if (!sessionId) {
    throw new RoomPlanCaptureError("AUTH_REQUIRED", "Scene read requires an authenticated scene session.");
  }

  const now = new Date().toISOString();
  const cached = context.sceneSessionsById.get(sessionId);
  if (cached) {
    if (isExpired(cached.expires_at, now)) {
      context.sceneSessionsById.delete(sessionId);
      throw new RoomPlanCaptureError("AUTH_REQUIRED", "The scene session has expired. Redeem a new handoff.");
    }
    if (cached.scene_id !== scene_id) {
      throw new RoomPlanCaptureError("SCENE_ACCESS_DENIED", "The scene session is not valid for this scene.");
    }
    return cached;
  }

  const persisted = context.service.getPersistedInitialSceneRecords(scene_id);
  const redeemedSessionId = persisted?.handoff_grant.redeemed_session_id ?? null;
  const redeemedAt = persisted?.handoff_grant.redeemed_at ?? null;
  if (!persisted || !redeemedSessionId || !redeemedAt || redeemedSessionId !== sessionId) {
    throw new RoomPlanCaptureError("SCENE_ACCESS_DENIED", "The scene session is invalid for this scene.");
  }

  const hydratedSession: SceneSessionRecord = {
    session_id: sessionId,
    scene_id,
    expires_at: addMilliseconds(redeemedAt, context.session_ttl_ms),
  };
  if (isExpired(hydratedSession.expires_at, now)) {
    throw new RoomPlanCaptureError("AUTH_REQUIRED", "The scene session has expired. Redeem a new handoff.");
  }

  context.sceneSessionsById.set(sessionId, hydratedSession);
  return hydratedSession;
}

function extractCaptureVideoSceneId(pathname: string): string | null {
  const match = pathname.match(/^\/captures\/([^/]+)\/video$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function extractCaptureFramesSceneId(pathname: string): string | null {
  const match = pathname.match(/^\/captures\/([^/]+)\/frames$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function extractCaptureFinalizeSceneId(pathname: string): string | null {
  const match = pathname.match(/^\/captures\/([^/]+)\/finalize$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function extractReadableSceneId(pathname: string): string | null {
  const patterns = [
    /^\/scenes\/([^/]+)$/,
    /^\/scenes\/([^/]+)\/quick-render$/,
  ];
  for (const pattern of patterns) {
    const match = pathname.match(pattern);
    if (match) {
      return decodeURIComponent(match[1]);
    }
  }
  return null;
}

function extractMutationSceneId(pathname: string): string | null {
  const patterns = [
    /^\/scenes\/([^/]+)\/plan$/,
    /^\/scenes\/([^/]+)\/bookmarks$/,
    /^\/scenes\/([^/]+)\/preview$/,
    /^\/scenes\/([^/]+)\/apply$/,
    /^\/scenes\/([^/]+)\/undo$/,
    /^\/scenes\/([^/]+)\/photoreal$/,
  ];
  for (const pattern of patterns) {
    const match = pathname.match(pattern);
    if (match) {
      return decodeURIComponent(match[1]);
    }
  }
  return null;
}

function extractJobId(pathname: string): string | null {
  const match = pathname.match(/^\/jobs\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function extractPhotorealArtifactPath(pathname: string): { scene_id: string; asset_id: string } | null {
  const match = pathname.match(/^\/artifacts\/photoreal\/([^/]+)\/([^/]+)$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    scene_id: decodeURIComponent(match[1]),
    asset_id: decodeURIComponent(match[2]),
  };
}

function readSessionId(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  const sessionHeader = request.headers["x-session-id"];
  if (typeof sessionHeader === "string" && sessionHeader.trim().length > 0) {
    return sessionHeader.trim();
  }

  return null;
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (body.length === 0) {
    throw new SyntaxError("Request body is required.");
  }

  return JSON.parse(body) as T;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  applyCorsHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function applyCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id");
}

function statusCodeForCaptureError(error: RoomPlanCaptureError): number {
  switch (error.reason_code) {
    case "AUTH_REQUIRED":
      return 401;
    case "INVALID_CAPTURE":
    case "ROOM_TYPE_NOT_SUPPORTED":
    case "MULTI_ROOM_NOT_SUPPORTED":
    case "CAPTURE_NO_FRAMES":
      return 400;
    case "SCENE_ACCESS_DENIED":
      return 403;
    case "TARGET_NOT_FOUND":
      return 404;
    default:
      return 409;
  }
}

function loadDotEnv(): void {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(repoRoot, ".env"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) {
      continue;
    }
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['\"]|['\"]$/g, "");
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
    return;
  }
}

function addMilliseconds(timestamp: string, ms: number): string {
  return new Date(new Date(timestamp).getTime() + ms).toISOString();
}

function isExpired(expiresAt: string, now: string): boolean {
  return new Date(expiresAt).getTime() <= new Date(now).getTime();
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isMainModule()) {
  loadDotEnv();
  const port = Number(process.env.PORT ?? 3000);
  const server = createRoomPlanApiServer({
    handoff_base_url: process.env.ROOMVIEW_HANDOFF_BASE_URL,
    token_secret: process.env.ROOMVIEW_TOKEN_SECRET,
    storage_directory: process.env.ROOMVIEW_API_STORAGE_DIRECTORY,
    session_ttl_ms: process.env.ROOMVIEW_SESSION_TTL_MS ? Number(process.env.ROOMVIEW_SESSION_TTL_MS) : undefined,
    planner_mode: process.env.ROOMVIEW_PLANNER_MODE === "deterministic" ? "deterministic" : process.env.OPENROUTER_API_KEY ? "openrouter" : undefined,
    openrouter_api_key: process.env.OPENROUTER_API_KEY,
    openrouter_model: process.env.OPENROUTER_MODEL,
    openrouter_base_url: process.env.OPENROUTER_BASE_URL,
    planner_site_url: process.env.ROOMVIEW_SITE_URL,
    planner_app_name: process.env.ROOMVIEW_APP_NAME,
    planner_timeout_ms: process.env.ROOMVIEW_PLANNER_TIMEOUT_MS ? Number(process.env.ROOMVIEW_PLANNER_TIMEOUT_MS) : undefined,
  });

  server.listen(port, () => {
    console.log(`RoomPlan API listening on http://127.0.0.1:${port}`);
  });
}
