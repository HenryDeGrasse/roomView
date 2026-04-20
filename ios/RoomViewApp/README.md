# RoomViewApp

iOS companion app for RoomView. Runs Apple's RoomPlan scanner, uploads the validated `RoomPlanCaptureRequest` to the API on your Mac, and hands off a redemption token to the laptop browser so you can open the scanned room in the three.js editor.

## Layout

- `project.yml` — [xcodegen](https://github.com/yonaskolb/XcodeGen) spec, source of truth
- `RoomViewApp.xcodeproj/` — generated from `project.yml`, do not hand-edit
- `RoomViewApp/RoomViewApp.swift` — `@main` entry
- `RoomViewApp/ContentView.swift` — settings + scan button
- `RoomViewApp/Views/CaptureScreen.swift` — `RoomCaptureView` host, `RoomCaptureSessionDelegate` + `RoomBuilder`, uploads via `RoomPlanCaptureUploader`
- `RoomViewApp/Views/ResultScreen.swift` — handoff token + laptop-browser link
- Local SPM dependency → `../RoomViewCapture` (the package that holds the envelope types and the `CapturedRoom → RoomPlanPayloadEnvelope` mapper)

## Regenerating the Xcode project

```bash
cd ios/RoomViewApp
xcodegen generate
```

Run this any time you edit `project.yml`. Safe to run with Xcode open — reload when prompted.

## Running on your iPhone

On the Mac:
```bash
cd /Users/seanflanagan/dev/roomView
npm run dev         # API :3000 + web :4288
ipconfig getifaddr en0   # note the LAN IP
```

On the iPhone (plugged into the Mac):
1. Open `RoomViewApp.xcodeproj` in Xcode → pick your phone as the run destination → Run.
2. In the app, set **API base URL** to `http://<mac-lan-ip>:3000` and **Web editor base URL** to `http://<mac-lan-ip>:4288`.
3. Tap **Scan a room**, walk through the scan, tap **Done**, then **Upload to Mac**.
4. When the handoff sheet appears, tap the "Open editor" link — paste the URL into your laptop's browser, or read the token and paste it into the web editor's handoff textarea.

## Info.plist keys (declared in `project.yml`)

- `NSCameraUsageDescription` — required for ARKit/RoomPlan
- `NSLocalNetworkUsageDescription` — required for LAN uploads on iOS 14+
- `NSAppTransportSecurity → NSAllowsLocalNetworking = true` — permits HTTP to private-range IPs + `.local` hostnames without a full ATS exception

## What the capture now does

The upload button triggers a three-stage pipeline:

1. **Upload RoomPlan scan** — the parametric room (walls, doors, windows, objects) goes to `POST /captures/roomplan`. Returns `scene_id` + `video_upload_token`.
2. **Upload captured frames** — the app samples ARKit `ARFrame`s at ~0.5s intervals while the user scans. Each sample carries RGB (JPEG) + LiDAR depth (Float32 numpy) + 6DoF pose + intrinsics. Up to 48 frames are posted to `POST /captures/:scene_id/frames`.
3. **Finalize** — `POST /captures/:scene_id/finalize` asks the Mac to promote the capture into `fixtures/roomplan/capture-<room-label>-<timestamp>/` and kick off the Python pipeline (`splat-generate.py` → `bake-wall-textures.py`). The response includes a `fixture_url` you can open in the browser any time to re-load the same room.

The result screen polls `GET /jobs/:job_id` so the user sees "generating splat… / baking textures… / ready" progress live.

## Known limitations

- **LiDAR required.** iPhone Pro (12 Pro or newer) or iPad Pro (2020+). No Simulator support.
- **Free personal team provisioning lasts 7 days.** Re-install from Xcode when it expires.
- **`ARFrame.sceneDepth` during a RoomCaptureSession.** On iOS 17+ this is usually populated (the recorder silently drops frames without depth). If a scan finishes with 0 frames recorded, the upload falls back to RoomPlan-only — the scene still loads, but splat + textures are skipped. Two-phase capture (RoomPlan → plain ARSession) is the fallback if the simultaneous approach proves unreliable in the field.
- **`uv` must be on the Mac's PATH.** The finalize pipeline spawns `uv run scripts/splat-generate.py` + `scripts/bake-wall-textures.py`.
