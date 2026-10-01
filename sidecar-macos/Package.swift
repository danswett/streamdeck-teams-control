// swift-tools-version: 5.9
import PackageDescription

// The sidecar is split into a library and a thin executable so the parts that
// can be reasoned about without a Mac in a meeting - the selector map, the
// marker set that decides whether a window is a meeting, the rules for
// reaching a control - are reachable from tests. main.swift keeps only the
// stdin/stdout loop, which needs a live Teams to mean anything.
let package = Package(
    name: "TeamsBridge",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "TeamsBridge", targets: ["TeamsBridge"]),
    ],
    targets: [
        .target(
            name: "TeamsBridgeCore",
            path: "Sources/TeamsBridgeCore"
        ),
        .executableTarget(
            name: "TeamsBridge",
            dependencies: ["TeamsBridgeCore"],
            path: "Sources/TeamsBridge"
        ),
        .testTarget(
            name: "TeamsBridgeCoreTests",
            dependencies: ["TeamsBridgeCore"],
            path: "Tests/TeamsBridgeCoreTests"
        ),
    ]
)
