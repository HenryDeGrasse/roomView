// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "RoomViewCapture",
    platforms: [
        .macOS(.v12),
        .iOS(.v17)
    ],
    products: [
        .library(
            name: "RoomViewCapture",
            targets: ["RoomViewCapture"]
        )
    ],
    targets: [
        .target(
            name: "RoomViewCapture",
            path: "Sources"
        ),
        .testTarget(
            name: "RoomViewCaptureTests",
            dependencies: ["RoomViewCapture"],
            path: "Tests"
        )
    ]
)
