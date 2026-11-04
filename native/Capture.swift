import Foundation
import ScreenCaptureKit
import AVFoundation
import AppKit

func emit(_ object: [String:Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object) {
        FileHandle.standardOutput.write(data + Data([10]))
    }
}
func fail(_ error: Error) { emit(["event":"error","message":error.localizedDescription]); exit(1) }
struct CaptureError: LocalizedError { let message: String; var errorDescription: String? { message } }

// Cursor samples and content-free interaction metadata share the capture clock.
@available(macOS 15.0, *)
final class Capture: NSObject, SCStreamDelegate, SCStreamOutput, @unchecked Sendable {
    let queue = DispatchQueue(label: "local.framestudio.capture")
    var stream: SCStream?
    var timer: DispatchSourceTimer?
    var bounds = CGRect.zero
    var windowID: CGWindowID?
    var samples = [[String:Any]]()
    var firstPTS: Double?
    var writer: CaptureWriter?
    var announced = false
    var stopping = false
    var startWall = 0.0
    var lastPoint: [String:Any]?
    var lastBoundsCheck = 0.0
    var output: URL!
    var cursorOutput: URL!
    let interactions = InteractionCapture()
    var captureOwnerPID: pid_t?
    var captureType = ""
    var excludedApplicationPIDs = [pid_t]()


    func start(source: String, output: URL, audio: Bool, excludeApplicationPIDs: [pid_t], settings: CaptureSettings) async throws {
        self.output=output
        cursorOutput=output.deletingLastPathComponent().appendingPathComponent("cursor.json")
        let content=try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let parts=source.split(separator: ":")
        guard parts.count>=2, let id=UInt32(parts[1]) else { throw CaptureError(message:"Choose a screen or window") }
        let filter: SCContentFilter
        if parts[0]=="screen", let display=content.displays.first(where:{$0.displayID==id}) {
            let excluded = content.applications.filter { excludeApplicationPIDs.contains($0.processID) }
            guard Set(excluded.map(\.processID)) == Set(excludeApplicationPIDs) else {
                throw CaptureError(message:"Could not exclude the recording preview from screen capture. Please retry with Open Record Studio visible.")
            }
            filter=SCContentFilter(display:display,excludingApplications:excluded,exceptingWindows:[])
            excludedApplicationPIDs=excluded.map(\.processID)
            captureType="screen"
            bounds=CGDisplayBounds(id)
        } else if parts[0]=="window", let window=content.windows.first(where:{$0.windowID==id}) {
            filter=SCContentFilter(desktopIndependentWindow:window)
            captureType="window"
            bounds=window.frame;windowID=id;captureOwnerPID=window.owningApplication?.processID
        } else { throw CaptureError(message:"The selected capture source is no longer available") }
        let config=SCStreamConfiguration()
        let size = settings.dimensions(width: Int(filter.contentRect.width * CGFloat(filter.pointPixelScale)),
                                       height: Int(filter.contentRect.height * CGFloat(filter.pointPixelScale)))
        config.width = size.width
        config.height = size.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: Int32(settings.fps))
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.colorSpaceName = CGColorSpace.itur_709
        config.scalesToFit = true
        config.queueDepth=5
        config.showsCursor=false
        config.ignoreShadowsSingleWindow=true
        config.ignoreShadowsDisplay=true
        config.capturesAudio=audio
        config.excludesCurrentProcessAudio=true
        config.sampleRate=48000
        config.channelCount=2
        writer = try CaptureWriter(url: output, width: size.width, height: size.height, fps: settings.fps, audio: audio)
        let stream=SCStream(filter:filter,configuration:config,delegate:self)
        self.stream=stream
        try stream.addStreamOutput(self,type:.screen,sampleHandlerQueue:queue)
        if audio { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue) }
        let timer=DispatchSource.makeTimerSource(queue:queue)
        timer.schedule(deadline:.now(),repeating:1.0/120,leeway:.milliseconds(1))
        timer.setEventHandler { [weak self] in self?.sample() }
        self.timer=timer;timer.resume()
        interactions.start(bounds: bounds, windowID: windowID, ownerPID: captureOwnerPID, excluded: excludeApplicationPIDs)
        guard interactions.ready else { throw CaptureError(message:"Accessibility and Input Monitoring are required for typing and selection tracking. Enable Open Record Studio in macOS Privacy & Security before recording.") }
        try await stream.startCapture()
    }
    func sample() {
        guard !stopping else { return }
        let host=CMClockGetTime(CMClockGetHostTimeClock()).seconds
        if let id=windowID, host-lastBoundsCheck > 0.1 {
            lastBoundsCheck=host
            if let list=CGWindowListCopyWindowInfo([.optionIncludingWindow],id) as? [[String:Any]],
               let raw=list.first?[kCGWindowBounds as String] as? [String:Any],
               let rect=CGRect(dictionaryRepresentation:raw as CFDictionary) { bounds=rect;interactions.updateBounds(rect) }
        }
        guard bounds.width>0,bounds.height>0,let point=CGEvent(source:nil)?.location else { return }
        let p:[String:Any] = ["t":host,"x":Double(max(0,min(1,(point.x-bounds.minX)/bounds.width))),"y":Double(max(0,min(1,(point.y-bounds.minY)/bounds.height))),"visible":bounds.contains(point),"pressed":NSEvent.pressedMouseButtons != 0]
        if let last=lastPoint,
           last["x"] as? Double == p["x"] as? Double,
           last["y"] as? Double == p["y"] as? Double,
           last["visible"] as? Bool == p["visible"] as? Bool,
           last["pressed"] as? Bool == p["pressed"] as? Bool {
            if host-(samples.last?["t"] as? Double ?? 0) >= 0.1 { samples.append(p) }
        } else {
            // Preserve the stationary endpoint before a new movement begins.
            if var previous=lastPoint,host-(samples.last?["t"] as? Double ?? 0) > 0.02 {
                previous["t"]=host-1.0/120;samples.append(previous)
            }
            samples.append(p)
        }
        lastPoint=p
    }
    func announce() {
        guard !announced,let first=firstPTS,let writer else { return }
        announced=true
        let now=CMClockGetTime(CMClockGetHostTimeClock()).seconds
        startWall=Date().timeIntervalSince1970*1000-(now-first)*1000
        emit(["event":"started","startedAt":startWall,"captureType":captureType,"excludedApplicationPIDs":excludedApplicationPIDs,"interactions":interactions.trackingStatus,"encoding":["hardwareRequired":true,"codec":writer.codec.rawValue,"width":writer.width,"height":writer.height,"fps":writer.fps]])
    }
    func stream(_ stream:SCStream,didOutputSampleBuffer buffer:CMSampleBuffer,of type:SCStreamOutputType) {
        guard !stopping, buffer.isValid, let writer else { return }
        do {
            if type == .audio { try writer.appendAudio(buffer); return }
            guard type == .screen,
                  let attachments=CMSampleBufferGetSampleAttachmentsArray(buffer,createIfNecessary:false) as? [[SCStreamFrameInfo:Any]],
                  let raw=attachments.first?[.status] as? Int,
                  SCFrameStatus(rawValue:raw) == .complete,
                  let pixel = CMSampleBufferGetImageBuffer(buffer) else { return }
            let pts = CMSampleBufferGetPresentationTimeStamp(buffer)
            try writer.appendVideo(pixel, at: pts)
            if firstPTS == nil { firstPTS = writer.firstPTS?.seconds; announce() }
        } catch { fail(error) }
    }
    func stream(_ stream:SCStream,didStopWithError error:Error) { fail(error) }
    func stop() async throws {
        let end = CMClockGetTime(CMClockGetHostTimeClock())
        queue.sync { self.sample();self.stopping=true;self.timer?.cancel();self.timer=nil }
        try await stream?.stopCapture()
        guard let writer else { throw CaptureError(message:"Recording did not start") }
        let finishedAt = try queue.sync { try writer.prepareToFinish(at: end) }
        try await writer.finishWriting()
        try queue.sync {
            guard let first=self.firstPTS else { throw CaptureError(message:"No screen frames were captured") }
            let end = finishedAt.seconds
            if var last=self.lastPoint {last["t"]=end;self.samples.append(last)}
            let normalized=self.samples.filter { ($0["t"] as? Double ?? 0) >= first }.map { p -> [String:Any] in
                var p=p;p["t"]=(p["t"] as! Double)-first;return p
            }
            let data=try JSONSerialization.data(withJSONObject:["clean":true,"samples":normalized])
            try data.write(to:self.cursorOutput,options:.atomic)
            let interactionData = try JSONSerialization.data(withJSONObject: self.interactions.finish(first: first, end: end))
            try interactionData.write(to: self.output.deletingLastPathComponent().appendingPathComponent("interactions.json"), options:.atomic)
            let diagnostics = try JSONSerialization.data(withJSONObject: ["hardwareRequired": true,
                "codec": writer.codec.rawValue, "width": writer.width, "height": writer.height,
                "fps": writer.fps, "droppedFrames": writer.droppedFrames])
            try diagnostics.write(to: self.output.deletingLastPathComponent().appendingPathComponent("capture.json"), options: .atomic)
            emit(["event":"finished","startedAt":self.startWall,"droppedFrames":writer.droppedFrames])
        }
        exit(0)
    }
}

