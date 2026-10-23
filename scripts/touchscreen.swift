import AppKit
import ApplicationServices
import IOKit

// The attached CVTouch panel exposes an absolute USB mouse. macOS scales its
// coordinates to the desktop but does not rotate them with the display.
let vendorID = 0x1ff7
let productID = 0x0013
// CoreGraphics' sender registry ID is undocumented. Resolve and verify the USB
// identity before changing any event; unknown senders always pass through.
let senderField = CGEventField(rawValue: 87)!
var senderCache: [UInt64: Bool] = [:]
var eventTap: CFMachPort?
var displayBounds = CGRect.zero
var displayRotation = 0
var displayAvailable = false
var correctedEvents = 0
var correctedClicks = 0
var displayUUID = ""
var calibration: TouchCalibration?
var calibrationSession: CalibrationSession?
let calibrationURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("touch-calibration.json")

struct TouchSample {
    let measured: CGPoint
    let target: CGPoint
}

struct TouchCalibration: Codable {
    let version: Int
    let display: String
    let rotation: Int
    let coefficients: [Double]
    let rmsErrorPixels: Double

    var isValid: Bool {
        guard version == 1, coefficients.count == 6, coefficients.allSatisfy({ $0.isFinite }),
              rmsErrorPixels.isFinite, rmsErrorPixels >= 0, rmsErrorPixels <= 25 else { return false }
        let c = coefficients
        return (0.5...1.5).contains(c[0]) && (0.5...1.5).contains(c[4]) &&
            abs(c[1]) < 0.5 && abs(c[3]) < 0.5 && abs(c[2]) < 0.35 && abs(c[5]) < 0.35 &&
            (0.3...2.5).contains(c[0] * c[4] - c[1] * c[3])
    }

    func apply(_ point: CGPoint) -> CGPoint {
        let c = coefficients
        return CGPoint(x: c[0] * point.x + c[1] * point.y + c[2],
                       y: c[3] * point.x + c[4] * point.y + c[5])
    }
}

enum CalibrationError: Error { case inconsistentSamples }

// Least-squares affine fit corrects offsets, scale, and small axis skew together.
func fitCalibration(_ samples: [TouchSample], bounds: CGRect) throws -> TouchCalibration {
    guard samples.count >= 5 else { throw CalibrationError.inconsistentSamples }
    var matrix = Array(repeating: Array(repeating: 0.0, count: 5), count: 3)
    for sample in samples {
        let row = [sample.measured.x, sample.measured.y, 1]
        for i in 0..<3 {
            for j in 0..<3 { matrix[i][j] += row[i] * row[j] }
            matrix[i][3] += row[i] * sample.target.x
            matrix[i][4] += row[i] * sample.target.y
        }
    }
    for column in 0..<3 {
        let pivot = (column..<3).max { abs(matrix[$0][column]) < abs(matrix[$1][column]) }!
        guard abs(matrix[pivot][column]) > 1e-9 else { throw CalibrationError.inconsistentSamples }
        matrix.swapAt(column, pivot)
        let divisor = matrix[column][column]
        for j in column..<5 { matrix[column][j] /= divisor }
        for i in 0..<3 where i != column {
            let multiplier = matrix[i][column]
            for j in column..<5 { matrix[i][j] -= multiplier * matrix[column][j] }
        }
    }
    let coefficients = [matrix[0][3], matrix[1][3], matrix[2][3], matrix[0][4], matrix[1][4], matrix[2][4]]
    let provisional = TouchCalibration(version: 1, display: displayUUID, rotation: displayRotation, coefficients: coefficients, rmsErrorPixels: 0)
    let errors = samples.map { sample in
        let fitted = provisional.apply(sample.measured)
        return hypot((fitted.x - sample.target.x) * bounds.width, (fitted.y - sample.target.y) * bounds.height)
    }
    let result = TouchCalibration(version: 1, display: displayUUID, rotation: displayRotation, coefficients: coefficients,
                                  rmsErrorPixels: sqrt(errors.reduce(0) { $0 + $1 * $1 } / Double(errors.count)))
    guard result.isValid, errors.allSatisfy({ $0 <= 50 }) else { throw CalibrationError.inconsistentSamples }
    return result
}

