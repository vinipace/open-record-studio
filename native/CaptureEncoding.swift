import Foundation
import AVFoundation
import VideoToolbox

struct CaptureEncodingError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

struct CaptureSettings {
    let height: Int
    let fps: Int

    init(height: Int = 2160, fps: Int = 30) throws {
        guard [0, 720, 1080, 2160].contains(height), [30, 60].contains(fps) else {
            throw CaptureEncodingError(message: "Choose a supported recording resolution and frame rate")
        }
        self.height = height
        self.fps = fps
    }

    func dimensions(width: Int, height sourceHeight: Int) -> (width: Int, height: Int) {
        let landscape = width >= sourceHeight
        let maxWidth = landscape ? Double(height) * 16 / 9 : Double(height)
        let maxHeight = landscape ? Double(height) : Double(height) * 16 / 9
        let scale = height == 0 ? 1 : min(1, maxWidth / Double(width), maxHeight / Double(sourceHeight))
        return (max(2, Int(Double(width) * scale) / 2 * 2),
                max(2, Int(Double(sourceHeight) * scale) / 2 * 2))
    }
}

// All calls other than finishWriting run on the capture's serial sample queue.
// Requiring a hardware encoder prevents a high-resolution session from silently
// switching to AppleH264SW and consuming several CPU cores.
final class CaptureWriter: @unchecked Sendable {
    let writer: AVAssetWriter
    let video: AVAssetWriterInput
    let audio: AVAssetWriterInput?
    let pixels: AVAssetWriterInputPixelBufferAdaptor
    let codec: AVVideoCodecType
    let width: Int
    let height: Int
    let fps: Int
    private(set) var firstPTS: CMTime?
    private(set) var droppedFrames = 0
    private var lastPTS: CMTime?
    private var lastPixel: CVPixelBuffer?

    init(url: URL, width: Int, height: Int, fps: Int, audio includeAudio: Bool) throws {
        self.width = width
        self.height = height
        self.fps = fps
        codec = max(width, height) > 4096 ? .hevc : .h264
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: codec,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoEncoderSpecificationKey: [
                kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true,
            ],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: max(4_000_000, Int(Double(width * height * fps) * 0.12)),
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoMaxKeyFrameIntervalKey: fps * 2,
                AVVideoAllowFrameReorderingKey: false,
            ],
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ])
        video.expectsMediaDataInRealTime = true
        pixels = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: nil)
        guard writer.canAdd(video) else { throw CaptureEncodingError(message: "This recording format is unavailable") }
        writer.add(video)
        if includeAudio {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 192000,
            ])
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else { throw CaptureEncodingError(message: "System audio recording is unavailable") }
            writer.add(input)
            audio = input
        } else { audio = nil }
        guard writer.startWriting() else { throw encodingError() }
    }

    private func encodingError() -> Error {
        CaptureEncodingError(message: "Hardware recording could not continue. Try a lower resolution or close another recording app. \(writer.error?.localizedDescription ?? "")")
    }

    func appendVideo(_ pixel: CVPixelBuffer, at pts: CMTime) throws {
        if writer.status == .failed { throw encodingError() }
        guard video.isReadyForMoreMediaData else { droppedFrames += 1; return }
        if firstPTS == nil {
            writer.startSession(atSourceTime: pts)
            firstPTS = pts
        }
        guard lastPTS == nil || CMTimeCompare(pts, lastPTS!) > 0 else { return }
        guard pixels.append(pixel, withPresentationTime: pts) else { throw encodingError() }
        lastPTS = pts
        lastPixel = pixel
    }

    func appendAudio(_ buffer: CMSampleBuffer) throws {
        guard let firstPTS, let audio,
              CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(buffer), firstPTS) >= 0 else { return }
        if writer.status == .failed { throw encodingError() }
        guard audio.isReadyForMoreMediaData else { return }
        guard audio.append(buffer) else { throw encodingError() }
    }

    func prepareToFinish(at requestedEnd: CMTime) throws -> CMTime {
        guard let lastPTS, let lastPixel else {
            writer.cancelWriting()
            throw CaptureEncodingError(message: "No screen frames were captured")
        }
        let frame = CMTime(value: 1, timescale: Int32(fps))
        let end = CMTimeMaximum(requestedEnd, CMTimeAdd(lastPTS, frame))
        let finalPTS = CMTimeSubtract(end, frame)
        // Static screens may emit no new complete frames. Repeat the final image
        // near Stop so video, audio, cursor metadata and webcam keep one duration.
        if CMTimeCompare(finalPTS, lastPTS) > 0 {
            let deadline = Date().addingTimeInterval(5)
            while !video.isReadyForMoreMediaData {
                if writer.status == .failed || Date() > deadline { throw encodingError() }
                Thread.sleep(forTimeInterval: 0.002)
            }
            guard pixels.append(lastPixel, withPresentationTime: finalPTS) else { throw encodingError() }
        }
        writer.endSession(atSourceTime: end)
        video.markAsFinished()
        audio?.markAsFinished()
        self.lastPixel = nil
        return end
    }

    func finishWriting() async throws {
        await writer.finishWriting()
        guard writer.status == .completed else { throw encodingError() }
    }
}
