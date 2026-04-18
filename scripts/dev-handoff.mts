import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const apiBaseUrl = process.env.ROOMVIEW_API_BASE_URL ?? "http://127.0.0.1:3000";
const fixturePath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(process.cwd(), "fixtures/roomplan/bedroom-primary/capture-request.json");

const baseRequestBody = JSON.parse(readFileSync(fixturePath, "utf8"));
const requestBody = createUniqueCaptureRequest(baseRequestBody);

const response = await fetch(new URL("/captures/roomplan", apiBaseUrl), {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify(requestBody),
});

const payload = await response.json();
if (!response.ok) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

const qrPayload = JSON.parse(payload.qr_payload);
console.log(`request_id:     ${requestBody.request_id}`);
console.log(`capture_id:     ${requestBody.client_capture_id}`);
console.log(`scene_id:       ${payload.scene_id}`);
console.log(`handoff_token:  ${qrPayload.handoff_token}`);
console.log(`handoff_url:    ${payload.handoff_url}`);
console.log(`web_editor:     ${(process.env.ROOMVIEW_WEB_URL ?? "http://127.0.0.1:4288")}?api_base_url=${encodeURIComponent(apiBaseUrl)}`);
console.log("\nPaste this into the web editor handoff box:");
console.log(qrPayload.handoff_token);

function createUniqueCaptureRequest(requestBody: any) {
  const suffix = `${compactTimestamp(new Date())}-${randomUUID().slice(0, 8)}`;
  return {
    ...requestBody,
    request_id: `${requestBody.request_id ?? "req-roomview-dev"}-${suffix}`,
    client_capture_id: `${requestBody.client_capture_id ?? "capture-roomview-dev"}-${suffix}`,
    capture_metadata: requestBody.capture_metadata
      ? {
          ...requestBody.capture_metadata,
          captured_at: new Date().toISOString(),
        }
      : requestBody.capture_metadata,
  };
}

function compactTimestamp(value: Date) {
  return value.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}
