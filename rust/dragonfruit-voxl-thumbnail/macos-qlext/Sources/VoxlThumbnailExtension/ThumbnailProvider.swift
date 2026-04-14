import QuickLookThumbnailing
import AppKit
import Foundation

/// QuickLook Thumbnail Extension for DragonFruit VOXL scene files.
///
/// Parses the VOXL V2 binary format directly — locates the EXTD chunk and
/// extracts the embedded `ora.preview` PNG. No subprocess is spawned; this
/// is required for App Sandbox compliance (the sandbox forbids Process()).
class ThumbnailProvider: QLThumbnailProvider {

    override func provideThumbnail(
        for request: QLFileThumbnailRequest,
        _ handler: @escaping (QLThumbnailReply?, Error?) -> Void
    ) {
        do {
            let data = try Data(contentsOf: request.fileURL)
            let pngData = try extractThumbnail(from: data)

            guard let image = NSImage(data: pngData) else {
                handler(nil, makeError("failed to decode PNG from VOXL EXTD chunk"))
                return
            }

            let imageSize = image.size
            let reply = QLThumbnailReply(
                contextSize: request.maximumSize,
                drawing: { context -> Bool in
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
    }

    // MARK: - VOXL V2 inline parser

    private func extractThumbnail(from data: Data) throws -> Data {
        // ── V2 header (16 bytes) ──────────────────────────────────────
        guard data.count >= 16,
              data[0] == 0x56, data[1] == 0x4F,
              data[2] == 0x58, data[3] == 0x4C  // "VOXL"
        else { throw makeError("not a VOXL V2 file") }

        let version = data.readUInt16LE(at: 4)
        guard version >= 2 else { throw makeError("VOXL version \(version) is not V2") }

        let chunkCount = Int(data.readUInt32LE(at: 8))
        let dirStart   = 16
        let entrySize  = 20

        guard data.count >= dirStart + chunkCount * entrySize else {
            throw makeError("chunk directory out of bounds")
        }

        // ── Scan directory for EXTD[0] ────────────────────────────────
        for i in 0..<chunkCount {
            let b = dirStart + i * entrySize
            // chunk type "EXTD" = 0x45 0x58 0x54 0x44
            guard data[b] == 0x45, data[b+1] == 0x58,
                  data[b+2] == 0x54, data[b+3] == 0x44 else { continue }

            let index = data.readUInt16LE(at: b + 4)
            guard index == 0 else { continue }

            let compression = data.readUInt16LE(at: b + 6)
            let offset      = Int(data.readUInt32LE(at: b + 8))
            let compSize    = Int(data.readUInt32LE(at: b + 12))

            guard offset + compSize <= data.count else {
                throw makeError("EXTD chunk out of bounds")
            }

            // ── Decompress if needed ──────────────────────────────────
            let jsonData: Data
            switch compression {
            case 0:
                jsonData = data.subdata(in: offset ..< offset + compSize)
            case 1:
                let compressed = data.subdata(in: offset ..< offset + compSize)
                guard let dec = try? (compressed as NSData).decompressed(using: .zlib) else {
                    throw makeError("EXTD chunk zlib decompression failed")
                }
                jsonData = dec as Data
            default:
                throw makeError("unknown EXTD compression code: \(compression)")
            }

            // ── Parse JSON → base64 PNG ───────────────────────────────
            guard let root    = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  let preview = root["ora.preview"] as? [String: Any],
                  let b64     = preview["dataBase64"] as? String,
                  let png     = Data(base64Encoded: b64, options: .ignoreUnknownCharacters)
            else { throw makeError("no ora.preview thumbnail in EXTD chunk") }

            return png
        }

        throw makeError("no EXTD chunk in VOXL file")
    }

    // MARK: - Helpers

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

// MARK: - Data byte-order helpers

private extension Data {
    func readUInt16LE(at offset: Int) -> UInt16 {
        UInt16(self[offset]) | (UInt16(self[offset + 1]) << 8)
    }

    func readUInt32LE(at offset: Int) -> UInt32 {
        UInt32(self[offset])             |
        (UInt32(self[offset + 1]) << 8)  |
        (UInt32(self[offset + 2]) << 16) |
        (UInt32(self[offset + 3]) << 24)
    }
}