func normalized(_ point: CGPoint) -> CGPoint {
    CGPoint(x: (point.x - displayBounds.minX) / displayBounds.width,
            y: (point.y - displayBounds.minY) / displayBounds.height)
}

func calibratedPoint(_ rotated: CGPoint) -> CGPoint {
    guard let calibration else { return rotated }
    let point = calibration.apply(normalized(rotated))
    return CGPoint(x: displayBounds.minX + min(displayBounds.width - 1, max(0, point.x * displayBounds.width)),
                   y: displayBounds.minY + min(displayBounds.height - 1, max(0, point.y * displayBounds.height)))
}

func loadCalibration() {
    calibration = nil
    guard FileManager.default.fileExists(atPath: calibrationURL.path) else { return }
    do {
        let saved = try JSONDecoder().decode(TouchCalibration.self, from: Data(contentsOf: calibrationURL))
        guard saved.isValid, saved.display == displayUUID, saved.rotation == displayRotation else {
            log("Saved calibration does not match this display orientation; using rotation only.")
            return
        }
        calibration = saved
        log(String(format: "Loaded nine-point calibration (fit error %.1f pixels).", saved.rmsErrorPixels))
    } catch { log("Could not read touch calibration: \(error.localizedDescription)") }
}

class CalibrationWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    override func cancelOperation(_ sender: Any?) { calibrationSession?.close() }
}

class CalibrationView: NSView {
    weak var session: CalibrationSession?
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { session?.close() }
    }
    override func mouseUp(with event: NSEvent) {
        // A regular mouse may dismiss the test screen, but cannot supply samples.
        if session?.testing == true, doneRect.contains(convert(event.locationInWindow, from: nil)) { session?.close() }
    }
    var doneRect: CGRect { CGRect(x: bounds.midX - 130, y: bounds.height - 130, width: 260, height: 70) }
    func text(_ string: String, y: Double, size: Double, color: NSColor = .white) {
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        (string as NSString).draw(in: CGRect(x: 50, y: y, width: bounds.width - 100, height: 100), withAttributes: [
            .font: NSFont.systemFont(ofSize: size, weight: .medium), .foregroundColor: color, .paragraphStyle: style,
        ])
    }
    func crosshair(_ point: CGPoint, color: NSColor) {
        color.setStroke()
        let ring = NSBezierPath(ovalIn: CGRect(x: point.x - 26, y: point.y - 26, width: 52, height: 52))
        ring.lineWidth = 3
        ring.stroke()
        let lines = NSBezierPath()
        lines.move(to: CGPoint(x: point.x - 44, y: point.y))
        lines.line(to: CGPoint(x: point.x + 44, y: point.y))
        lines.move(to: CGPoint(x: point.x, y: point.y - 44))
        lines.line(to: CGPoint(x: point.x, y: point.y + 44))
        lines.lineWidth = 2
        lines.stroke()
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedRed: 0.035, green: 0.055, blue: 0.10, alpha: 1).setFill()
        bounds.fill()
        guard let session else { return }
        if session.testing {
            text("Calibration saved", y: 44, size: 34)
            text("Tap the targets to check alignment.", y: 96, size: 23)
            for target in session.targets {
                crosshair(CGPoint(x: target.x * bounds.width, y: target.y * bounds.height), color: .white)
            }
            if let point = session.testPoint {
                NSColor.systemGreen.setFill()
                NSBezierPath(ovalIn: CGRect(x: point.x * bounds.width - 8, y: point.y * bounds.height - 8, width: 16, height: 16)).fill()
            }
            NSColor.systemBlue.setFill()
            NSBezierPath(roundedRect: doneRect, xRadius: 18, yRadius: 18).fill()
            text("Done", y: doneRect.minY + 18, size: 25)
        } else {
            text("Touch calibration", y: 44, size: 34)
            text("Tap the center of the crosshair, then lift your finger.", y: 96, size: 23)
            let target = session.targets[session.samples.count]
            crosshair(CGPoint(x: target.x * bounds.width, y: target.y * bounds.height), color: .systemCyan)
            text("Target \(session.samples.count + 1) of \(session.targets.count)", y: bounds.height - 130, size: 28)
            if let message = session.message { text(message, y: bounds.height - 195, size: 20, color: .systemOrange) }
        }
        text("Press Esc to return to the kiosk", y: bounds.height - 45, size: 17, color: .lightGray)
    }
}

