import AppKit
import Foundation

// A generated, opaque display cover keeps the live exclusion test from
// recording unrelated desktop content. It exits when its parent closes stdin.
final class Surface: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor(srgbRed: 0.08, green: 0.35, blue: 0.28, alpha: 1).setFill()
        bounds.fill()
        "Open Record Studio · Webcam preview exclusion test".draw(at: NSPoint(x: 60, y: bounds.height - 100), withAttributes: [
            .font: NSFont.systemFont(ofSize: 22, weight: .medium),
            .foregroundColor: NSColor.white,
        ])
        "Generated screen and camera. No personal content or live camera input.".draw(at: NSPoint(x: 60, y: bounds.height - 140), withAttributes: [
            .font: NSFont.systemFont(ofSize: 16), .foregroundColor: NSColor.white,
        ])
    }
}
final class Delegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    func applicationDidFinishLaunching(_ notification: Notification) {
        let requested = CommandLine.arguments.dropFirst().first.flatMap(UInt32.init)
        guard let screen = NSScreen.screens.first(where: {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == requested
        }) else { exit(1) }
        window = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.screenSaverWindow)))
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.contentView = Surface(frame: NSRect(origin: .zero, size: screen.frame.size))
        window.orderFrontRegardless()
        let display = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as! NSNumber
        let bytes = try! JSONSerialization.data(withJSONObject: ["displayID": display, "windowID": window.windowNumber])
        FileHandle.standardOutput.write(bytes + Data([10]))
        DispatchQueue.global().async {
            _ = readLine()
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
}
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
