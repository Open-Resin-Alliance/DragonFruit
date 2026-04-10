import QuickLookThumbnailing
import AppKit
import Foundation

/// QuickLook Thumbnail Extension for DragonFruit VOXL scene files.
///
/// Shells out to the `dragonfruit-voxl-thumbnailer` CLI binary to extract the
/// embedded `ora.preview` PNG, then draws it into the thumbnail reply context.
class ThumbnailProvider: QLThumbnailProvider {

    override func provideThumbnail(
        for request: QLFileThumbnailRequest,
        _ handler: @escaping (QLThumbnailReply?, Error?) -> Void
    ) {
        let maxDimension = Int(max(request.maximumSize.width, request.maximumSize.height) * request.scale)

        // Locate the CLI binary — bundled alongside the extension, or in PATH
        let thumbnailerURL = locateThumbnailer()

        let tempDir = FileManager.default.temporaryDirectory
        let tempOutput = tempDir.appendingPathComponent(UUID().uuidString + ".png")

        let process = Process()
        process.executableURL = thumbnailerURL
        process.arguments = [
            request.fileURL.path,
            tempOutput.path,
            String(maxDimension),
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()

            guard process.terminationStatus == 0 else {
                handler(nil, makeError("thumbnailer exited with code \(process.terminationStatus)"))
                return
            }

            guard let image = NSImage(contentsOf: tempOutput) else {
                handler(nil, makeError("failed to load generated thumbnail PNG"))
                return
            }

            let imageSize = image.size
            let reply = QLThumbnailReply(
                contextSize: request.maximumSize,
                drawing: { context -> Bool in
                    // Scale the image to fit the requested thumbnail bounds
                    let drawRect = Self.aspectFitRect(
                        imageSize: imageSize,
                        boundingSize: request.maximumSize
                    )
                    NSGraphicsContext.saveGraphicsState()
                    let nsContext = NSGraphicsContext(cgContext: context, flipped: false)
                    NSGraphicsContext.current = nsContext
                    image.draw(in: drawRect)
                    NSGraphicsContext.restoreGraphicsState()
                    return true
                }
            )

            handler(reply, nil)
        } catch {
            handler(nil, error)
        }

        // Clean up temp file
        try? FileManager.default.removeItem(at: tempOutput)
    }

    // MARK: - Helpers

    private func locateThumbnailer() -> URL {
        // 1. Check inside the app bundle (Tauri app embeds it)
        if let bundled = Bundle.main.url(forAuxiliaryExecutable: "dragonfruit-voxl-thumbnailer") {
            return bundled
        }
        // 2. Check parent app bundle
        if let parent = Bundle.main.bundleURL
            .deletingLastPathComponent() // PlugIns/
            .deletingLastPathComponent() // Contents/
            .deletingLastPathComponent() // .app/
            .appendingPathComponent("Contents/MacOS/dragonfruit-voxl-thumbnailer") as URL?,
           FileManager.default.isExecutableFile(atPath: parent.path) {
            return parent
        }
        // 3. Fallback to PATH
        return URL(fileURLWithPath: "/usr/local/bin/dragonfruit-voxl-thumbnailer")
    }

    private static func aspectFitRect(imageSize: NSSize, boundingSize: NSSize) -> NSRect {
        let widthScale = boundingSize.width / imageSize.width
        let heightScale = boundingSize.height / imageSize.height
        let scale = min(widthScale, heightScale)
        let scaledSize = NSSize(
            width: imageSize.width * scale,
            height: imageSize.height * scale
        )
        let origin = NSPoint(
            x: (boundingSize.width - scaledSize.width) / 2,
            y: (boundingSize.height - scaledSize.height) / 2
        )
        return NSRect(origin: origin, size: scaledSize)
    }

    private func makeError(_ message: String) -> NSError {
        NSError(
            domain: "org.openresinalliance.dragonfruit.voxl-thumbnail",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }
}
