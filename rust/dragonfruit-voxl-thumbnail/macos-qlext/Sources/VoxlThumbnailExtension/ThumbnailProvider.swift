import QuickLookThumbnailing
import Foundation
import CoreGraphics
import ImageIO
import AppKit

/// QuickLook Thumbnail Extension for the files DragonFruit writes: VOXL scenes
/// and LUMEN prints.
///
/// Both formats are parsed directly — the VOXL V2 header and EXTD chunk, or the
/// LUMEN v1 chunk directory and its PREV previews — with no subprocess, which
/// App Sandbox compliance requires (the sandbox forbids Process()). The format is
/// decided by the file's own magic, not by its extension.
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

    // MARK: - Inline parsers

    /// The embedded preview of whichever container this is.
    private func extractThumbnail(from data: Data) throws -> Data {
        guard data.count >= 4 else {
            throw makeError("file is too short to identify")
        }

        switch (data[0], data[1], data[2], data[3]) {
        case (0x56, 0x4F, 0x58, 0x4C): // "VOXL"
            return try voxlThumbnail(from: data)
        case (0x4C, 0x55, 0x4D, 0x4E): // "LUMN"
            return try lumenPreview(from: data)
        default:
            throw makeError("not a DragonFruit scene or print file")
        }
    }

    // MARK: - VOXL V2

    private func voxlThumbnail(from data: Data) throws -> Data {
        // ── V2 header (16 bytes) ──────────────────────────────────────
        guard data.count >= 16 else {
            throw makeError("VOXL file is shorter than its header")
        }

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

    // MARK: - LUMEN v1

    /// The best unsealed `PREV` preview of a LUMEN print file.
    ///
    /// The chunk directory sits at the END of the file, after every payload, so
    /// this reads the header, seeks to the directory, and then reads only the
    /// preview it picked. A sealed preview needs the file's key and is skipped
    /// rather than failed on: such a file simply has no thumbnail to offer.
    private func lumenPreview(from data: Data) throws -> Data {
        let headerSize = 32
        let entrySize = 32
        let trailerSize = 8
        let sealedFlag: UInt32 = 0x10

        let fileLength = UInt64(data.count)
        guard fileLength >= UInt64(headerSize + trailerSize) else {
            throw makeError("LUMEN file is shorter than its header and trailer")
        }

        let version = data.readUInt32LE(at: 4)
        // v1 is the only layout this parser knows; a future version is refused
        // rather than misread.
        guard version == 1 else { throw makeError("LUMEN version \(version) is not v1") }

        // "LEND"
        guard data[data.count - 8] == 0x4C, data[data.count - 7] == 0x45,
              data[data.count - 6] == 0x4E, data[data.count - 5] == 0x44
        else { throw makeError("LUMEN file does not end with the LEND trailer") }

        let dirOffset = data.readUInt64LE(at: 8)
        let chunkCount = UInt64(data.readUInt32LE(at: 16))
        let dirBytes = chunkCount * UInt64(entrySize)

        // Every bound is checked in UInt64 before anything is converted to an
        // index, so a corrupt header cannot wrap into a valid-looking range.
        guard dirOffset >= UInt64(headerSize),
              dirOffset + dirBytes <= fileLength - UInt64(trailerSize)
        else { throw makeError("LUMEN chunk directory lies outside the file") }

        // Best role first, file order breaking ties.
        var candidates: [(rank: Int, index: Int, offset: Int, size: Int)] = []
        for index in 0..<Int(chunkCount) {
            let base = Int(dirOffset) + index * entrySize
            // "PREV"
            guard data[base] == 0x50, data[base + 1] == 0x52,
                  data[base + 2] == 0x45, data[base + 3] == 0x56
            else { continue }

            let flags = data.readUInt32LE(at: base + 28)
            if flags & sealedFlag != 0 { continue }
            guard let rank = previewRank(role: Int(flags & 0x0F)) else { continue }

            let offset = data.readUInt64LE(at: base + 4)
            let uncompressed = data.readUInt64LE(at: base + 12)
            // PREV is never compressed, but a sealed one is framed: a non-zero
            // stored size is the payload's real length.
            let stored = data.readUInt64LE(at: base + 20)
            let size = stored != 0 ? stored : uncompressed

            guard offset > 0, size > 0,
                  offset <= fileLength, size <= fileLength - offset
            else { continue }

            candidates.append((rank, index, Int(offset), Int(size)))
        }

        let ordered = candidates.sorted { ($0.rank, $0.index) < ($1.rank, $1.index) }
        for candidate in ordered {
            let payload = data.subdata(in: candidate.offset ..< candidate.offset + candidate.size)
            // The eight-byte PNG signature: a payload that is not a PNG is not a
            // preview Finder can show, so keep looking.
            if payload.count >= 8,
               payload[payload.startIndex] == 0x89,
               payload[payload.startIndex + 1] == 0x50,
               payload[payload.startIndex + 2] == 0x4E,
               payload[payload.startIndex + 3] == 0x47,
               payload[payload.startIndex + 4] == 0x0D,
               payload[payload.startIndex + 5] == 0x0A,
               payload[payload.startIndex + 6] == 0x1A,
               payload[payload.startIndex + 7] == 0x0A {
                return payload
            }
        }

        throw makeError("no unsealed PREV preview in LUMEN file")
    }

    /// Rank a preview role for a Finder thumbnail: the biggest image wins.
    /// `nil` is a reserved role, which LUMEN validation rejects rather than
    /// interprets.
    private func previewRank(role: Int) -> Int? {
        switch role {
        case 1: return 0  // large
        case 0: return 1  // unspecified
        case 2: return 2  // small
        case 3: return 3  // icon
        default: return nil
        }
    }

    // MARK: - Helpers

    private func makeError(_ message: String) -> NSError {
        NSError(
            domain: "org.openresinalliance.dragonfruit.thumbnail",
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

    func readUInt64LE(at offset: Int) -> UInt64 {
        UInt64(readUInt32LE(at: offset)) |
        (UInt64(readUInt32LE(at: offset + 4)) << 32)
    }
}
