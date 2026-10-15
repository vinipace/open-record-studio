import Foundation
import AppKit
import ApplicationServices
import AVFoundation

// Only timing and geometry are retained. Never read keyboard strings, AX text values,
// selected text, clipboard contents or secure text fields.
class InteractionCapture: @unchecked Sendable {
    let queue = DispatchQueue(label: "local.framestudio.interactions", qos: .utility)
    var bounds = CGRect.zero
    var windowID: CGWindowID?
    var ownerPID: pid_t?
    var excluded = Set<pid_t>()
    var tap: CFMachPort?
    var timer: DispatchSourceTimer?
    var events = [[String:Any]]()
    var truncated = false
    var stopped = false
    var keyboard = false
    var pointer = false
    var accessibility = false
    var inputMonitoring = false
    var lastSelection = ""
    var lastFocus: AXUIElement?
    var preparedApps = Set<pid_t>()
    var keyboardEvents = 0
    var missingFocus = 0
    var missingGeometry = 0
    var pointerDown: (Double, CGPoint)?

    static func permissions(request: Bool = false) -> [String:Bool] {
        if request {
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary)
            if !CGPreflightListenEventAccess() { _ = CGRequestListenEventAccess() }
        }
        return ["accessibility": AXIsProcessTrusted(), "inputMonitoring": CGPreflightListenEventAccess()]
    }
    func start(bounds: CGRect, windowID: CGWindowID?, ownerPID: pid_t?, excluded: [pid_t]) {
        self.bounds = bounds; self.windowID = windowID; self.ownerPID = ownerPID; self.excluded = Set(excluded)
        let permissions = Self.permissions()
        accessibility = permissions["accessibility"] == true
        inputMonitoring = permissions["inputMonitoring"] == true
        let mouseTypes: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseUp, .scrollWheel]
        func install(_ types: [CGEventType]) -> CFMachPort? {
            let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
            return CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, context in
                guard let context else { return Unmanaged.passUnretained(event) }
                let monitor = Unmanaged<InteractionCapture>.fromOpaque(context).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    if let tap = monitor.tap { CGEvent.tapEnable(tap: tap, enable: true) }
                } else {
                    let point = event.location, host = CMClockGetTime(CMClockGetHostTimeClock()).seconds
                    let key = event.getIntegerValueField(.keyboardEventKeycode), flags = event.flags
                    monitor.queue.async { monitor.receive(type, point, host, key, flags) }
                }
                return Unmanaged.passUnretained(event)
            }, userInfo: Unmanaged.passUnretained(self).toOpaque())
        }
        // Keyboard events require AX access so secure fields can be excluded.
        if accessibility { tap = install(mouseTypes + [.keyDown]); keyboard = tap != nil }
        if tap == nil { tap = install(mouseTypes) }
        pointer = tap != nil
        if let tap {
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        if accessibility {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now(), repeating: 0.15, leeway: .milliseconds(20))
            timer.setEventHandler { [weak self] in self?.selection() }
            self.timer = timer; timer.resume()
        }
    }
    var trackingStatus: [String:Any] {
        ["permissions":["accessibility":accessibility,"inputMonitoring":inputMonitoring],"capabilities":["click":pointer,"typing":keyboard,"selection":accessibility,"scroll":pointer,"drag":pointer]]
    }
    var ready: Bool { accessibility && inputMonitoring && keyboard && pointer && tap.map { CGEvent.tapIsEnabled(tap: $0) } == true }
    func updateBounds(_ bounds: CGRect) { queue.async { self.bounds = bounds } }
    func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var result: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else { return nil }
        return result
    }
    func element(_ value: CFTypeRef?) -> AXUIElement? {
        guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }
    func frame(_ element: AXUIElement) -> CGRect? {
        guard let p = attribute(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
              let s = attribute(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point), AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }
    func focused() -> AXUIElement? {
        guard accessibility, let app = NSWorkspace.shared.frontmostApplication, !excluded.contains(app.processIdentifier), ownerPID == nil || ownerPID == app.processIdentifier else { return nil }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.05)
        if preparedApps.insert(app.processIdentifier).inserted {
            // Chromium/Electron lazily expose web text fields. Request their AX
            // tree once per app, not on every keystroke (which restarts debounce).
            // Unsupported attributes on native apps are harmless.
            _ = attribute(root, kAXRoleAttribute)
            if AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue) != .success {
                _ = AXUIElementSetAttributeValue(root, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            }
        }
        if let window = element(attribute(root, kAXFocusedWindowAttribute)), let rect = frame(window), !rect.intersects(bounds) { return nil }
        if windowID != nil {
            // Window capture bounds may omit the title bar/shadow. Check overlap
            // here; allowed() still checks the actual topmost CGWindowID.
            guard let window = element(attribute(root, kAXFocusedWindowAttribute)), let rect = frame(window),
                  rect.intersection(bounds).width >= min(rect.width, bounds.width) * 0.8,
                  rect.intersection(bounds).height >= min(rect.height, bounds.height) * 0.8 else { return nil }
        }
        var field = element(attribute(root, kAXFocusedUIElementAttribute))
        if field == nil {
            let system = AXUIElementCreateSystemWide()
            AXUIElementSetMessagingTimeout(system, 0.05)
            field = element(attribute(system, kAXFocusedUIElementAttribute))
        }
        guard var field else { return nil }
        // Some web editors expose focus through a container's focused child.
        for _ in 0..<4 {
            AXUIElementSetMessagingTimeout(field, 0.05)
            guard let child = element(attribute(field, kAXFocusedUIElementAttribute)), !CFEqual(child, field) else { break }
            field = child
        }
        var pid: pid_t = 0
        guard AXUIElementGetPid(field, &pid) == .success, pid == app.processIdentifier,
              attribute(field, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole else { return nil }
        return field
    }
    // A caret is legitimately zero pixels wide, but (0,0,0,0), offscreen and
    // non-finite AX rectangles are not usable. Do not let those swallow input.
    func textGeometry(_ rect: CGRect?) -> CGRect? {
        guard let rect, rect.origin.x.isFinite, rect.origin.y.isFinite,
              rect.width.isFinite, rect.height.isFinite, rect.width >= 0, rect.height > 0 else { return nil }
        let usable = CGRect(x: rect.minX, y: rect.minY, width: max(1, rect.width), height: rect.height).intersection(bounds)
        return usable.isNull || usable.isEmpty ? nil : usable
    }
    func fallbackPoint(_ field: AXUIElement, pointer: CGPoint) -> CGPoint? {
        var candidate: AXUIElement? = field
        for _ in 0..<5 {
            guard let current = candidate else { break }
            if let rect = textGeometry(frame(current)) {
                return rect.contains(pointer) ? pointer : CGPoint(x: rect.midX, y: rect.midY)
            }
            candidate = element(attribute(current, kAXParentAttribute))
        }
        // A verified, non-secure focused element may have no bounds at all.
        // Preserve the event using its pointer position, not invented caret data.
        return allowed(pointer) ? pointer : nil
    }
    func range(_ element: AXUIElement) -> (CFRange, CGRect?)? {
        guard let value = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cfRange, &range), range.location >= 0, range.length >= 0 else { return nil }
        var rectValue: CFTypeRef?, rect = CGRect.zero
        if AXUIElementCopyParameterizedAttributeValue(element, kAXBoundsForRangeParameterizedAttribute as CFString, value, &rectValue) == .success,
           let rectValue, CFGetTypeID(rectValue) == AXValueGetTypeID(), AXValueGetValue(unsafeBitCast(rectValue, to: AXValue.self), .cgRect, &rect), !rect.isNull {
            return (range, rect)
        }
        return (range, nil)
    }
    func normalized(_ point: CGPoint) -> CGPoint { CGPoint(x: max(0,min(1,(point.x-bounds.minX)/bounds.width)), y: max(0,min(1,(point.y-bounds.minY)/bounds.height))) }
    func allowed(_ point: CGPoint) -> Bool {
        guard !stopped, bounds.width > 0, bounds.height > 0, bounds.contains(point), let app = NSWorkspace.shared.frontmostApplication, !excluded.contains(app.processIdentifier), ownerPID == nil || ownerPID == app.processIdentifier else { return false }
        if let id = windowID {
            let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] ?? []
            for window in windows {
                guard (window[kCGWindowLayer as String] as? Int) == 0,
                      let pid = window[kCGWindowOwnerPID as String] as? pid_t, !excluded.contains(pid),
                      let raw = window[kCGWindowBounds as String] as? [String:Any], let rect = CGRect(dictionaryRepresentation: raw as CFDictionary), rect.contains(point) else { continue }
                return (window[kCGWindowNumber as String] as? UInt32) == id
            }
            return false
        }
        return true
    }
    func normalizedRect(_ rect: CGRect?) -> [String:Double]? {
        guard let r = rect?.intersection(bounds), !r.isNull else { return nil }
        return ["x":(r.minX-bounds.minX)/bounds.width,"y":(r.minY-bounds.minY)/bounds.height,"width":r.width/bounds.width,"height":r.height/bounds.height]
    }
    func textContext(_ field: AXUIElement) -> CGRect? {
        // Geometry only, never the text value. Generic web areas/windows are not
        // text fields and must not masquerade as the typing region.
        guard let role = attribute(field, kAXRoleAttribute) as? String,
              [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role) else { return nil }
        return textGeometry(frame(field))
    }
    func append(_ type: String, _ host: Double, _ point: CGPoint, end: Double? = nil, rect: CGRect? = nil, contextRect: CGRect? = nil, position: String = "pointer", button: String? = nil) {
        guard allowed(point) else { return }
        let p = normalized(point)
        let geometry = normalizedRect(rect), context = normalizedRect(contextRect)
        if let last = events.last, ["typing","scroll","selection"].contains(type), last["type"] as? String == type, host-(last["end"] as? Double ?? 0) < (type == "typing" ? 1.1 : 0.4), abs((last["x"] as? Double ?? 0)-p.x) < 0.2, abs((last["y"] as? Double ?? 0)-p.y) < 0.2 {
            events[events.count-1]["end"] = host
            events[events.count-1]["count"] = (last["count"] as? Int ?? 1)+1
            // Keep an expanding selection or moving caret inside the same focus.
            for (key, value) in [("rect", geometry), ("contextRect", context)] {
                guard let geometry = value else { continue }
                let previous = last[key] as? [String:Double] ?? geometry
                let x = min(previous["x"]!, geometry["x"]!), y = min(previous["y"]!, geometry["y"]!)
                let right = max(previous["x"]!+previous["width"]!, geometry["x"]!+geometry["width"]!)
                let bottom = max(previous["y"]!+previous["height"]!, geometry["y"]!+geometry["height"]!)
                events[events.count-1][key] = ["x":x,"y":y,"width":right-x,"height":bottom-y]
                if key == "rect" { events[events.count-1]["x"] = (x+right)/2; events[events.count-1]["y"] = (y+bottom)/2 }
            }
            return
        }
        guard events.count < 200000 else { truncated = true; return }
        var event: [String:Any] = ["id":"event-\(events.count+1)","type":type,"t":host,"end":end ?? host,"x":Double(p.x),"y":Double(p.y),"position":position,"count":1]
        if let button { event["button"] = button }
        if let geometry { event["rect"] = geometry }
        if let context { event["contextRect"] = context }
        events.append(event)
    }
    func receive(_ type: CGEventType, _ point: CGPoint, _ host: Double, _ key: Int64, _ flags: CGEventFlags) {
        guard !stopped else { return }
        switch type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            append("click", host, point, button: type == .leftMouseDown ? "left" : type == .rightMouseDown ? "right" : "middle")
            if type == .leftMouseDown && allowed(point) { pointerDown = (host,point) }
        case .leftMouseUp:
            if let (start, from) = pointerDown, hypot(point.x-from.x,point.y-from.y) > 8 { append("drag", start, point, end: host) }
            pointerDown = nil
        case .scrollWheel: append("scroll", host, point)
        case .keyDown:
            keyboardEvents += 1
            guard !flags.contains(.maskCommand), !flags.contains(.maskControl), key != 53, key < 96 || [117].contains(key) else { return }
            if let field = focused() {
                if let (_, rawRect) = range(field), let rect = textGeometry(rawRect) {
                    append("typing", host, CGPoint(x:rect.midX, y:rect.midY), rect: rect, contextRect: textContext(field), position: "caret")
                } else if let focus = fallbackPoint(field, pointer: point) {
                    append("typing", host, focus, contextRect: textContext(field), position: "element")
                } else { missingGeometry += 1 }
            } else { missingFocus += 1 }
        default: break
        }
    }
    func selection() {
        guard !stopped, let field = focused(), let (range, rawRect) = range(field), range.length > 0 else { lastSelection = ""; lastFocus = nil; return }
        let rect = textGeometry(rawRect)
        guard let focus = rect.map({ CGPoint(x: $0.midX, y: $0.midY) }) ?? fallbackPoint(field, pointer: CGEvent(source: nil)?.location ?? .zero), allowed(focus) else { return }
        let key = "\(range.location):\(range.length)"
        guard key != lastSelection || lastFocus == nil || !CFEqual(field,lastFocus!) else { return }
        lastSelection = key; lastFocus = field
        append("selection", CMClockGetTime(CMClockGetHostTimeClock()).seconds, focus, rect:rect, position:rect == nil ? "element" : "selection")
    }
    func finish(first: Double, end: Double) -> [String:Any] {
        if let tap { CGEvent.tapEnable(tap:tap, enable:false); CFMachPortInvalidate(tap) }
        return queue.sync {
            stopped = true; timer?.cancel(); timer = nil
            let normalized = events.filter { ($0["end"] as? Double ?? 0) >= first && ($0["t"] as? Double ?? 0) <= end }.map { event -> [String:Any] in
                var event = event; event["t"] = max(0,(event["t"] as! Double)-first); event["end"] = min(end-first,(event["end"] as! Double)-first); return event
            }.sorted { ($0["t"] as! Double) < ($1["t"] as! Double) }
            return ["version":1,"permissions":["accessibility":accessibility,"inputMonitoring":inputMonitoring],"capabilities":["click":pointer,"typing":keyboard,"selection":accessibility,"scroll":pointer,"drag":pointer],"diagnostics":["keyboardEvents":keyboardEvents,"missingFocus":missingFocus,"missingGeometry":missingGeometry],"truncated":truncated,"events":normalized]
        }
    }
}
