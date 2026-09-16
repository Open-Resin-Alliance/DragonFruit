import QuickLookThumbnailing
import Compression
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
                handler(nil, makeThumbnailError("failed to decode PNG"))
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

    // MARK: - Declared file types

    /// One file type a plugin (or the core `.voxl` scene) declares, as compiled into
    /// the providers' table by `scripts/generate-plugin-registry.mjs`.
    private struct DeclaredFileType {
        let fileExtension: String
        let locator: ThumbnailLocator

        func matches(head: Data) -> Bool {
            !locator.magic.isEmpty && head.starts(with: locator.magic)
        }
    }

    /// Reads a stored preview using the declaration's own terms.
    ///
    /// Mirrors `rust/dragonfruit-voxl-thumbnail/src/locator.rs`: the grammar is small
    /// because it has to be interpreted twice - once here, for Finder, and once in
    /// Rust for Explorer and the freedesktop thumbnailers. Keeping the two in step is
    /// the price of not writing one parser per format per platform.
    private struct ThumbnailLocator {
        struct BinaryField {
            let width: Int
            let at: Int

            init?(_ json: [String: Any]?) {
                guard let json,
                      let type = json["type"] as? String,
                      let at = json["at"] as? Int
                else { return nil }

                switch type {
                case "u16": width = 2
                case "u32": width = 4
                case "u64": width = 8
                default: return nil
                }
                self.at = at
            }

            func read(_ bytes: Data) -> UInt64? {
                let start = bytes.startIndex + at
                guard at >= 0, start >= bytes.startIndex, start + width <= bytes.endIndex else { return nil }

                var value: UInt64 = 0
                for offset in 0..<width {
                    value |= UInt64(bytes[start + offset]) << (8 * offset)
                }
                return value
            }
        }

        struct Flags {
            let field: BinaryField
            let sealedBit: UInt32?
            let roleMask: UInt64?
            let roleOrder: [UInt64]
        }

        struct Compression {
            let field: BinaryField
            let stored: [UInt64]
            let zlib: [UInt64]
        }

        struct Entry {
            let typeAt: Int
            let offset: BinaryField
            let sizes: [BinaryField]
            let index: (field: BinaryField, value: UInt64)?
            let compression: Compression?
            let flags: Flags?
        }

        enum Payload {
            case png
            case jsonBase64(path: [String])
        }

        let magic: Data
        let version: (field: BinaryField, equals: UInt64?, atLeast: UInt64?)?
        let tableOffsetFixed: UInt64?
        let tableOffsetField: BinaryField?
        let tableCount: BinaryField
        let entrySize: UInt64
        let entry: Entry
        let previewChunks: [Data]
        let payload: Payload
        let trailer: (magic: Data, size: UInt64)?

        private struct Candidate {
            let rank: UInt64
            let order: Int
            let offset: UInt64
            let size: UInt64
            let compression: UInt64?
        }

        static func parse(_ json: [String: Any]) -> ThumbnailLocator? {
            guard let magic = (json["magic"] as? String)?.data(using: .ascii),
                  let directory = json["directory"] as? [String: Any],
                  let entryJSON = json["entry"] as? [String: Any],
                  let entryType = entryJSON["type"] as? [String: Any],
                  let typeAt = entryType["at"] as? Int,
                  let entryOffset = BinaryField(entryJSON["offset"] as? [String: Any]),
                  let sizesJSON = entryJSON["size"] as? [[String: Any]],
                  let previewChunks = (json["previewChunks"] as? [String])?.compactMap({ $0.data(using: .ascii) }),
                  let payloadJSON = json["payload"] as? [String: Any],
                  !previewChunks.isEmpty
            else { return nil }

            let sizes = sizesJSON.compactMap { BinaryField($0) }
            guard sizes.count == sizesJSON.count else { return nil }

            let tableOffsetFieldJSON = directory["offset"] as? [String: Any]
            let fixed = tableOffsetFieldJSON?["fixed"] as? Int
            let offsetField = fixed == nil ? BinaryField(tableOffsetFieldJSON) : nil
            if fixed == nil && offsetField == nil { return nil }

            guard let tableCount = BinaryField(directory["count"] as? [String: Any]),
                  let entrySize = (directory["entrySize"] as? Int).map(UInt64.init)
            else { return nil }

            var version: (BinaryField, UInt64?, UInt64?)? = nil
            if let versionJSON = json["version"] as? [String: Any], let field = BinaryField(versionJSON) {
                let equals = (versionJSON["equals"] as? Int).map(UInt64.init)
                let atLeast = (versionJSON["atLeast"] as? Int).map(UInt64.init)
                if equals == nil && atLeast == nil { return nil }
                version = (field, equals, atLeast)
            }

            var index: (BinaryField, UInt64)? = nil
            if let indexJSON = entryJSON["index"] as? [String: Any],
               let field = BinaryField(indexJSON),
               let value = (indexJSON["value"] as? Int).map(UInt64.init) {
                index = (field, value)
            }

            var compression: Compression? = nil
            if let compressionJSON = entryJSON["compression"] as? [String: Any],
               let field = BinaryField(compressionJSON),
               let zlib = (compressionJSON["zlib"] as? [Int])?.map(UInt64.init), !zlib.isEmpty {
                compression = Compression(
                    field: field,
                    stored: (compressionJSON["stored"] as? [Int])?.map(UInt64.init) ?? [],
                    zlib: zlib,
                )
            }

            var flags: Flags? = nil
            if let flagsJSON = entryJSON["flags"] as? [String: Any], let field = BinaryField(flagsJSON) {
                flags = Flags(
                    field: field,
                    sealedBit: (flagsJSON["sealedBit"] as? Int).map(UInt32.init),
                    roleMask: (flagsJSON["roleMask"] as? Int).map(UInt64.init),
                    roleOrder: (flagsJSON["roleOrder"] as? [Int])?.map(UInt64.init) ?? [],
                )
            }

            let payload: Payload
            switch payloadJSON["encoding"] as? String {
            case "png":
                payload = .png
            case "json-base64":
                guard let path = payloadJSON["jsonPath"] as? [String], !path.isEmpty else { return nil }
                payload = .jsonBase64(path: path)
            default:
                return nil
            }

            var trailer: (Data, UInt64)? = nil
            if let trailerJSON = json["trailer"] as? [String: Any],
               let trailerMagic = (trailerJSON["magic"] as? String)?.data(using: .ascii),
               let size = (trailerJSON["size"] as? Int).map(UInt64.init) {
                trailer = (trailerMagic, size)
            }

            return ThumbnailLocator(
                magic: magic,
                version: version,
                tableOffsetFixed: fixed.map(UInt64.init),
                tableOffsetField: offsetField,
                tableCount: tableCount,
                entrySize: entrySize,
                entry: Entry(
                    typeAt: typeAt,
                    offset: entryOffset,
                    sizes: sizes,
                    index: index,
                    compression: compression,
                    flags: flags,
                ),
                previewChunks: previewChunks,
                payload: payload,
                trailer: trailer,
            )
        }

        func extract(from data: Data) throws -> Data {
            let fileLength = UInt64(data.count)

            // ── Header ────────────────────────────────────────────────────────
            let headerLength = min(data.count, 64)
            let header = data.prefix(headerLength)
            guard header.starts(with: magic) else { throw makeThumbnailError("not a declared file type") }

            if let (field, equals, atLeast) = version {
                guard let version = field.read(header) else {
                    throw makeThumbnailError("the header is too short for its version field")
                }
                if let equals, version != equals {
                    throw makeThumbnailError("version \(version) is not the declared \(equals)")
                }
                if let atLeast, version < atLeast {
                    throw makeThumbnailError("version \(version) is below the declared \(atLeast)")
                }
            }

            // ── Trailer ───────────────────────────────────────────────────────
            if let trailer {
                guard fileLength >= trailer.size else { throw makeThumbnailError("the file is shorter than its trailer") }
                let start = data.count - Int(trailer.size)
                guard data.subdata(in: start..<data.count).starts(with: trailer.magic) else {
                    throw makeThumbnailError("the file does not end with the declared trailer")
                }
            }

            // ── Chunk table ───────────────────────────────────────────────────
            let tableOffset: UInt64
            if let fixed = tableOffsetFixed {
                tableOffset = fixed
            } else if let field = tableOffsetField, let read = field.read(header) {
                tableOffset = read
            } else {
                throw makeThumbnailError("the header is too short for the table offset")
            }

            guard let entryCount = tableCount.read(header) else {
                throw makeThumbnailError("the header is too short for the entry count")
            }
            // Bounds in UInt64 before anything becomes an index, so a corrupt count
            // cannot wrap into a valid-looking range.
            let tableBytes = entryCount.multipliedReportingOverflow(by: entrySize)
            let tableEnd = tableBytes.overflow ? nil : tableOffset.addingReportingOverflow(tableBytes.partialValue).partialValue
            guard !tableBytes.overflow, let tableEnd, tableEnd <= fileLength else {
                throw makeThumbnailError("the chunk table lies outside the file")
            }

            let tableStart = data.startIndex + Int(tableOffset)
            let table = data.subdata(in: tableStart..<(tableStart + Int(tableBytes.partialValue)))

            // ── Pick the best preview ─────────────────────────────────────────
            var candidates: [Candidate] = []
            for order in 0..<Int(entryCount) {
                let base = order * Int(entrySize)
                guard base + Int(entrySize) <= table.count else { continue }
                let chunk = table.subdata(in: (table.startIndex + base)..<(table.startIndex + base + Int(entrySize)))

                let typeStart = chunk.startIndex + entry.typeAt
                guard entry.typeAt >= 0, typeStart + 1 <= chunk.endIndex,
                      previewChunks.contains(where: { chunk[typeStart...].starts(with: $0) })
                else { continue }

                if let index = entry.index, index.field.read(chunk) != index.value { continue }

                var rank: UInt64 = 0
                if let flags = entry.flags {
                    let raw = flags.field.read(chunk) ?? 0
                    if let sealedBit = flags.sealedBit, raw & (1 << sealedBit) != 0 {
                        continue // needs the file's key; not a preview this extension can show
                    }
                    if let roleMask = flags.roleMask {
                        let role = raw & roleMask
                        guard let position = flags.roleOrder.firstIndex(of: role) else { continue }
                        rank = UInt64(position)
                    }
                }

                guard let offset = entry.offset.read(chunk),
                      let size = entry.sizes.compactMap({ $0.read(chunk) }).first(where: { $0 != 0 }),
                      size > 0, offset <= fileLength, size <= fileLength - offset
                else { continue }

                candidates.append(Candidate(
                    rank: rank,
                    order: order,
                    offset: offset,
                    size: size,
                    compression: entry.compression?.field.read(chunk),
                ))
            }

            // Best role first, table order breaking ties.
            candidates.sort { ($0.rank, $0.order) < ($1.rank, $1.order) }

            for candidate in candidates {
                let payloadStart = data.startIndex + Int(candidate.offset)
                var payload = data.subdata(in: payloadStart..<(payloadStart + Int(candidate.size)))

                if let compression = entry.compression {
                    switch candidate.compression {
                    case .some(let code) where compression.stored.contains(code):
                        break
                    case .some(let code) where compression.zlib.contains(code):
                        payload = try inflate(payload)
                    case .some(let code):
                        throw makeThumbnailError("unknown compression code \(code)")
                    case .none:
                        break
                    }
                }

                switch payload {
                case .png:
                    if isPNG(payload) { return payload }
                case .jsonBase64(let path):
                    if let png = pngFromJSON(payload, path: path) { return png }
                }
            }

            throw makeThumbnailError("no readable preview in this file")
        }
    }

    /// Every declared file type, read once from the table the registry generator
    /// compiled and the appex bundles.
    private static let declaredFileTypes: [DeclaredFileType] = {
        guard let url = Bundle.main.url(forResource: "outputFileTypes", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let entries = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
        else { return [] }

        return entries.compactMap { entry in
            guard let fileExtension = entry["fileExtension"] as? String,
                  let thumbnail = entry["thumbnail"] as? [String: Any],
                  let locator = ThumbnailLocator.parse(thumbnail)
            else { return nil }
            return DeclaredFileType(fileExtension: fileExtension, locator: locator)
        }
    }()

    /// The embedded preview of whichever declared container this is.
    private func extractThumbnail(from data: Data) throws -> Data {
        let head = data.prefix(8)

        guard let declared = ThumbnailProvider.declaredFileTypes.first(where: { $0.matches(head: Data(head)) }) else {
            throw makeThumbnailError("not a file type this extension declares")
        }

        return try declared.locator.extract(from: data)
    }


    /// The base64 PNG at a JSON path inside a chunk payload, or `nil` when that path
    /// is absent - an extension chunk without a preview is unhelpful, not an error.

    /// A zlib stream back to bytes. The framework needs the destination size up front,
    /// so the buffer grows until the payload fits rather than trusting a declared size.


    // MARK: - Helpers

}