@main
struct Recorder {
static func main() {
let args=CommandLine.arguments
func argument(_ key:String)->String? { guard let i=args.firstIndex(of:key),i+1<args.count else{return nil};return args[i+1] }
if args.contains("--interaction-access") || args.contains("--request-interaction-access") {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.prohibited)
    emit(InteractionCapture.permissions(request: args.contains("--request-interaction-access")))
    return
}
if args.contains("--diagnostics") {
    emit(["event":"diagnostics","available":ProcessInfo.processInfo.operatingSystemVersion.majorVersion>=15,"cursorHidden":true,"fps":30,"hardwareRequired":true])
    return
}
if #available(macOS 15.0, *) {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.prohibited)
    let capture=Capture()
    Task {
        do {
            guard let source=argument("--source"),let file=argument("--output") else { throw CaptureError(message:"Missing capture arguments") }
            let rawPIDs=argument("--exclude-apps")?.split(separator:",") ?? []
            let excluded=rawPIDs.compactMap { pid_t($0) }.filter { $0 > 0 }
            guard excluded.count == rawPIDs.count else { throw CaptureError(message:"Invalid capture exclusion process ID") }
            guard let height = Int(argument("--height") ?? "2160"), let fps = Int(argument("--fps") ?? "30") else {
                throw CaptureError(message: "Invalid recording resolution or frame rate")
            }
            let settings = try CaptureSettings(height: height, fps: fps)
            try await capture.start(source:source,output:URL(fileURLWithPath:file),audio:args.contains("--audio"),excludeApplicationPIDs:excluded,settings:settings)
            DispatchQueue.global().async {
                _ = readLine()
                Task {do {try await capture.stop()} catch {fail(error)}}
            }
        } catch {fail(error)}
    }
    RunLoop.main.run()
} else { fail(CaptureError(message:"Editable cursor capture requires macOS 15 or later")) }
}
}