class CalibrationSession {
    let targets: [CGPoint] = [
        CGPoint(x: 0.12, y: 0.16), CGPoint(x: 0.50, y: 0.16), CGPoint(x: 0.88, y: 0.16),
        CGPoint(x: 0.88, y: 0.50), CGPoint(x: 0.50, y: 0.50), CGPoint(x: 0.12, y: 0.50),
        CGPoint(x: 0.12, y: 0.84), CGPoint(x: 0.50, y: 0.84), CGPoint(x: 0.88, y: 0.84),
    ]
    let window: CalibrationWindow
    let view: CalibrationView
    var samples: [TouchSample] = []
    var pendingTouch: CGPoint?
    var testing = false
    var testPoint: CGPoint?
    var message: String?
    var lastRelease: TimeInterval = 0

    init(screen: NSScreen) {
        window = CalibrationWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        view = CalibrationView(frame: CGRect(origin: .zero, size: screen.frame.size))
        view.session = self
        window.contentView = view
        window.isReleasedWhenClosed = false
        window.level = .screenSaver
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(view)
        NSApp.activate(ignoringOtherApps: true)
        log("Calibration started: waiting for nine physical panel taps. Esc cancels.")
    }

    func receive(_ type: CGEventType, rotated: CGPoint) {
        if testing {
            let point = normalized(calibratedPoint(rotated))
            testPoint = point
            if type == .leftMouseUp,
               view.doneRect.contains(CGPoint(x: point.x * view.bounds.width, y: point.y * view.bounds.height)) {
                close()
            }
            view.needsDisplay = true
            return
        }
        if type == .leftMouseDown, Date.timeIntervalSinceReferenceDate - lastRelease > 0.25 {
            pendingTouch = normalized(rotated)
        }
        guard type == .leftMouseUp, let measured = pendingTouch else { return }
        pendingTouch = nil
        lastRelease = Date.timeIntervalSinceReferenceDate
        let target = targets[samples.count]
        guard hypot((measured.x - target.x) * displayBounds.width, (measured.y - target.y) * displayBounds.height) < 220 else {
            message = "Please tap the crosshair shown on the screen."
            view.needsDisplay = true
            return
        }
        samples.append(TouchSample(measured: measured, target: target))
        message = nil
        log("Calibration target \(samples.count)/9 captured.")
        if samples.count == targets.count {
            do {
                let fitted = try fitCalibration(samples, bounds: displayBounds)
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                let data = try encoder.encode(fitted)
                try data.write(to: calibrationURL, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: calibrationURL.path)
                calibration = fitted
                testing = true
                log(String(format: "Calibration saved: RMS fit error %.1f pixels. Check the targets, then tap Done.", fitted.rmsErrorPixels))
            } catch {
                samples.removeAll()
                message = "Readings were inconsistent. Please tap each center again."
                log("Calibration rejected; previous mapping retained: \(error.localizedDescription)")
            }
        }
        view.needsDisplay = true
    }

    func close() {
        window.orderOut(nil)
        calibrationSession = nil
        log(testing ? "Calibration check closed; saved correction remains active." : "Calibration cancelled; previous mapping retained.")
    }
}

func beginCalibration() {
    guard eventTap != nil, displayAvailable, let screen = NSScreen.main else {
        log("Cannot calibrate until Accessibility is enabled and one display is active.")
        return
    }
    calibrationSession?.close()
    calibrationSession = CalibrationSession(screen: screen)
}

func log(_ message: String) {
    print(message)
    fflush(stdout)
}

func rotatedPoint(_ point: CGPoint, bounds: CGRect, rotation: Int) -> CGPoint {
    let x = min(1, max(0, (point.x - bounds.minX) / bounds.width))
    let y = min(1, max(0, (point.y - bounds.minY) / bounds.height))
    let rotated: (Double, Double)
    switch rotation {
    case 90: rotated = (1 - y, x)
    case 180: rotated = (1 - x, 1 - y)
    case 270: rotated = (y, 1 - x)
    default: return point
    }
    return CGPoint(
        x: bounds.minX + min(bounds.width - 1, rotated.0 * bounds.width),
        y: bounds.minY + min(bounds.height - 1, rotated.1 * bounds.height)
    )
}