private func isPNG(_ data: Data) -> Bool {
    data.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
}

private func pngFromJSON(_ payload: Data, path: [String]) -> Data? {
    guard var cursor = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] else { return nil }

    for (position, key) in path.enumerated() {
        let value = cursor[key]
        if position == path.count - 1 {
            guard let encoded = value as? String, let decoded = Data(base64Encoded: encoded) else { return nil }
            return isPNG(decoded) ? decoded : nil
        }
        guard let next = value as? [String: Any] else { return nil }
        cursor = next
    }

    return nil
}

private func inflate(_ payload: Data) throws -> Data {
    var capacity = max(64 * 1024, payload.count * 4)
    let limit = 64 * 1024 * 1024

    while capacity <= limit {
        var output = Data(count: capacity)
        let written = output.withUnsafeMutableBytes { destination -> Int in
            guard let destinationBase = destination.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            return payload.withUnsafeBytes { source -> Int in
                guard let sourceBase = source.bindMemory(to: UInt8.self).baseAddress else { return 0 }
                return compression_decode_buffer(
                    destinationBase,
                    destination.count,
                    sourceBase,
                    payload.count,
                    nil,
                    COMPRESSION_ZLIB,
                )
            }
        }

        if written > 0 && written < capacity {
            output.removeSubrange(written..<output.count)
            return output
        }
        capacity *= 2
    }

    throw makeThumbnailError("decompression failed")
}

// MARK: - Helpers

private func makeThumbnailError(_ message: String) -> NSError {
    NSError(
        domain: "org.openresinalliance.dragonfruit.thumbnail",
        code: -1,
        userInfo: [NSLocalizedDescriptionKey: message]
    )
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
