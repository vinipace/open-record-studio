import Foundation
import ApplicationServices

// Deterministic AX geometry regression tests; no keyboard, screen or app access.
final class GeometryCapture: InteractionCapture, @unchecked Sendable {
    let field = AXUIElementCreateApplication(1)
    let parent = AXUIElementCreateApplication(2)
    var caret: CGRect? = .zero
    var fieldFrame: CGRect? = CGRect(x: 250, y: 220, width: 300, height: 120)
    var parentFrame: CGRect?
    var selectedLength = 0
    var hasFocus = true
    override func focused() -> AXUIElement? { hasFocus ? field : nil }
    override func range(_ element: AXUIElement) -> (CFRange, CGRect?)? { (CFRange(location: 5, length: selectedLength), caret) }
    override func frame(_ element: AXUIElement) -> CGRect? { CFEqual(element, field) ? fieldFrame : parentFrame }
    override func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        name == kAXParentAttribute && CFEqual(element, field) ? parent : nil
    }
    override func allowed(_ point: CGPoint) -> Bool { !stopped && bounds.contains(point) }
}
@main struct GeometryTests {
    static func main() {
        let capture = GeometryCapture()
        capture.bounds = CGRect(x: 200, y: 100, width: 800, height: 600)
        // Browser AX returns (0,0,0,0), mouse is on another monitor.
        capture.receive(.keyDown, CGPoint(x: -500, y: 100), 1, 0, [])
        assert(capture.events.count == 1)
        assert(capture.events[0]["position"] as? String == "element")
        assert(abs((capture.events[0]["x"] as! Double) - 0.25) < 0.001)
        // Legitimate zero-width caret must retain precise focus.
        capture.caret = CGRect(x: 700, y: 400, width: 0, height: 20)
        capture.receive(.keyDown, .zero, 3, 0, [])
        assert(capture.events.count == 2)
        assert(capture.events[1]["position"] as? String == "caret")
        // Broken caret and field geometry uses a visible parent.
        capture.caret = CGRect(x: 0, y: 0, width: 0, height: 10)
        capture.fieldFrame = nil
        capture.parentFrame = CGRect(x: 400, y: 200, width: 100, height: 100)
        capture.receive(.keyDown, .zero, 5, 0, [])
        assert(capture.events.count == 3)
        assert(capture.events[2]["position"] as? String == "element")
        // Missing selection bounds retain the selection event and provenance.
        capture.selectedLength = 4
        capture.selection()
        assert(capture.events.last?["type"] as? String == "selection")
        assert(capture.events.last?["rect"] == nil)
        assert(capture.events.last?["position"] as? String == "element")
        let count = capture.events.count
        capture.selection()
        assert(capture.events.count == count)
        // No keyboard shortcuts, escape, or unsafe/unresolved focus fallback.
        capture.receive(.keyDown, CGPoint(x: 500, y: 200), 8, 0, .maskCommand)
        capture.receive(.keyDown, CGPoint(x: 500, y: 200), 9, 53, [])
        capture.hasFocus = false
        capture.receive(.keyDown, CGPoint(x: 500, y: 200), 10, 0, [])
        assert(capture.events.count == count && capture.missingFocus == 1)
        assert(capture.textGeometry(CGRect(x: Double.nan, y: 100, width: 1, height: 10)) == nil)
        print("Native typing and selection geometry checks passed")
    }
}
