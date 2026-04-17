import Foundation
import Testing
@testable import RoomViewCapture

@Test("Capture envelope encodes the API snake_case payload shape")
func captureEnvelopeEncodingMatchesAPIShape() throws {
    let request = RoomPlanCaptureEnvelope(
        requestId: "req-bedroom-primary",
        clientCaptureId: "capture-bedroom-primary",
        roomplanPayload: RoomPlanPayloadEnvelope(
            schemaVersion: "roomplan-fixture-v1",
            coordinateFrame: RoomCoordinateFrameEnvelope(
                origin: .init(x: 0, y: 0, z: 0),
                xAxis: .init(x: 1, y: 0, z: 0),
                yAxis: .init(x: 0, y: 1, z: 0),
                zAxis: .init(x: 0, y: 0, z: 1)
            ),
            dimensions: .init(widthMeters: 4.0, lengthMeters: 3.5, ceilingHeightMeters: 2.6),
            surfaces: [
                .init(
                    id: "rp-floor-1",
                    category: "floor",
                    polygon: .init(vertices: [
                        .init(x: 0, y: 0),
                        .init(x: 4, y: 0),
                        .init(x: 4, y: 3.5),
                        .init(x: 0, y: 3.5)
                    ]),
                    frame: nil
                )
            ],
            openings: [
                .init(
                    id: "rp-opening-window-1",
                    category: "window",
                    hostSurfaceId: "rp-wall-north",
                    rect: .init(minU: 2.45, minV: 0.85, width: 1.2, height: 1.1)
                )
            ],
            objects: [
                .init(
                    id: "rp-bed-1",
                    category: "bed",
                    pose: .init(position: .init(x: 1.15, y: 2.65, z: 0), yawDegrees: 180),
                    obb: .init(center: .init(x: 1.15, y: 2.65, z: 0.3), sizeX: 2.0, sizeY: 1.6, sizeZ: 0.6, yawDegrees: 180),
                    attributes: ["queen"]
                )
            ],
            fixedElements: [
                .init(
                    id: "fixed-radiator-1",
                    category: "radiator",
                    pose: .init(position: .init(x: 3.1, y: 3.32, z: 0.25), yawDegrees: 180),
                    obb: .init(center: .init(x: 3.1, y: 3.32, z: 0.25), sizeX: 1.0, sizeY: 0.18, sizeZ: 0.5, yawDegrees: 180),
                    attributes: ["under_window"],
                    hostSurfaceId: "rp-wall-north"
                )
            ],
            roomCount: 1
        ),
        captureMetadata: .init(
            deviceModel: "iPhone16,2",
            capturedAt: "2026-04-16T18:11:00Z",
            videoExpected: true
        ),
        supplementaryDetections: [
            .init(
                detectionId: "supp-exercise-bike-1",
                label: "exercise_bike",
                obb: .init(center: .init(x: 2.0, y: 1.55, z: 0.7), sizeX: 1.1, sizeY: 0.7, sizeZ: 1.4, yawDegrees: 45),
                confidence: 0.67
            )
        ]
    )

    let encoded = try RoomViewCaptureCompanion.encodeCaptureRequest(request)
    let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])

    #expect(Set(json.keys) == [
        "capture_metadata",
        "client_capture_id",
        "request_id",
        "roomplan_payload",
        "supplementary_detections"
    ])
    #expect(json["request_id"] as? String == "req-bedroom-primary")
    #expect(json["client_capture_id"] as? String == "capture-bedroom-primary")

    let payload = try #require(json["roomplan_payload"] as? [String: Any])
    #expect(payload["schema_version"] as? String == "roomplan-fixture-v1")
    #expect(payload["room_type"] as? String == "bedroom")
    #expect(payload["room_count"] as? Int == 1)
    #expect(payload["fixed_elements"] != nil)

    let metadata = try #require(json["capture_metadata"] as? [String: Any])
    #expect(metadata["room_type_hint"] as? String == "bedroom")
    #expect(metadata["units"] as? String == "m")
    #expect(metadata["device_model"] as? String == "iPhone16,2")
    #expect(metadata["captured_at"] as? String == "2026-04-16T18:11:00Z")
    #expect(metadata["video_expected"] as? Bool == true)

    let detections = try #require(json["supplementary_detections"] as? [[String: Any]])
    #expect(detections.first?["detection_id"] as? String == "supp-exercise-bike-1")
}

@Test("Video upload request encodes the API snake_case payload shape")
func videoUploadRequestEncodingMatchesAPIShape() throws {
    let encoded = try RoomViewCaptureCompanion.encodeVideoUploadRequest(
        .init(videoUploadToken: "video-token-123", contentType: "video/quicktime")
    )
    let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])

    #expect(Set(json.keys) == ["content_type", "video_upload_token"])
    #expect(json["video_upload_token"] as? String == "video-token-123")
    #expect(json["content_type"] as? String == "video/quicktime")
}

@Test("Companion URLs resolve scene-scoped endpoints")
func companionURLTemplatesAreSceneScoped() {
    let baseURL = URL(string: "https://roomview.local")!

    #expect(
        RoomViewCaptureCompanion.captureURL(baseURL: baseURL).absoluteString
            == "https://roomview.local/captures/roomplan"
    )
    #expect(
        RoomViewCaptureCompanion.redeemURL(baseURL: baseURL).absoluteString
            == "https://roomview.local/handoffs/redeem"
    )
    #expect(
        RoomViewCaptureCompanion.videoUploadURL(sceneId: "scene-123", baseURL: baseURL).absoluteString
            == "https://roomview.local/captures/scene-123/video"
    )
}
