import QuickLookThumbnailing
import Foundation
import CoreGraphics
import ImageIO
import AppKit

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
            let rawPng = try extractThumbnail(from: data)
            let pngData = removeWhiteBackground(from: rawPng) ?? rawPng

            guard let cgSrc  = CGImageSourceCreateWithData(pngData as CFData, nil),
                  let cgImage = CGImageSourceCreateImageAtIndex(cgSrc, 0, nil)
            else {
                handler(nil, makeError("failed to decode PNG"))
                return
            }

            let subjectImage = croppedOpaqueCGImage(from: cgImage) ?? cgImage
            let imgW = CGFloat(subjectImage.width)
            let imgH = CGFloat(subjectImage.height)

            // QLThumbnailReply with a drawing block gives us a transparent
            // CGContext — nothing is drawn unless we do it explicitly, so the
            // background stays fully transparent regardless of system theme.
            // IMPORTANT: ctx.width/height are in PIXELS; request.maximumSize is
            // in POINTS. Using maximumSize for layout causes a 2× size mismatch
            // on Retina displays (image ends up at ¼ area in the bottom-left).
            let reply = QLThumbnailReply(contextSize: request.maximumSize) { ctx -> Bool in
                let ctxW = CGFloat(ctx.width)
                let ctxH = CGFloat(ctx.height)
                let fullRect = CGRect(x: 0, y: 0, width: ctxW, height: ctxH)
                // Fill with a dark charcoal background so Finder's white card
                // frame becomes just a thin border rather than a large white slab.
                ctx.setFillColor(CGColor(red: 0.13, green: 0.13, blue: 0.16, alpha: 1.0))
                ctx.fill(fullRect)
                // Aspect-fit, centered, with padding, in CG coordinates (origin = bottom-left)
                let padding = min(ctxW, ctxH) * 0.035
                let availW = ctxW - padding * 2
                let availH = ctxH - padding * 2
                let scale = min(availW / imgW, availH / imgH)
                let drawW = imgW * scale
                let drawH = imgH * scale
                let rect  = CGRect(
                    x: (ctxW - drawW) / 2,
                    y: (ctxH - drawH) / 2,
                    width: drawW, height: drawH
                )
                ctx.draw(subjectImage, in: rect)
                return true
            }
            handler(reply, nil)
        } catch {
            handler(nil, error)
        }
    }

    /// Finds the tightest bounds around non-transparent pixels and returns a
    /// cropped image. This removes large transparent margins around the model,
    /// so Finder thumbnails look fuller and better centered.
    private func croppedOpaqueCGImage(from image: CGImage) -> CGImage? {
        let w = image.width
        let h = image.height
        guard w > 0, h > 0 else { return nil }

        let bpr = w * 4
        let fmt = CGBitmapInfo.byteOrder32Big.rawValue
                | CGImageAlphaInfo.premultipliedFirst.rawValue

        var buf = [UInt8](repeating: 0, count: h * bpr)
        buf.withUnsafeMutableBytes { raw in
            guard let ctx = CGContext(
                data: raw.baseAddress, width: w, height: h,
                bitsPerComponent: 8, bytesPerRow: bpr,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: fmt)
            else { return }
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        }

        var minX = w, minY = h
        var maxX = -1, maxY = -1
        for y in 0..<h {
            let row = y * bpr
            for x in 0..<w {
                let p = row + x * 4
                let alpha = buf[p] // ARGB => alpha byte is first
                if alpha > 8 {
                    if x < minX { minX = x }
                    if y < minY { minY = y }
                    if x > maxX { maxX = x }
                    if y > maxY { maxY = y }
                }
            }
        }

        guard maxX >= minX, maxY >= minY else { return nil }
        let cropRect = CGRect(
            x: minX,
            y: minY,
            width: maxX - minX + 1,
            height: maxY - minY + 1
        )
        return image.cropping(to: cropRect)
    }

    // MARK: - White background removal

    /// Flood-fills connected near-white pixels from all four edges of the image,
    /// making them transparent. This strips the render's flat white background
    /// without touching white parts of the model that aren't edge-connected.
    private func removeWhiteBackground(from pngData: Data) -> Data? {
        guard let src = CGImageSourceCreateWithData(pngData as CFData, nil),
              let input = CGImageSourceCreateImageAtIndex(src, 0, nil)
        else { return nil }

        let w   = input.width
        let h   = input.height
        let bpr = w * 4
        // ARGB big-endian: memory layout [A, R, G, B] at [p, p+1, p+2, p+3]
        let fmt = CGBitmapInfo.byteOrder32Big.rawValue
                | CGImageAlphaInfo.premultipliedFirst.rawValue

        // ── Rasterize into a mutable pixel buffer ─────────────────────
        var buf = [UInt8](repeating: 0, count: h * bpr)
        buf.withUnsafeMutableBytes { raw in
            guard let ctx = CGContext(
                data: raw.baseAddress, width: w, height: h,
                bitsPerComponent: 8, bytesPerRow: bpr,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: fmt)
            else { return }
            ctx.draw(input, in: CGRect(x: 0, y: 0, width: w, height: h))
        }

        // ── BFS flood-fill from edges ─────────────────────────────────
        // Threshold: R, G, B all > 230 (≈ 90 % brightness)
        var isBg = [Bool](repeating: false, count: w * h)
        var queue = [Int]()
        queue.reserveCapacity(w * 2 + h * 2)

        @inline(__always)
        func nearWhite(_ i: Int) -> Bool {
            let p = i &* 4          // [A, R, G, B]
            return buf[p &+ 1] > 230 && buf[p &+ 2] > 230 && buf[p &+ 3] > 230
        }
        func seed(_ i: Int) {
            if !isBg[i] && nearWhite(i) { isBg[i] = true; queue.append(i) }
        }

        for x in 0..<w          { seed(x);          seed((h - 1) * w + x) }
        for y in 1..<(h - 1)   { seed(y * w);       seed(y * w + w - 1)   }

        var qi = 0
        while qi < queue.count {
            let i = queue[qi]; qi &+= 1
            let x = i % w, y = i / w
            if x > 0    { let j = i &- 1; if !isBg[j] && nearWhite(j) { isBg[j]=true; queue.append(j) } }
            if x < w-1  { let j = i &+ 1; if !isBg[j] && nearWhite(j) { isBg[j]=true; queue.append(j) } }
            if y > 0    { let j = i &- w; if !isBg[j] && nearWhite(j) { isBg[j]=true; queue.append(j) } }
            if y < h-1  { let j = i &+ w; if !isBg[j] && nearWhite(j) { isBg[j]=true; queue.append(j) } }
        }

        // ── Zero-out background pixels (transparent black) ────────────
        for i in 0..<(w * h) where isBg[i] {
            let p = i &* 4
            buf[p] = 0; buf[p &+ 1] = 0; buf[p &+ 2] = 0; buf[p &+ 3] = 0
        }

        // ── Re-encode to PNG ──────────────────────────────────────────
        var result: Data?
        buf.withUnsafeMutableBytes { raw in
            guard let ctx = CGContext(
                data: raw.baseAddress, width: w, height: h,
                bitsPerComponent: 8, bytesPerRow: bpr,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: fmt),
                  let img = ctx.makeImage()
            else { return }
            let out = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(
                out, "public.png" as CFString, 1, nil)
            else { return }
            CGImageDestinationAddImage(dest, img, nil)
            if CGImageDestinationFinalize(dest) { result = out as Data }
        }
        return result
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
