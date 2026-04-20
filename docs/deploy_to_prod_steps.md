# Deploy to production — a sketch

The repo ships as three planes that deploy independently:

| Plane | What it runs | Where it deploys |
|---|---|---|
| **App** | Node/TypeScript API (`apps/api`) + web editor (`apps/web`) | Fly.io / Render / any Docker host |
| **GPU** | Flux + ControlNet-Depth + IP-Adapter + (eventually) SAM2 + IC-Light + Splatfacto | Modal / Replicate / RunPod endpoint |
| **Client** | iOS capture app (`ios/RoomViewApp`) | TestFlight → App Store |

The App plane talks to the GPU plane by plain HTTP — no shared filesystem, no framework lock-in. Any hosted-GPU provider that accepts a POST with a JSON body and returns PNG bytes works as a drop-in.

This is "what I'd do if I had a weekend." Adjust as scale demands.

---

## 0. Prerequisites

- A domain you control (example: `roomview.app`). Subdomains used below: `api.roomview.app`, `app.roomview.app`, `flux.roomview.app`.
- Accounts: [Fly.io](https://fly.io), [Modal](https://modal.com) or [Replicate](https://replicate.com), [Cloudflare R2](https://developers.cloudflare.com/r2/) (or S3), HuggingFace (for gated Flux weights), Apple Developer (for TestFlight).
- `flyctl`, `modal`, `gh`, `node>=20`, `uv`, Xcode 15+ all on your Mac.

---

## 1. App plane — API + web editor on Fly.io

The existing workspace already has a clean split: `apps/api/src/server.ts` (API on `:3000`) and `apps/web/src/server.ts` (editor on `:4288`). Wrap them in one Docker image for simplicity; split later if you need independent scaling.

### 1.1 Create the Dockerfile

`Dockerfile` at repo root:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache tini
COPY package.json package-lock.json* ./
COPY apps ./apps
COPY packages ./packages
# No build step needed — tsx runs the TypeScript directly.
RUN npm install --omit=dev
EXPOSE 3000 4288
ENV NODE_ENV=production
ENTRYPOINT ["/sbin/tini", "--"]
# Run both servers in one container; for higher scale split into two Fly apps.
CMD ["sh", "-c", "node --experimental-vm-modules apps/api/src/server.ts & node --experimental-vm-modules apps/web/src/server.ts & wait -n"]
```

A simpler alternative: run each server in its own Fly app. The env separation is cleaner and each app autoscales independently.

### 1.2 Persistent state

Today the API keeps scenes in a local FS directory (`apps/api/src/roomplan-persistence.ts` — `FileSystemRoomPlanCaptureRecordStore`). Two production paths:

- **Short term**: mount a Fly Volume at `/data` and point `ROOMVIEW_STORAGE_DIR` at it. Single instance only — no horizontal scaling.
- **Right answer**: swap `FileSystemRoomPlanCaptureRecordStore` for a Postgres-backed store. Schema is tiny (scenes, snapshots, bookmarks, photoreal entries, splat asset record). `scripts/verify-unit.mts` already exercises the contract — add a Postgres implementation behind the same interface and every existing test still passes.

### 1.3 Object storage for assets

Captured frames, meshes, splats, hero renders are all large binaries. The dev server today serves them from `fixtures/roomplan/{id}/` and `/tmp`; production needs durable storage:

- Create a Cloudflare R2 (or S3) bucket: `roomview-prod-assets`.
- Add `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` env vars.
- Replace the `/dev/fixtures/...` static routes with signed-URL generation for asset downloads.
- The `SplatAssetRecord.uri`, mesh `ply_uri`, etc. already exist as contract fields — they just point at R2 in prod.

### 1.4 Fly deploy

```bash
fly launch --no-deploy --name roomview-app --region sjc
# Edit fly.toml to expose ports 3000 and 4288 with separate [[services]] blocks.

# Required envs (values redacted):
fly secrets set \
  ROOMVIEW_STORAGE_DIR=/data \
  ROOMVIEW_FLUX_BACKEND_URL=https://flux.roomview.app/predict \
  ROOMVIEW_FLUX_BACKEND_TOKEN=... \
  ROOMVIEW_ICLIGHT_ENABLED=true \
  OPENROUTER_API_KEY=... \
  R2_ACCESS_KEY_ID=... \
  R2_SECRET_ACCESS_KEY=... \
  R2_BUCKET=roomview-prod-assets \
  R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
  DATABASE_URL=postgres://...

fly volumes create roomview_data --size 10 --region sjc  # short-term FS store
fly deploy
fly certs add api.roomview.app
fly certs add app.roomview.app
```

### 1.5 Verify in prod

`npm run check` still runs in the container (it's fast and hermetic). Add it to a preflight stage — if green, the contract didn't drift across the deploy.

---

## 2. GPU plane — hosted Flux endpoint on Modal

The API is already wired to POST to `ROOMVIEW_FLUX_BACKEND_URL` with a `FluxInpaintBackendRequest` body ([apps/api/src/photoreal-providers.ts:454](../apps/api/src/photoreal-providers.ts)). The backend just needs to accept that shape and return PNG bytes.

### 2.1 Why Modal first

- Pay per invocation — ~$0.001/sec on A10G, ~$2–3 per Flux render.
- Cold start ~30s with a warmed container (`keep_warm=1`).
- No Dockerfile wrangling; model weights cache on Modal volumes.
- Swap to RunPod or your own box later; the API doesn't care.

Replicate is a fine alternative — same HTTP shape, slightly more expensive, even less ops. If you want "deploy in an afternoon," use Replicate's pre-built `black-forest-labs/flux-dev` endpoint and front-load the prompt building in the API.

### 2.2 Modal stub (put in `serving/flux_modal.py`, not tracked by this repo yet)

```python
# serving/flux_modal.py
import modal

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "torch==2.3.0",
        "diffusers==0.30.0",
        "transformers==4.44.0",
        "accelerate==0.33.0",
        "sentencepiece==0.2.0",
        "pillow==10.4.0",
    )
    .env({"HF_HOME": "/cache/hf"})
)
app = modal.App("roomview-flux", image=image)
volume = modal.Volume.from_name("flux-weights", create_if_missing=True)

