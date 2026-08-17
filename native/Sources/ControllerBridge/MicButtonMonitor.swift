import Foundation
import IOKit.hid

/// Watches the DualSense mic (mute) button, which GameController does not
/// expose. USB input reports (0x01) keep carrying button state even while the
/// internal microphone route is active, so push-to-talk works over USB.
///
/// Button location per Sony's hid-playstation layout: `buttons[2]` is byte 10
/// of the report and `DS_BUTTONS2_MIC` is `BIT(2)`.
final class MicButtonMonitor {
    private var manager: IOHIDManager?
    private var device: IOHIDDevice?
    private var onPressedChanged: ((Bool) -> Void)?
    private(set) var isPressed = false

    private let reportCallback: IOHIDReportCallback = {
        context, result, _, _, _, report, reportLength in
        guard result == kIOReturnSuccess, let context else { return }
        let monitor = Unmanaged<MicButtonMonitor>.fromOpaque(context).takeUnretainedValue()
        let bytes = Array(UnsafeBufferPointer(start: report, count: Int(reportLength)))
        monitor.receive(bytes)
    }

    func start(onPressedChanged: @escaping (Bool) -> Void) {
        stop()
        let createdManager = IOHIDManagerCreate(
            kCFAllocatorDefault,
            IOOptionBits(kIOHIDOptionsTypeNone)
        )
        IOHIDManagerSetDeviceMatchingMultiple(
            createdManager,
            DualSenseHIDIdentity.matchingDictionaries as CFArray
        )
        let options = IOOptionBits(kIOHIDOptionsTypeNone)
        guard IOHIDManagerOpen(createdManager, options) == kIOReturnSuccess else { return }
        let devices = (IOHIDManagerCopyDevices(createdManager) as? Set<IOHIDDevice>) ?? []
        let candidates = devices.filter {
            transport($0)?.caseInsensitiveCompare("USB") == .orderedSame
        }
        guard let selected = candidates.first,
              IOHIDDeviceOpen(selected, options) == kIOReturnSuccess else {
            IOHIDManagerClose(createdManager, options)
            return
        }
        manager = createdManager
        device = selected
        self.onPressedChanged = onPressedChanged
        let context = Unmanaged.passUnretained(self).toOpaque()
        IOHIDManagerRegisterInputReportCallback(createdManager, reportCallback, context)
        IOHIDManagerScheduleWithRunLoop(
            createdManager,
            CFRunLoopGetMain(),
            CFRunLoopMode.commonModes.rawValue
        )
    }

    func stop() {
        if let manager {
            IOHIDManagerUnscheduleFromRunLoop(
                manager,
                CFRunLoopGetMain(),
                CFRunLoopMode.commonModes.rawValue
            )
            IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        }
        if let device {
            IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone))
        }
        manager = nil
        device = nil
        onPressedChanged = nil
        isPressed = false
    }

    private func receive(_ bytes: [UInt8]) {
        guard bytes.count >= 11, bytes[0] == 0x01 else { return }
        // BIT(2). BIT(1) next door is the touchpad click, already handled by
        // GameController as the rescan button.
        let pressed = bytes[10] & 0x04 != 0
        guard pressed != isPressed else { return }
        isPressed = pressed
        onPressedChanged?(pressed)
    }
}

private let transport: (IOHIDDevice) -> String? = { device in
    IOHIDDeviceGetProperty(device, kIOHIDTransportKey as CFString) as? String
}
