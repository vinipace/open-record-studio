import Foundation
import AVFoundation

@main struct CaptureEncodingFixture {
    static func audioBuffer(at seconds: Double) throws -> CMSampleBuffer {
        var format = AudioStreamBasicDescription(mSampleRate: 48000, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
            mChannelsPerFrame: 2, mBitsPerChannel: 16, mReserved: 0)
        var description: CMAudioFormatDescription?
        precondition(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &format,
            layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil,
            formatDescriptionOut: &description) == noErr)
        var block: CMBlockBuffer?
        precondition(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
            blockLength: 480 * 4, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
            offsetToData: 0, dataLength: 480 * 4, flags: 0, blockBufferOut: &block) == noErr)
        precondition(CMBlockBufferFillDataBytes(with: 0, blockBuffer: block!, offsetIntoDestination: 0,
            dataLength: 480 * 4) == noErr)
        var buffer: CMSampleBuffer?
        precondition(CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: kCFAllocatorDefault,
            dataBuffer: block!, formatDescription: description!, sampleCount: 480,
            presentationTimeStamp: CMTime(seconds: seconds, preferredTimescale: 48000),
            packetDescriptions: nil, sampleBufferOut: &buffer) == noErr)
        return buffer!
    }
    static func main() async throws {
        let directory = URL(fileURLWithPath: CommandLine.arguments[1])
        let defaults = try CaptureSettings()
        let scaled = defaults.dimensions(width: 5120, height: 2880)
        precondition(scaled.width == 3840 && scaled.height == 2160)
        let portrait = defaults.dimensions(width: 2880, height: 5120)
        precondition(portrait.width == 2160 && portrait.height == 3840)
        let small = defaults.dimensions(width: 1280, height: 720)
        precondition(small.width == 1280 && small.height == 720)
        precondition((try? CaptureSettings(height: 2160, fps: 120)) == nil)
        for (name, width, height) in [("4k", 3840, 2160), ("5k", 5120, 2880)] {
            let writer = try CaptureWriter(url: directory.appendingPathComponent(name + ".mp4"),
                                           width: width, height: height, fps: 30, audio: name == "4k")
            var buffer: CVPixelBuffer?
            let status = CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer)
            precondition(status == kCVReturnSuccess)
            let pixel = buffer!
            CVPixelBufferLockBaseAddress(pixel, [])
            memset(CVPixelBufferGetBaseAddressOfPlane(pixel, 0), 80,
                   CVPixelBufferGetBytesPerRowOfPlane(pixel, 0) * CVPixelBufferGetHeightOfPlane(pixel, 0))
            memset(CVPixelBufferGetBaseAddressOfPlane(pixel, 1), 128,
                   CVPixelBufferGetBytesPerRowOfPlane(pixel, 1) * CVPixelBufferGetHeightOfPlane(pixel, 1))
            CVPixelBufferUnlockBaseAddress(pixel, [])
            // A nonzero host clock and a static screen must still produce a
            // full three-second, decodable recording beginning at media time 0.
            try writer.appendAudio(audioBuffer(at: 99.99))
            try writer.appendVideo(pixel, at: CMTime(seconds: 100, preferredTimescale: 60000))
            if let audio = writer.audio {
                for i in 0..<100 {
                    while !audio.isReadyForMoreMediaData {
                        precondition(writer.writer.status != .failed)
                        try await Task.sleep(nanoseconds: 1_000_000)
                    }
                    try writer.appendAudio(audioBuffer(at: 100 + Double(i) / 100))
                }
            }
            _ = try writer.prepareToFinish(at: CMTime(seconds: 103, preferredTimescale: 60000))
            try await writer.finishWriting()
            print("\(name): \(writer.codec.rawValue), hardware required, dropped \(writer.droppedFrames)")
        }
    }
}
