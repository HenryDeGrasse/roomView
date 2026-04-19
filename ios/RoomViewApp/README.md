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

## Known limitations

- **LiDAR required.** iPhone Pro (12 Pro or newer) or iPad Pro (2020+). No Simulator support.
- **Free personal team provisioning lasts 7 days.** Re-install from Xcode when it expires.
- **Per-frame depth capture not yet wired.** `ARFrame.sceneDepth` is empty during an active RoomCaptureSession ([Apple forum 723818](https://developer.apple.com/forums/thread/723818)); needs a two-phase ARSession. Deferred.
