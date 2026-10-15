import Foundation
import AVFoundation
import CoreGraphics

struct Frame: Decodable { let x:Double;let y:Double;let visible:Bool;let pressed:Bool }
struct Job: Decodable { let width:Int;let height:Int;let fps:Int;let scale:Double;let polygon:[[Double]];let frames:[Frame] }
let args=CommandLine.arguments
func failure(_ text:String)->Never {FileHandle.standardError.write(Data(text.utf8));exit(1)}
do {
    guard args.count==3 else {failure("Expected job and output paths")}
    let job=try JSONDecoder().decode(Job.self,from:Data(contentsOf:URL(fileURLWithPath:args[1])))
    let writer=try AVAssetWriter(outputURL:URL(fileURLWithPath:args[2]),fileType:.mov)
    let input=AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:AVVideoCodecType.proRes4444,AVVideoWidthKey:job.width,AVVideoHeightKey:job.height])
    let adaptor=AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:input,sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA,kCVPixelBufferWidthKey as String:job.width,kCVPixelBufferHeightKey as String:job.height,kCVPixelBufferCGImageCompatibilityKey as String:true,kCVPixelBufferCGBitmapContextCompatibilityKey as String:true])
    writer.add(input)
    guard writer.startWriting() else {throw writer.error!}
    writer.startSession(atSourceTime:.zero)
    for (i,frame) in job.frames.enumerated() {
        while !input.isReadyForMoreMediaData {
            if writer.status == .failed {throw writer.error!}
            Thread.sleep(forTimeInterval:0.001)
        }
        try autoreleasepool {
            var pixel:CVPixelBuffer?
            guard let pool=adaptor.pixelBufferPool,CVPixelBufferPoolCreatePixelBuffer(nil,pool,&pixel)==kCVReturnSuccess,let pixel else {failure("Could not allocate cursor frame")}
            CVPixelBufferLockBaseAddress(pixel,[])
            defer {CVPixelBufferUnlockBaseAddress(pixel,[])}
            let bytes=CVPixelBufferGetBytesPerRow(pixel)
            memset(CVPixelBufferGetBaseAddress(pixel),0,bytes*job.height)
            guard let context=CGContext(data:CVPixelBufferGetBaseAddress(pixel),width:job.width,height:job.height,bitsPerComponent:8,bytesPerRow:bytes,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedFirst.rawValue|CGBitmapInfo.byteOrder32Little.rawValue) else {failure("Could not create cursor canvas")}
            context.translateBy(x:0,y:CGFloat(job.height));context.scaleBy(x:1,y:-1)
            if frame.visible {
                context.translateBy(x:frame.x*Double(job.width),y:frame.y*Double(job.height))
                context.scaleBy(x:job.scale,y:job.scale);context.translateBy(x:-16,y:-16)
                if frame.pressed {
                    context.setFillColor(CGColor(red:169/255,green:146/255,blue:1,alpha:0.3))
                    context.setStrokeColor(CGColor(red:183/255,green:164/255,blue:1,alpha:1));context.setLineWidth(2)
                    context.addEllipse(in:CGRect(x:3,y:3,width:26,height:26));context.drawPath(using:.fillStroke)
                }
                for (i,p) in job.polygon.enumerated() {if i==0 {context.move(to:CGPoint(x:p[0],y:p[1]))} else {context.addLine(to:CGPoint(x:p[0],y:p[1]))}}
                context.closePath();context.setFillColor(CGColor(gray:1,alpha:1))
                context.setStrokeColor(CGColor(red:23/255,green:20/255,blue:31/255,alpha:1));context.setLineWidth(2.5);context.setLineJoin(.round);context.drawPath(using:.fillStroke)
            }
            guard adaptor.append(pixel,withPresentationTime:CMTime(value:Int64(i),timescale:Int32(job.fps))) else {throw writer.error ?? NSError(domain:"Cursor frame encoding",code:1)}
        }
        if i % job.fps == 0 || i == job.frames.count - 1 {
            let microseconds = Int64(Double(i + 1) / Double(job.fps) * 1_000_000)
            FileHandle.standardOutput.write(Data("out_time_us=\(microseconds)\n".utf8))
        }
    }
    input.markAsFinished()
    let semaphore=DispatchSemaphore(value:0)
    writer.finishWriting {semaphore.signal()};semaphore.wait()
    if writer.status != .completed {throw writer.error ?? NSError(domain:"Cursor render",code:1)}
} catch {failure(error.localizedDescription)}