@app.function(
    gpu="A10G",
    volumes={"/cache": volume},
    timeout=180,
    keep_warm=1,  # avoid 30s cold starts on every user render
    secrets=[modal.Secret.from_name("huggingface")],
)
@modal.web_endpoint(method="POST", label="predict")
def predict(body: dict):
    """
    Body shape is FluxInpaintBackendRequest (see apps/api/src/photoreal-providers.ts).
    Returns raw PNG bytes.
    """
    from diffusers import FluxControlNetInpaintPipeline
    # ... load reference RGB, depth (for ControlNet), mask from R2 URIs in body,
    #     run Flux.1-dev + ControlNet-Depth + IP-Adapter-reference,
    #     return PNG bytes.
```

Deploy:

```bash
modal deploy serving/flux_modal.py
# Prints a URL like https://<user>--roomview-flux-predict.modal.run
# Set that as ROOMVIEW_FLUX_BACKEND_URL in Fly.
```

### 2.3 SAM2 + IC-Light as additional endpoints

Same pattern. Each gets its own `@modal.function`. The API chains them:

1. Call geometric mask service in-process (CPU — `scripts/mask-service.py --mode geometric`).
2. POST the geometric mask + bounding box prompt to `/sam2` → get refined mask.
3. POST refined mask + reference RGB + prompt to `/flux` → get inpainted PNG.
4. POST inpainted PNG + reference RGB + mask to `/iclight` → get relit composite.
5. Run `verify:preservation` on the final composite before surfacing to the user.

Budget: steps 2–4 on GPU, roughly $5–8 per hero render at launch prices. Step 5 is CPU/free.

### 2.4 Splat training (later, can be skipped at launch)

Splatfacto wants more compute than single-render Flux. Modal batch function with A100:

```python
@app.function(gpu="A100-40GB", timeout=30 * 60, volumes={"/cache": volume})
def train_splat(bundle_uri: str, capture_id: str) -> dict:
    # Download bundle from R2, run nerfstudio splatfacto, upload .splat to R2,
    # return descriptor shaped like scripts/splat-generate.py emits.
