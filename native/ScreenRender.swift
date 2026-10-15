import Foundation
import AVFoundation
import CoreImage
import Metal

struct Pointer: Decodable { let x: Double; let y: Double; let pressed: Bool }
struct RenderFrame: Decodable {
    let source: Double
    let x: Double
    let y: Double
    let size: Double
    let cursor: Pointer?
}
struct RenderJob: Decodable {
    let input: String
    let width: Int
    let height: Int
    let fps: Int
    let duration: Double
    let cursorScale: Double
    let polygon: [[Double]]
    let frames: [RenderFrame]
    let quality: String
}
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(message.utf8)); exit(1)
}
func error(_ message: String) -> NSError { NSError(domain: message, code: 1) }

// Keep only the current and next decoded frame. AVAssetReader handles hardware
// decoding; Core Image on Metal crops, scales and composites directly into the
// encoder's output buffers. No full-size transparent cursor movie is needed.
final class SourceReader {
    let asset: AVURLAsset
    let track: AVAssetTrack
    let duration: Double
    let transform: CGAffineTransform
    var reader: AVAssetReader?
    var output: AVAssetReaderTrackOutput?
    var current: CMSampleBuffer?
    var next: CMSampleBuffer?
    var lastRequested = -Double.infinity
    init(asset: AVURLAsset, track: AVAssetTrack, duration: Double, transform: CGAffineTransform) {
        self.asset = asset; self.track = track
        self.duration = duration; self.transform = transform
    }
    func seek(_ time: Double) throws {
        reader?.cancelReading(); current = nil; next = nil
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        // Include the preceding source frame for non-frame-aligned cuts.
        let start = max(0, time - 0.25)
        reader.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600000),
                                      end: CMTime(seconds: duration, preferredTimescale: 600000))
        guard reader.startReading() else { throw reader.error ?? error("Could not decode screen video") }
        self.reader = reader; self.output = output; next = output.copyNextSampleBuffer()
    }
    func image(at time: Double) throws -> CIImage? {
        guard time >= 0 && time < duration else { return nil }
        if reader == nil || time < lastRequested || time - lastRequested > 0.5 { try seek(time) }
        lastRequested = time
        while let candidate = next {
            if current != nil && CMSampleBufferGetPresentationTimeStamp(candidate).seconds > time + 0.000001 { break }
            current = candidate; next = output?.copyNextSampleBuffer()
        }
        if reader?.status == .failed { throw reader!.error ?? error("Screen decoding failed") }
        guard let current, let pixel = CMSampleBufferGetImageBuffer(current) else { return nil }
        // Track transforms use a top-left origin; Core Image uses bottom-left.
        // Conjugate the linear transform by a Y flip before normalizing bounds.
        let ciTransform = CGAffineTransform(a: transform.a, b: -transform.b, c: -transform.c,
                                           d: transform.d, tx: transform.tx, ty: -transform.ty)
        let image = CIImage(cvPixelBuffer: pixel, options: [.colorSpace: NSNull()]).transformed(by: ciTransform)
        return image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
    }
}

func pointerImage(_ job: RenderJob, pressed: Bool) throws -> CIImage {
    // Rasterize the two small pointer states once at the maximum zoom scale.
    let scale = max(1, job.cursorScale / (job.frames.map(\.size).min() ?? 1))
    let dimension = Int(ceil(64 * scale))
    guard let cg = CGContext(data: nil, width: dimension, height: dimension, bitsPerComponent: 8,
                             bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw error("Cursor allocation failed") }
    cg.translateBy(x: 0, y: CGFloat(dimension)); cg.scaleBy(x: scale, y: -scale)
    if pressed {
        cg.setFillColor(CGColor(red: 169/255, green: 146/255, blue: 1, alpha: 0.3))
        cg.setStrokeColor(CGColor(red: 183/255, green: 164/255, blue: 1, alpha: 1))
        cg.setLineWidth(2); cg.addEllipse(in: CGRect(x: 3, y: 3, width: 26, height: 26)); cg.drawPath(using: .fillStroke)
    }
    for (i, p) in job.polygon.enumerated() {
        if i == 0 { cg.move(to: CGPoint(x: p[0], y: p[1])) }
        else { cg.addLine(to: CGPoint(x: p[0], y: p[1])) }
    }
    cg.closePath(); cg.setFillColor(CGColor(gray: 1, alpha: 1))
    cg.setStrokeColor(CGColor(red: 23/255, green: 20/255, blue: 31/255, alpha: 1))
    cg.setLineWidth(2.5); cg.setLineJoin(.round); cg.drawPath(using: .fillStroke)
    guard let image = cg.makeImage() else { throw error("Cursor rasterization failed") }
    return CIImage(cgImage: image).transformed(by: CGAffineTransform(scaleX: 1/scale, y: 1/scale))
}