func isTouchPanel(_ registryID: UInt64) -> Bool {
    guard registryID != 0 else { return false }
    if let cached = senderCache[registryID] { return cached }
    var entry = IOServiceGetMatchingService(kIOMainPortDefault, IORegistryEntryIDMatching(registryID))
    var matches = false
    // The event sender can be either the HID service or one of its children.
    while entry != 0 {
        let vendor = IORegistryEntryCreateCFProperty(entry, "VendorID" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber
        let product = IORegistryEntryCreateCFProperty(entry, "ProductID" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber
        if let vendor, let product {
            matches = vendor.intValue == vendorID && product.intValue == productID
            IOObjectRelease(entry)
            break
        }
        var parent: io_registry_entry_t = 0
        let result = IORegistryEntryGetParentEntry(entry, kIOServicePlane, &parent)
        IOObjectRelease(entry)
        entry = result == KERN_SUCCESS ? parent : 0
    }
    if senderCache.count > 64 { senderCache.removeAll() }
    senderCache[registryID] = matches
    return matches
}

func refreshDisplay() {
    calibrationSession?.close()
    var count: UInt32 = 0
    let result = CGGetActiveDisplayList(0, nil, &count)
    // The kiosk has one display. Pass input through if its layout is ambiguous.
    displayAvailable = result == .success && count == 1
    guard displayAvailable else {
        log("Touch rotation paused: requires exactly one active display.")
        return
    }
    let display = CGMainDisplayID()
    displayBounds = CGDisplayBounds(display)
    displayRotation = Int(CGDisplayRotation(display).rounded()) % 360
    if let uuid = CGDisplayCreateUUIDFromDisplayID(display)?.takeRetainedValue() {
        displayUUID = CFUUIDCreateString(nil, uuid) as String
    }
    loadCalibration()
    log("Touch panel 1ff7:0013 → display \(Int(displayBounds.width))×\(Int(displayBounds.height)), rotation \(displayRotation)°.")
}

func correctEvent(_ event: CGEvent) -> Bool {
    guard displayAvailable,
          isTouchPanel(UInt64(bitPattern: event.getIntegerValueField(senderField))) else { return false }
    event.location = calibratedPoint(rotatedPoint(event.location, bounds: displayBounds, rotation: displayRotation))
    return true
}

func handleEvent(_ proxy: CGEventTapProxy, _ type: CGEventType, _ event: CGEvent, _ context: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    if let session = calibrationSession, isTouchPanel(UInt64(bitPattern: event.getIntegerValueField(senderField))) {
        let rotated = rotatedPoint(event.location, bounds: displayBounds, rotation: displayRotation)
        CGWarpMouseCursorPosition(calibratedPoint(rotated))
        session.receive(type, rotated: rotated)
        return nil
    }
    if correctEvent(event) {
        CGWarpMouseCursorPosition(event.location)
        correctedEvents += 1
        if correctedEvents == 1 { log("Receiving and rotating input from the USB touch panel.") }
        if type == .leftMouseDown {
            correctedClicks += 1
            log("Corrected touch press \(correctedClicks).")
        }
    }
    return Unmanaged.passUnretained(event)
}

func selfTest() {
    let bounds = CGRect(x: 30, y: 50, width: 1080, height: 1920)
    let rawCorners = [CGPoint(x: 30, y: 50), CGPoint(x: 1110, y: 50), CGPoint(x: 30, y: 1970), CGPoint(x: 1110, y: 1970)]
    let expected: [Int: [CGPoint]] = [
        90: [CGPoint(x: 1109, y: 50), CGPoint(x: 1109, y: 1969), CGPoint(x: 30, y: 50), CGPoint(x: 30, y: 1969)],
        180: [CGPoint(x: 1109, y: 1969), CGPoint(x: 30, y: 1969), CGPoint(x: 1109, y: 50), CGPoint(x: 30, y: 50)],
        270: [CGPoint(x: 30, y: 1969), CGPoint(x: 30, y: 50), CGPoint(x: 1109, y: 1969), CGPoint(x: 1109, y: 50)],
    ]
    for rotation in [0, 90, 180, 270] {
        for (index, corner) in rawCorners.enumerated() {
            precondition(rotatedPoint(corner, bounds: bounds, rotation: rotation) == (rotation == 0 ? corner : expected[rotation]![index]))
        }
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        precondition(rotatedPoint(center, bounds: bounds, rotation: rotation) == center)
    }
    // Hardware attribution must fail closed, including ordinary synthetic input.
    precondition(!isTouchPanel(0))
    displayBounds = bounds
    displayRotation = 270
    displayAvailable = true
    let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: 100, y: 200), mouseButton: .left)!
    precondition(!correctEvent(event))
    precondition(event.location == CGPoint(x: 100, y: 200))
    let known = TouchCalibration(version: 1, display: "test", rotation: 270, coefficients: [1.04, 0.012, -0.025, -0.008, 0.97, 0.018], rmsErrorPixels: 0)
    let measured = [0.12, 0.50, 0.88].flatMap { x in [0.16, 0.50, 0.84].map { y in CGPoint(x: x, y: y) } }
    let samples = measured.map { TouchSample(measured: $0, target: known.apply($0)) }
    let fitted = try! fitCalibration(samples, bounds: bounds)
    for (actual, expected) in zip(fitted.coefficients, known.coefficients) { precondition(abs(actual - expected) < 1e-10) }
    var outliers = samples
    outliers[0] = TouchSample(measured: measured[0], target: CGPoint(x: 0.5, y: 0.9))
    precondition((try? fitCalibration(outliers, bounds: bounds)) == nil)
    let collinear = (0..<9).map { TouchSample(measured: CGPoint(x: Double($0) / 10, y: 0.5), target: CGPoint(x: 0.5, y: 0.5)) }
    precondition((try? fitCalibration(collinear, bounds: bounds)) == nil)
    let encoded = try! JSONEncoder().encode(fitted)
    let decoded = try! JSONDecoder().decode(TouchCalibration.self, from: encoded)
    precondition(decoded.isValid && decoded.coefficients == fitted.coefficients)
    calibration = known
    displayBounds = bounds
    let corrected = calibratedPoint(CGPoint(x: bounds.minX, y: bounds.minY))
    precondition(corrected.x >= bounds.minX && corrected.y >= bounds.minY)
    log("Passed: rotation corners, display offsets, unrelated input, affine offset/scale/skew recovery, bad sample rejection, saved calibration, and edge clamping.")
}