```

The existing rgbd_init output ([scripts/splat-generate.py](../scripts/splat-generate.py) `--mode rgbd_init`) is good enough for launch. Splatfacto upgrades quality when you have paying users complaining about splat fidelity.

---

## 3. Client plane — iOS on TestFlight

### 3.1 One-time setup

- Open `ios/RoomViewApp/RoomViewApp.xcodeproj` in Xcode.
- Set your signing team (Xcode → Project → Signing & Capabilities).
- Bundle ID: `com.yourco.roomview.capture` (or similar). Must be unique on App Store Connect.
- Regenerate via XcodeGen if you change `project.yml`: `cd ios/RoomViewApp && xcodegen`.

### 3.2 Environment

In-app settings (`ContentView.swift`) already exposes `apiBaseURL` and `webEditorURL`. For TestFlight:

- Point the defaults at `https://api.roomview.app` and `https://app.roomview.app`.
- Keep the settings UI so beta testers can override for dev.
- Remove the local-network Info.plist entries — they're dev-only.

### 3.3 Upload pipeline

`scripts/validate-ios-payload.mts` exists for exactly this: when beta testers report a bad capture, save the raw payload, run the validator locally to reproduce the ingest failure. Wire a "Save payload" debug menu behind a long-press on the settings screen.

### 3.4 Ship

```bash
# In Xcode:
Product → Archive → Distribute App → TestFlight
# App Store Connect: invite internal testers, then external.
```

Plan on a week between first upload and App Store approval (RoomPlan / camera usage descriptions get scrutiny).

---

## 4. CI / CD

GitHub Actions, two workflows:

- **On PR**: `npm install && npm run check`. All 17 verifiers + 179 Node tests + (on macOS runners) 18 Swift tests run in ~5 min. Block merge on red.
- **On merge to `main`**: same check, then `fly deploy` for the App plane and `modal deploy serving/flux_modal.py` if anything under `serving/` changed.

iOS shipping stays manual (Xcode Archive) until you want Fastlane — not worth automating until you have a release cadence.

---

## 5. Observability

`scripts/verify-observability.mts` already asserts the shape of the log stream. In prod:

- Fly ships logs to [Grafana Cloud Loki](https://fly.io/docs/monitoring/metrics/) — enable from the dashboard.
- Modal integrates with Sentry via `sentry-sdk` — 10 lines in each function.
- Add a `/health` endpoint to the API that checks Postgres, R2, and Flux backend reachability. Fly pings it; PagerDuty on 500.

---

## 6. Cost sketch (rough, at US prices early 2026)

| Plane | Service | Cost |
|---|---|---|
| App | Fly.io shared-cpu-1x + 10GB volume | ~$15/mo |
| App | Cloudflare R2 (10GB + 50GB egress) | ~$1/mo |
| App | Supabase Postgres free tier (< 500MB) | $0 |
| GPU | Modal A10G, keep_warm=1, 50 renders/day | ~$120/mo |
| GPU | Modal A100 batch for splats, 30 scenes/mo | ~$40/mo |
| Client | Apple Developer Program | $99/yr |
| Domain | | ~$15/yr |

Rough all-in: **$150–200/mo** serving ~50 hero renders per day. Scales linearly with GPU usage — at 1000 renders/day you're in the $1–2k/mo range and it's time to move Flux off Modal onto dedicated GPUs.

---

## 7. Ship order (fastest path to a real demo)

1. **Day 1**: Fly deploy API + web editor with FS storage on a volume. `roomview.app` resolves. Fixtures load in the editor over HTTPS.
2. **Day 2**: Modal Flux endpoint deploys. Set `ROOMVIEW_FLUX_BACKEND_URL`. Run a real hero render end-to-end from the web editor on the committed ARKitScenes bedroom. Preservation verifier runs against the output.
3. **Day 3**: TestFlight iOS app. Internal testers scan a real bedroom, upload, see it in the web editor.
4. **Day 4–5**: swap FS store → Postgres, R2 for assets, Sentry, `/health`, prod Sanity checks.
5. **Week 2+**: SAM2 → IC-Light → Splatfacto, in that order.

Anything past step 3 is polish — you're "in prod" for the purpose of showing the thing after step 3.
