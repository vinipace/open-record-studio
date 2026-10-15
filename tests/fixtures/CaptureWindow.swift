import AppKit
import Foundation

// An opt-in on-screen target for the live ScreenCaptureKit check. It contains
// only generated artwork, a clock and clickable targets; no user content.
func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value)
    FileHandle.standardOutput.write(data + Data([10]))
}
final class TargetView: NSView {
    let started = ProcessInfo.processInfo.systemUptime
    override func mouseDown(with event: NSEvent) { logPointer(event) }
    override func mouseDragged(with event: NSEvent) { logPointer(event) }
    override func mouseUp(with event: NSEvent) { logPointer(event) }
    func logPointer(_ event: NSEvent) {
        let local = event.locationInWindow
        let global = CGEvent(source: nil)?.location ?? .zero
        emit(["event": "pointer", "localX": local.x, "localY": local.y, "systemX": global.x, "systemY": global.y, "pressed": NSEvent.pressedMouseButtons, "wallTime": Date().timeIntervalSince1970])
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedRed: 0.055, green: 0.07, blue: 0.12, alpha: 1).setFill()
        bounds.fill()
        let elapsed = ProcessInfo.processInfo.systemUptime - started
        let text = String(format: "LIVE CAPTURE CHECK   %06.2f s", elapsed)
        text.draw(at: NSPoint(x: 40, y: 390), withAttributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 26, weight: .semibold),
            .foregroundColor: NSColor.white,
        ])
        "Generated test window · No camera or microphone".draw(at: NSPoint(x: 40, y: 350), withAttributes: [
            .font: NSFont.systemFont(ofSize: 18), .foregroundColor: NSColor.lightGray,
        ])
        for i in 0..<12 {
            NSColor(calibratedHue: CGFloat(i) / 12, saturation: 0.7, brightness: 0.9, alpha: 1).setFill()
            NSRect(x: 40 + i * 58, y: 255, width: 54, height: 60).fill()
        }
        NSColor.systemPink.setFill()
        NSBezierPath(roundedRect: NSRect(x: 40 + 650 * (sin(elapsed * 2) + 1) / 2, y: 200, width: 38, height: 30), xRadius: 8, yRadius: 8).fill()
    }
}
final class Delegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var timer: Timer!
    var runButton: NSButton!
    var count = 0
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 80, y: 90, width: 800, height: 480), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Open Record Studio Capture Test"
        window.isReleasedWhenClosed = false
        let view = TargetView(frame: NSRect(x: 0, y: 0, width: 800, height: 480))
        window.contentView = view
        runButton = NSButton(title: "Run five-second check", target: self, action: #selector(run))
        runButton.frame = NSRect(x: 40, y: 55, width: 230, height: 50)
        runButton.bezelStyle = .rounded
        view.addSubview(runButton)
        for (i, name) in ["Target A", "Target B", "Target C"].enumerated() {
            let button = NSButton(title: name, target: self, action: #selector(hit(_:)))
            button.frame = NSRect(x: 310 + i * 145, y: 55, width: 125, height: 50)
            button.bezelStyle = .rounded
            view.addSubview(button)
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { _ in view.needsDisplay = true }
        emit(["event": "ready", "windowID": window.windowNumber])
    }
    @objc func run() { runButton.isEnabled = false; emit(["event": "run", "windowID": window.windowNumber]) }
    @objc func hit(_ sender: NSButton) { count += 1; emit(["event": "hit", "target": sender.title, "count": count, "wallTime": Date().timeIntervalSince1970]) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