if CommandLine.arguments.contains("--self-test") {
    selfTest()
    exit(0)
}

if CommandLine.arguments.contains("--status") {
    refreshDisplay()
    log("Accessibility permission: \(AXIsProcessTrusted() ? "granted" : "required")")
    exit(AXIsProcessTrusted() ? 0 : 2)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
if CommandLine.arguments.contains("--request-permission") {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
}

var permissionMessageShown = false
func startTapIfPermitted() {
    guard eventTap == nil else { return }
    guard AXIsProcessTrusted() else {
        if !permissionMessageShown {
            log("Waiting for Accessibility permission for Still Touch in System Settings → Privacy & Security → Accessibility.")
            permissionMessageShown = true
        }
        return
    }
    let types: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp, .rightMouseDragged, .otherMouseDown, .otherMouseUp, .otherMouseDragged]
    let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
    guard let tap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: handleEvent, userInfo: nil) else {
        log("Could not create touch event tap; waiting for macOS permission.")
        return
    }
    eventTap = tap
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0), .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    refreshDisplay()
    log("Touch rotation active. Other input devices pass through unchanged.")
}

CGDisplayRegisterReconfigurationCallback({ _, flags, _ in
    if !flags.contains(.beginConfigurationFlag) { refreshDisplay() }
}, nil)
startTapIfPermitted()
let permissionTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in startTapIfPermitted() }
signal(SIGUSR1, SIG_IGN)
let calibrationSignal = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
calibrationSignal.setEventHandler { beginCalibration() }
calibrationSignal.resume()
app.run()
