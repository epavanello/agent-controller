// swift-tools-version: 5.10
import Foundation
import PackageDescription

// TCC reads the privacy usage strings from the *executable's own* Info.plist:
// a bare SwiftPM binary has none, so the helper is killed with SIGABRT the
// first time it asks for the microphone or the speech recognizer. The plist is
// embedded as a Mach-O section instead. Absolute, because the linker's working
// directory depends on how `swift build` was invoked.
let infoPlist = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("Info.plist")
    .path

let package = Package(
    name: "AgentControllerBridge",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "AgentControllerBridge", targets: ["AgentControllerBridge"])
    ],
    targets: [
        .executableTarget(
            name: "AgentControllerBridge",
            path: "Sources/ControllerBridge",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("CoreHaptics"),
                .linkedFramework("GameController"),
                .linkedFramework("IOKit"),
                .linkedFramework("Speech"),
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", infoPlist
                ])
            ]
        )
    ],
    swiftLanguageVersions: [.v5]
)
