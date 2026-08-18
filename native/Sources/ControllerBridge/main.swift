import AppKit
import Foundation

@MainActor
final class BridgeApplication {
    private let controller = ControllerMonitor()
    private let micButton = MicButtonMonitor()
    private let recorder = VoiceRecorder()
    private var scheduledCommandCount = 0
    private var scheduledCommandDrainWaiters: [CheckedContinuation<Void, Never>] = []

    func start() {
        // Before anything else asks CoreAudio a question: a previous bridge may
        // have been killed holding the user's default device.
        restoreBorrowedAudioDefaults()
        controller.start()
        micButton.start { pressed in
            BridgeWriter.shared.event("micbutton", payload: ["pressed": pressed])
        }
        publishAudioCapabilities()
    }

    func stop() {
        micButton.stop()
        controller.stop()
    }

    /// Registers ordering-sensitive state before starting independent command
    /// work, so stdin order is preserved without serializing all commands.
    func schedule(_ command: NativeCommand) {
        scheduledCommandCount += 1
        Task { @MainActor in
            await handle(command)
            scheduledCommandDidFinish()
        }
    }

    func waitForScheduledCommands() async {
        guard scheduledCommandCount > 0 else { return }
        await withCheckedContinuation { scheduledCommandDrainWaiters.append($0) }
    }

    private func scheduledCommandDidFinish() {
        scheduledCommandCount -= 1
        guard scheduledCommandCount == 0 else { return }
        let waiters = scheduledCommandDrainWaiters
        scheduledCommandDrainWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    private func handle(_ command: NativeCommand) async {
        let result: (Bool, String)
        switch command.command {
        case "light.set":
            result = controller.setLight(command.payload)
                ? (true, "Controller light updated.")
                : (false, "The controller light is unavailable.")
        case "haptics.play":
            controller.playFeedback(command.payload["tone"] as? String ?? "success")
            result = (true, "Controller feedback played.")
        case "speaker.play":
            guard let path = command.payload["path"] as? String, !path.isEmpty else {
                result = (false, "The speaker command needs a file path.")
                break
            }
            // The caller already rendered the announcement to this file: play it,
            // never hand the path to text-to-speech.
            let fileURL = URL(fileURLWithPath: path)
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                result = (false, "The announcement file no longer exists.")
                break
            }
            result = await DualSenseUSBSpeaker.play(fileURL: fileURL)
        case "mic.start":
            switch await recorder.start(localeIdentifier: command.payload["locale"] as? String) {
            case .success:
                result = (true, "Recording started.")
            case .failure(let error):
                result = (false, error.localizedDescription)
            }
        case "mic.stop":
            switch await recorder.stopAndTranscribe() {
            case .success(let text):
                // The transcription rides in the message: it is the command's
                // single meaningful product.
                result = (true, text)
            case .failure(let error):
                result = (false, error.localizedDescription)
            }
        case "system.refresh":
            controller.refresh()
            publishAudioCapabilities()
            result = (true, "System status refreshed.")
        default:
            result = (false, "Unknown native command: \(command.command)")
        }
        BridgeWriter.shared.response(
            id: command.id,
            success: result.0,
            message: result.1
        )
    }

    private func publishAudioCapabilities() {
        let speaker = DualSenseUSBSpeaker.capability()
        let microphone = DualSenseUSBMicrophone.capability()
        BridgeWriter.shared.event("audio", payload: [
            "speaker": ["available": speaker.available, "reason": speaker.reason],
            "microphone": ["available": microphone.available, "reason": microphone.reason]
        ])
    }

    private func restoreBorrowedAudioDefaults() {
        let marker = DefaultAudioDeviceMarker()
        do {
            try marker.restorePending { route, deviceUID in
                guard let deviceID = AudioDeviceUID.deviceID(for: deviceUID) else { return true }
                switch route {
                case .input:
                    return AudioRouteSetter.setDefaultInput(deviceID) == noErr
                case .output:
                    return AudioRouteSetter.setDefaultOutput(deviceID) == noErr
                }
            }
        } catch {
            BridgeWriter.shared.error("Audio recovery failed: \(error.localizedDescription)")
        }
    }
}

// Before any AppKit or TCC-guarded work: this may replace the process.
ResponsibilityDisclaimer.relaunchIfNeeded()

let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let bridge = MainActor.assumeIsolated {
    let bridge = BridgeApplication()
    bridge.start()
    return bridge
}

let (commandLines, commandLineContinuation) = AsyncStream.makeStream(of: String.self)

Task { @MainActor in
    await NativeCommandLineProcessor.run(
        commandLines,
        schedule: { command in
            bridge.schedule(command)
        },
        malformed: {
            BridgeWriter.shared.error("The native bridge received malformed input.")
        }
    )
    await bridge.waitForScheduledCommands()
    bridge.stop()
    // `response` writes asynchronously. Do not let AppKit tear down the process
    // until the response for the final command has reached stdout.
    BridgeWriter.shared.flush()
    application.terminate(nil)
}

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        commandLineContinuation.yield(line)
    }
    commandLineContinuation.finish()
}

application.run()
