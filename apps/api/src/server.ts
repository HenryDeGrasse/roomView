import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { RoomPlanCaptureRequest } from "@roomview/contracts";

import {
  RoomPlanCaptureError,
  RoomPlanCaptureService,
  type RoomPlanCaptureServiceOptions,
} from "./roomplan-ingest";

export const DEFAULT_ROOMPLAN_CAPTURE_STORAGE_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "roomplan-captures"
);

export interface RoomPlanApiServerOptions extends RoomPlanCaptureServiceOptions {
  storage_directory?: string;
}

export function createRoomPlanApiServer(options: RoomPlanApiServerOptions = {}): Server {
  const service = new RoomPlanCaptureService({
    ...options,
    storage_directory: options.storage_directory ?? DEFAULT_ROOMPLAN_CAPTURE_STORAGE_DIRECTORY,
  });

  return createServer((request, response) => {
    void handleRequest(request, response, service);
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: RoomPlanCaptureService
): Promise<void> {
  try {
    if (request.method === "POST" && request.url === "/captures/roomplan") {
      const captureRequest = await readJsonBody<RoomPlanCaptureRequest>(request);
      const captureResponse = service.postRoomPlanCapture(captureRequest);
      sendJson(response, 200, captureResponse);
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
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function statusCodeForCaptureError(error: RoomPlanCaptureError): number {
  switch (error.reason_code) {
    case "INVALID_CAPTURE":
    case "ROOM_TYPE_NOT_SUPPORTED":
    case "MULTI_ROOM_NOT_SUPPORTED":
      return 400;
    case "SCENE_ACCESS_DENIED":
      return 403;
    case "TARGET_NOT_FOUND":
      return 404;
    default:
      return 409;
  }
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isMainModule()) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createRoomPlanApiServer({
    handoff_base_url: process.env.ROOMVIEW_HANDOFF_BASE_URL,
    token_secret: process.env.ROOMVIEW_TOKEN_SECRET,
    storage_directory: process.env.ROOMVIEW_API_STORAGE_DIRECTORY,
  });

  server.listen(port, () => {
    console.log(`RoomPlan API listening on http://127.0.0.1:${port}`);
  });
}
