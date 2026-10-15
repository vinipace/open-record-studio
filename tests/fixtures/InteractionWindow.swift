import AppKit
import Foundation

// Generated text only. Input injection stops immediately if this dedicated
// fixture is no longer the frontmost app; never sends input to another app.
func emit(_ value: [String:Any]) {
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject:value) + Data([10]))
}
final class Delegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var text: NSTextView!
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x:100,y:180,width:720,height:420),styleMask:[.titled,.closable],backing:.buffered,defer:false)
        window.title = "Open Record Studio Interaction Test"
        text = NSTextView(frame:NSRect(x:30,y:30,width:660,height:340))
        text.font = .systemFont(ofSize:26)
        text.string = "Generated text for testing recording interactions.\nSelect this sentence and type in this test window.\n"
        text.isRichText = false
        window.contentView!.addSubview(text)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(text)
        NSApp.activate(ignoringOtherApps:true)
        emit(["event":"ready","windowID":window.windowNumber])
        DispatchQueue.global().async {
            while let line = readLine() {
                if line == "run" { DispatchQueue.main.async {
                    self.window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true)
                    self.later(0.7) { self.run() }
                } }
            }
        }
    }
    func active() -> Bool { NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier && window.isKeyWindow }
    func later(_ delay: Double, _ action: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline:.now()+delay) {
            guard self.active() else { emit(["event":"aborted","reason":"Test window lost focus"]); return }
            action()
        }
    }
    func run() {
        guard active() else { emit(["event":"aborted","reason":"Test window is not active"]); return }
        let rect = window.convertToScreen(text.convert(NSRect(x:60,y:100,width:1,height:1),to:nil))
        let point = CGPoint(x:rect.midX,y:NSScreen.screens[0].frame.height-rect.midY)
        CGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:point,mouseButton:.left)?.post(tap:.cghidEventTap)
        CGEvent(mouseEventSource:nil,mouseType:.leftMouseDown,mouseCursorPosition:point,mouseButton:.left)?.post(tap:.cghidEventTap)
        CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:point,mouseButton:.left)?.post(tap:.cghidEventTap)
        for i in 1...30 {
            later(0.03+Double(i)*0.015) {
                let moved = CGPoint(x:point.x+Double(i)*4,y:point.y)
                CGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:moved,mouseButton:.left)?.post(tap:.cghidEventTap)
            }
        }
        later(0.5) { self.text.setSelectedRange(NSRange(location:self.text.string.utf16.count,length:0)) }
        for i in 0..<5 {
            later(0.8+Double(i)*0.18) {
                CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true)?.post(tap:.cghidEventTap)
                CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false)?.post(tap:.cghidEventTap)
            }
        }
        later(2.1) { self.text.setSelectedRange(NSRange(location:10,length:24)) }
        later(2.8) { self.text.setSelectedRange(NSRange(location:10,length:34)) }
        later(3.6) { emit(["event":"done","length":self.text.string.utf16.count]) }
    }
}
let app = NSApplication.shared, delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
