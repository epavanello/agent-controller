import Darwin
import Foundation

/// Makes the bridge answer to TCC for itself.
///
/// TCC reads the privacy usage strings from the *responsible* process, which is
/// inherited: launched by Electron, which was launched from a terminal, the
/// responsible process is that terminal's app. None of them declare
/// `NSSpeechRecognitionUsageDescription`, so the first authorization request
/// kills the bridge with SIGABRT no matter what its own Info.plist says.
///
/// So the process re-launches itself once, disclaiming the inherited
/// responsibility. The relaunched copy is its own responsible process and TCC
/// reads the usage strings embedded in this binary (see `Package.swift`). The
/// first copy stays alive as a thin trampoline: it holds the stdio pipes open
/// for the caller, forwards termination signals, and exits with the child's
/// status.
enum ResponsibilityDisclaimer {
    private static let marker = "AGENT_CONTROLLER_BRIDGE_DISCLAIMED"

    /// Returns only if this process is already the disclaimed copy, or if the
    /// relaunch is not possible — in which case the bridge runs as before.
    static func relaunchIfNeeded() {
        guard ProcessInfo.processInfo.environment[marker] == nil else { return }
        guard let setDisclaim = disclaimFunction() else { return }
        guard let executable = executablePath() else { return }

        var attributes: posix_spawnattr_t?
        guard posix_spawnattr_init(&attributes) == 0 else { return }
        defer { posix_spawnattr_destroy(&attributes) }
        guard setDisclaim(&attributes, 1) == 0 else { return }

        var environment = ProcessInfo.processInfo.environment
        environment[marker] = "1"
        let arguments = [executable] + CommandLine.arguments.dropFirst()
        let argv = CStringArray(arguments)
        let envp = CStringArray(environment.map { "\($0.key)=\($0.value)" })

        var child: pid_t = 0
        // stdin, stdout and stderr are inherited: the child talks to the caller
        // over the very same pipes.
        guard posix_spawn(&child, executable, nil, &attributes, argv.pointers, envp.pointers) == 0
        else { return }

        disclaimedChild = child
        forwardTerminationSignals()
        var status: Int32 = 0
        while waitpid(child, &status, 0) == -1 && errno == EINTR { continue }
        exit(exitCode(from: status))
    }

    private typealias SetDisclaim = @convention(c) (
        UnsafeMutablePointer<posix_spawnattr_t?>, Int32
    ) -> Int32

    private static func disclaimFunction() -> SetDisclaim? {
        // Private, but the only way to reset responsibility, and present since
        // macOS 10.14. Looked up dynamically so a future removal degrades to
        // the old behaviour instead of failing to launch.
        let rtldDefault = UnsafeMutableRawPointer(bitPattern: -2)
        guard let symbol = dlsym(rtldDefault, "responsibility_spawnattrs_setdisclaim") else {
            return nil
        }
        return unsafeBitCast(symbol, to: SetDisclaim.self)
    }

    /// `argv[0]` may be a relative path resolved against a working directory
    /// the child does not necessarily share.
    private static func executablePath() -> String? {
        var size = UInt32(PATH_MAX)
        var buffer = [CChar](repeating: 0, count: Int(size))
        guard _NSGetExecutablePath(&buffer, &size) == 0 else { return nil }
        return String(cString: buffer)
    }

    private static func exitCode(from status: Int32) -> Int32 {
        // Mirrors the child's fate: a crash must not read as a clean exit.
        if status & 0x7f == 0 { return (status >> 8) & 0xff }
        return 128 + (status & 0x7f)
    }

    private static func forwardTerminationSignals() {
        for number in [SIGTERM, SIGINT, SIGHUP, SIGQUIT] {
            signal(number) { received in
                if disclaimedChild > 0 { kill(disclaimedChild, received) }
            }
        }
    }
}

/// Set before any handler can run; read from a signal handler, which cannot
/// capture context.
private nonisolated(unsafe) var disclaimedChild: pid_t = 0

/// Keeps the C strings alive for the duration of the spawn: an array's own
/// pointer would only be valid for the call that converts it.
private final class CStringArray {
    let pointers: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>
    private let count: Int

    init(_ values: [String]) {
        count = values.count
        pointers = .allocate(capacity: values.count + 1)
        for (index, value) in values.enumerated() { pointers[index] = strdup(value) }
        pointers[values.count] = nil
    }

    deinit {
        for index in 0..<count { free(pointers[index]) }
        pointers.deallocate()
    }
}
