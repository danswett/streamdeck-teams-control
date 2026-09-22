// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TeamsBridge",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "TeamsBridge", targets: ["TeamsBridge"]),
    ],
    targets: [
        .executableTarget(
            name: "TeamsBridge",
            path: "Sources/TeamsBridge"
        ),
    ]
)
