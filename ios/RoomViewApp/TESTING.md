# iOS Capture — testing + debugging playbook

## Pre-flight (do this once on the Mac)

```bash
# 1. Verify uv is installed and on PATH
which uv && uv --version
# expect: /opt/homebrew/bin/uv (or similar) + uv 0.x.x

# 2. Boot the dev stack
npm run dev
# expect: API on :3000 + web on :4288 + console warning if anything's off
# the API boot log will print "capture pipeline preflight: ..." if uv isn't found

# 3. Confirm health endpoint
curl http://127.0.0.1:3000/health
# expect: {"status":"ok","capture_pipeline_ready":true,...}

# 4. Get your LAN IP — use this in the iOS app
ipconfig getifaddr en0
# e.g. 192.168.1.42
```

## Xcode prep (once per machine)

```bash
cd ios/RoomViewApp
xcodegen generate     # regenerates the .xcodeproj from project.yml
open RoomViewApp.xcodeproj
```

In Xcode:
1. Select the **RoomViewApp** target → **Signing & Capabilities**
2. Change **Team** to your own Apple ID (the project has Henry's team ID hardcoded; it won't sign under a different account)
3. Plug in the iPhone Pro, pick it as the run destination, Cmd-R

## In the iOS app

1. Set **API base URL** to `http://<your-mac-lan-ip>:3000` (e.g. `http://192.168.1.42:3000`)
2. Set **Web editor base URL** to `http://<your-mac-lan-ip>:4288`
3. Tap **Test Mac connection** — should show ✅ "Mac reachable · capture pipeline ready"
4. Tap **Scan a room** — walk slowly around the room for 30-60 seconds so both RoomPlan and LiDAR converge. Watch the "N frames buffered" counter grow.
5. Tap **Done** — wait for "Scan ready"
6. Tap **Upload to Mac** — enter a room name (e.g. "Living room")
7. Watch the progress stages: Uploading scan → Uploading N frames → Starting texture bake
8. On the result screen, watch **Texture bake** status go from "Queued" → "Processing" → "Ready"
9. Tap **Open room in browser** — opens `http://<mac-ip>:4288/?fixture=capture-living-room-...` on the phone. Open the same URL on your laptop to test the replayable flow.

## What normal looks like

| Stage | Expected duration |
|---|---|
| RoomPlan upload | ~1-3s (JSON only, small) |
| Frame upload | ~10-30s (48 frames × ~500KB base64) |
| Finalize response | <1s (kicks off async job) |
| splat-generate (first run) | ~60-120s (uv bootstraps Python venv first time) |
| splat-generate (subsequent) | ~15-30s |
| bake-wall-textures | ~20-40s |

## When it breaks

### "Cannot reach Mac"
- Both devices on same Wi-Fi? (Phone + Mac)
- Mac firewall: System Settings → Network → Firewall → allow incoming for node/tsx
- Corporate networks often block peer-to-peer — try a phone hotspot with Mac joined to it
- Run `curl http://<mac-ip>:3000/health` from the Mac itself first (should work) then from a browser on the phone

### "Upload to Mac" button greys out / nothing happens
- Check `apiBaseURL` starts with `http://` (NOT `https://`)
- Check the URL has a port (3000)
- Rebuild — make sure Xcode picked up changes to `CaptureScreen.swift`

### Scan completes but shows "0 frames buffered"
- `ARFrame.sceneDepth` isn't being populated during RoomPlan on this device / iOS
- Upload still proceeds but skips frame posting; finalize isn't called; you get a handoff URL but no splat/textures
- Fixes (in order of effort): update iOS to latest 17.x, try a different Pro model, eventually implement two-phase capture

### Result screen stuck on "processing" forever
- SSH into the Mac or tail the `npm run dev` log
- Look for lines starting with `[capture-pipeline <fixture-id>]` — they'll show the subprocess stdout/stderr
- Common issues:
  - `uv: command not found` — see preflight above
  - Python deps install failing — run `uv run scripts/splat-generate.py --help` manually to warm the cache
  - Disk full — check `df -h`

### Pipeline job reports `CAPTURE_PIPELINE_FAILED`
- Look at the terminal log for the `[capture-pipeline ...]` stderr tail
- Most common: scripts/bake-wall-textures.py choking on zero-pixel walls (would indicate a bad RoomPlan scan — usually re-scan)
- Second most common: scripts/splat-generate.py running out of memory — the scan is too large

### Fixture URL opens but shows empty scene
- Web server is caching old manifest. Hard-refresh the browser (Cmd-Shift-R)
- Check `curl http://<mac-ip>:4288/dev/fixtures` — the new fixture should appear
- Verify `fixtures/manifest.json` was updated — its mtime drives the hot-reload

### Xcode build fails with code signing error
- Free Apple ID team provisioning lasts 7 days. Re-install from Xcode.
- Bundle identifier collision — change `PRODUCT_BUNDLE_IDENTIFIER` in `project.yml` to something unique (e.g. `com.yourname.RoomViewApp`) and run `xcodegen generate`

## Quick debug one-liners

```bash
# Watch the capture pipeline logs live
# (run this alongside `npm run dev` in a second terminal)
tail -f ~/.npm/_logs/*.log 2>/dev/null

# Manually trigger the pipeline on an existing fixture
uv run scripts/splat-generate.py --fixture fixtures/roomplan/fixture-bedroom-arkitscenes --capture-id fixture-bedroom-arkitscenes --mode cohesive --out-dir fixtures/roomplan/fixture-bedroom-arkitscenes/splats
uv run scripts/bake-wall-textures.py --fixture-id fixture-bedroom-arkitscenes

# Check if your just-uploaded fixture exists on disk
ls fixtures/roomplan/capture-*

# Inspect the durable store for uploaded captures
ls apps/api/data/roomplan-captures/
```
