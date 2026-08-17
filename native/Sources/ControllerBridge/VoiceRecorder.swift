import AVFoundation
import Foundation
import Speech

/// Records from the wired DualSense internal microphone and transcribes the
/// result with the system speech recognizer.
///
/// macOS has no way to point `AVAudioRecorder` at a specific input device, so
/// the DualSense USB input is made the default input for the duration of the
/// recording and restored afterwards, using the same borrow/restore pattern as
/// the USB speaker.
@MainActor
final class VoiceRecorder {
    private var recorder: AVAudioRecorder?
    private var fileURL: URL?
    private let usbMic = DualSenseUSBMicrophone()
    private var previousInput: AudioDeviceID?
    private(set) var isRecording = false

    /// Tried in order; the system locale is the last resort.
    private static let preferredLocales = [Locale(identifier: "it-IT")]

    enum RecorderError: LocalizedError {
        case alreadyRecording
        case speechAuthorizationDenied
        case recognizerUnavailable
        case noDualSenseInput
        case noDefaultInput
        case routeFailed(String)
        case recordFailed(String)
        case transcriptionFailed(String)

        var errorDescription: String? {
            switch self {
            case .alreadyRecording: "A recording is already in progress."
            case .speechAuthorizationDenied: "Speech recognition permission is not granted."
            case .recognizerUnavailable: "The speech recognizer is unavailable for this locale."
            case .noDualSenseInput: "No compatible USB DualSense microphone is connected."
            case .noDefaultInput: "The current macOS input device could not be read."
            case .routeFailed(let message): message
            case .recordFailed(let message): message
            case .transcriptionFailed(let message): message
            }
        }
    }

    func start() async -> Result<Void, Error> {
        guard !isRecording else { return .failure(RecorderError.alreadyRecording) }
        guard await requestSpeechAuthorization() == .authorized else {
            return .failure(RecorderError.speechAuthorizationDenied)
        }
        guard makeRecognizer() != nil else {
            return .failure(RecorderError.recognizerUnavailable)
        }
        guard let dualSenseInput = DualSenseUSBMicrophone.inputDevice() else {
            return .failure(RecorderError.noDualSenseInput)
        }
        guard let currentInput = AudioRouteSetter.defaultInput() else {
            return .failure(RecorderError.noDefaultInput)
        }
        guard let currentInputUID = AudioDeviceUID.of(currentInput), !currentInputUID.isEmpty else {
            return .failure(RecorderError.noDefaultInput)
        }
        let marker = DefaultAudioDeviceMarker()
        do {
            try marker.record(.input, deviceUID: currentInputUID)
        } catch {
            return .failure(RecorderError.routeFailed("Audio recovery could not be prepared."))
        }
        guard AudioRouteSetter.setDefaultInput(dualSenseInput) == noErr else {
            try? marker.clear(.input)
            return .failure(RecorderError.routeFailed("macOS would not select the DualSense input."))
        }
        switch usbMic.start() {
        case .failure(let error):
            restoreInput(marker: marker, previous: currentInput)
            return .failure(RecorderError.routeFailed(error.localizedDescription))
        case .success:
            break
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-controller-mic-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
        ]
        let createdRecorder: AVAudioRecorder
        do {
            createdRecorder = try AVAudioRecorder(url: url, settings: settings)
        } catch {
            restoreInput(marker: marker, previous: currentInput)
            return .failure(RecorderError.recordFailed(error.localizedDescription))
        }
        guard createdRecorder.record() else {
            restoreInput(marker: marker, previous: currentInput)
            return .failure(RecorderError.recordFailed("The recorder could not start."))
        }
        recorder = createdRecorder
        fileURL = url
        previousInput = currentInput
        isRecording = true
        return .success(())
    }

    func stopAndTranscribe() async -> Result<String, Error> {
        guard isRecording, let recordedURL = fileURL, let previous = previousInput else {
            return .failure(RecorderError.alreadyRecording)
        }
        let marker = DefaultAudioDeviceMarker()
        recorder?.stop()
        recorder = nil
        fileURL = nil
        usbMic.stop()
        restoreInput(marker: marker, previous: previous)
        previousInput = nil
        isRecording = false

        guard let recognizer = makeRecognizer() else {
            return .failure(RecorderError.recognizerUnavailable)
        }
        let request = SFSpeechURLRecognitionRequest(url: recordedURL)
        request.shouldReportPartialResults = false
        // Dictation, not a search query: the sentence is sent verbatim to an
        // agent, so punctuation carries meaning.
        request.addsPunctuation = true
        request.taskHint = .dictation
        return await transcribe(recognizer: recognizer, request: request)
    }

    /// The system locale is whatever the Mac is set to — often English, which
    /// turns Italian speech into nonsense words. The spoken language of this
    /// app is fixed, so the recogniser follows it and only falls back to the
    /// system when that locale has no recogniser installed.
    private func makeRecognizer() -> SFSpeechRecognizer? {
        for locale in Self.preferredLocales {
            guard let recognizer = SFSpeechRecognizer(locale: locale) else { continue }
            if recognizer.isAvailable { return recognizer }
        }
        return SFSpeechRecognizer()
    }

    private func transcribe(
        recognizer: SFSpeechRecognizer,
        request: SFSpeechURLRecognitionRequest
    ) async -> Result<String, Error> {
        await withCheckedContinuation { continuation in
            let settle = SettleOnce()
            recognizer.recognitionTask(with: request) { result, error in
                if let error {
                    settle.settle {
                        continuation.resume(
                            returning: .failure(
                                RecorderError.transcriptionFailed(error.localizedDescription)
                            )
                        )
                    }
                } else if let result, result.isFinal {
                    settle.settle {
                        continuation.resume(returning: .success(result.bestTranscription.formattedString))
                    }
                }
            }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(20))
                settle.settle {
                    continuation.resume(
                        returning: .failure(RecorderError.transcriptionFailed("Transcription timed out."))
                    )
                }
            }
        }
    }

    private func restoreInput(marker: DefaultAudioDeviceMarker, previous: AudioDeviceID) {
        _ = AudioRouteSetter.setDefaultInput(previous)
        try? marker.clear(.input)
    }

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        let status = SFSpeechRecognizer.authorizationStatus()
        guard status == .notDetermined else { return status }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { _ in
                continuation.resume(returning: SFSpeechRecognizer.authorizationStatus())
            }
        }
    }
}

/// Runs a continuation-resuming block exactly once, from any thread.
private final class SettleOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var settled = false

    func settle(_ body: () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard !settled else { return }
        settled = true
        body()
    }
}