func render(_ job: RenderJob, to url: URL) async throws {
    guard let device = MTLCreateSystemDefaultDevice() else { throw error("Metal is unavailable") }
    guard job.width > 0, job.height > 0, job.fps > 0, !job.frames.isEmpty else { throw error("Invalid screen render job") }
    // Preserve encoded RGB values, like the editor and FFmpeg path. Applying
    // an implicit transfer conversion here brightens untagged screen media.
    let context = CIContext(mtlDevice: device, options: [.cacheIntermediates: false, .workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
    let inputURL = URL(fileURLWithPath: job.input)
    let asset = AVURLAsset(url: inputURL)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw error("Screen video has no frames") }
    let source = SourceReader(asset: asset, track: track, duration: try await asset.load(.duration).seconds,
                              transform: try await track.load(.preferredTransform))
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: job.width, AVVideoHeightKey: job.height,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: Int(Double(job.width * job.height * job.fps) * (job.quality == "high" ? 0.24 : 0.14)),
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoExpectedSourceFrameRateKey: job.fps,
            AVVideoMaxKeyFrameIntervalKey: job.fps * 2,
        ],
        AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                                    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                                    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2],
    ])
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: job.width, kCVPixelBufferHeightKey as String: job.height,
        kCVPixelBufferMetalCompatibilityKey as String: true, kCVPixelBufferIOSurfacePropertiesKey as String: [:],
    ])
    writer.add(input)
    guard writer.startWriting() else { throw writer.error ?? error("Screen encoder could not start") }
    writer.startSession(atSourceTime: .zero)
    let bounds = CGRect(x: 0, y: 0, width: job.width, height: job.height)
    let black = CIImage(color: .black).cropped(to: bounds)
    let pointer = try pointerImage(job, pressed: false), clicked = try pointerImage(job, pressed: true)
    for (i, frame) in job.frames.enumerated() {
        while !input.isReadyForMoreMediaData {
            if writer.status == .failed { throw writer.error ?? error("Screen encoder failed") }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        try autoreleasepool {
            var image = black
            if let decoded = try source.image(at: frame.source) {
                let width = decoded.extent.width, height = decoded.extent.height
                let crop = CGRect(x: frame.x * width, y: (1 - frame.y - frame.size) * height,
                                  width: frame.size * width, height: frame.size * height)
                image = decoded.cropped(to: crop)
                    .transformed(by: CGAffineTransform(translationX: -crop.minX, y: -crop.minY))
                    .transformed(by: CGAffineTransform(scaleX: bounds.width/crop.width, y: bounds.height/crop.height))
                    .composited(over: black)
            }
            if let p = frame.cursor {
                let scale = job.cursorScale / frame.size
                let x = (p.x - frame.x) / frame.size * bounds.width
                let y = (1 - (p.y - frame.y) / frame.size) * bounds.height
                let sprite = p.pressed ? clicked : pointer
                let overlay = sprite.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
                    .transformed(by: CGAffineTransform(translationX: x - 16 * scale, y: y - (sprite.extent.height - 16) * scale))
                image = overlay.composited(over: image)
            }
            var pixel: CVPixelBuffer?
            guard let pool = adaptor.pixelBufferPool,
                  CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixel) == kCVReturnSuccess, let pixel else { throw error("Screen buffer allocation failed") }
            context.render(image, to: pixel, bounds: bounds, colorSpace: nil)
            guard adaptor.append(pixel, withPresentationTime: CMTime(value: Int64(i), timescale: Int32(job.fps))) else {
                throw writer.error ?? error("Screen frame encoding failed")
            }
        }
        if i % job.fps == 0 || i == job.frames.count - 1 {
            FileHandle.standardOutput.write(Data("out_time_us=\(Int64(Double(i+1)/Double(job.fps)*1_000_000))\n".utf8))
        }
    }
    source.reader?.cancelReading()
    writer.endSession(atSourceTime: CMTime(seconds: job.duration, preferredTimescale: 600000))
    input.markAsFinished()
    await writer.finishWriting()
    if writer.status != .completed { throw writer.error ?? error("Screen export did not finish") }
}

do {
    guard CommandLine.arguments.count == 3 else { fail("Expected job and output paths") }
    let job = try JSONDecoder().decode(RenderJob.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    try await render(job, to: URL(fileURLWithPath: CommandLine.arguments[2]))
} catch { fail(error.localizedDescription) }
