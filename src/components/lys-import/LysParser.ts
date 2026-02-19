import * as THREE from 'three';
import { decode } from '@msgpack/msgpack';

// Default App ID Key for decryption (from python script)
const DEFAULT_APP_ID = "a8ee1146-8d03-4b69-8a67-59009a3f9ee7";

export interface LysData {
    geometry: THREE.BufferGeometry;
    sceneData: any; // Decoded MessagePack data
}

export class LysParser {
    /**
     * Parse a .lys file (Lychee Slicer Scene)
     * @param file The .lys file object
     * @returns Promise resolving to the geometry and scene data
     */
    static async parse(file: File): Promise<LysData> {
        const buffer = await file.arrayBuffer();
        const data = new Uint8Array(buffer);
        const textDecoder = new TextDecoder('utf-8');

        // 1. Extract Manifest (JSON)
        const { start, end } = this.findJsonHeader(data);
        const manifestStr = textDecoder.decode(data.subarray(start, end));
        let manifest: any;
        try {
            manifest = JSON.parse(manifestStr);
        } catch (e) {
            console.error('[LysParser] Manifest JSON:', manifestStr);
            throw new Error(`Failed to parse LYS manifest: ${e}`);
        }

        // Data section starts after JSON header (skip null padding)
        let dataStart = end;
        while (dataStart < data.length && data[dataStart] === 0) {
            dataStart++;
        }

        console.log('[LysParser] File Structure:', {
            fileSize: data.length,
            jsonStart: start,
            jsonEnd: end,
            dataStart,
            paddingBytes: dataStart - end
        });

        const filesInfo = manifest.mangoFiles || {};

        let sceneBlob: Uint8Array | null = null;
        let geomBlob: Uint8Array | null = null;
        let largestBinSize = 0;

        // 2. Locate Files in Blob
        for (const [fname, info] of Object.entries(filesInfo) as [string, any][]) {
            const name = fname.toLowerCase();
            const offset = Number(info.offset || 0);
            const size = Number(info.size || 0);
            const absOffset = dataStart + offset;

            console.log(`[LysParser] Found File: ${name}`, {
                manifestOffset: offset,
                manifestSize: size,
                calcAbsOffset: absOffset,
                fitsInFile: absOffset + size <= data.length
            });

            if (name === 'scene.bin') {
                if (absOffset + size > data.length) {
                    console.error(`[LysParser] CRITICAL: scene.bin bounds [${absOffset}, ${absOffset + size}] exceed file size ${data.length}`);
                }
                sceneBlob = data.subarray(absOffset, absOffset + size);
            } else if (name.endsWith('.bin')) {
                // Heuristic: The largest .bin file that isn't scene.bin is the geometry
                if (size > largestBinSize) {
                    largestBinSize = size;
                    geomBlob = data.subarray(absOffset, absOffset + size);
                }
            }
        }

        if (!sceneBlob) {
            console.warn("LysParser: scene.bin not found in manifest");
        }
        if (!geomBlob) {
            throw new Error("LysParser: No geometry .bin file found");
        }

        // 3. Decrypt & Decode Scene Data
        let sceneData: any = {};
        if (sceneBlob) {
            console.log(`[LysParser] Decrypting scene.bin (${sceneBlob.length} bytes)...`);
            // Debug: Check first few bytes before decryption
            if (sceneBlob.length > 0) {
                console.log(`[LysParser] First 8 bytes (encrypted):`, Array.from(sceneBlob.subarray(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '));
            }

            const decrypted = this.decryptBytes(sceneBlob, DEFAULT_APP_ID);

            if (decrypted.length > 0) {
                console.log(`[LysParser] First 8 bytes (decrypted):`, Array.from(decrypted.subarray(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '));
            }

            try {
                sceneData = decode(decrypted);
                console.log('[LysParser] Scene Decoded Successfully');
            } catch (e: any) {
                console.error("LysParser: Failed to decode scene msgpack", e);
                console.error("LysParser: Msgpack error details:", e?.message);

                // Inspect end of buffer
                const len = decrypted.length;
                const tail = decrypted.subarray(Math.max(0, len - 16), len);
                console.log(`[LysParser] Last 16 bytes (decrypted):`, Array.from(tail).map(b => b.toString(16).padStart(2, '0')).join(' '));

                throw new Error(`Failed to decode scene data: ${e.message}`);
            }
        }

        // 4. Parse Geometry
        // We pass the raw ArrayBuffer slice for DataView access
        // Note: geomBlob is a Uint8Array, .buffer refers to the whole file buffer if it's a subarray
        // We need to slice it to get a clean buffer for parsing if we use offset=0 logic, 
        // OR we just pass the subarray and carefully use offsets.
        // Let's create a copy to be safe and simple for the parser
        const geometry = this.parseGeometry(geomBlob!.slice().buffer);

        return {
            geometry,
            sceneData
        };
    }

    private static findJsonHeader(data: Uint8Array): { start: number, end: number } {
        // Some LYS variants no longer start with '{"version"'.
        // Robustly scan for the first valid top-level JSON object that looks like
        // a manifest (contains mangoFiles) or at least version metadata.
        const decoder = new TextDecoder('utf-8');
        const maxScan = Math.min(data.length, 2_000_000);

        const tryExtractObjectBounds = (start: number): { start: number, end: number } | null => {
            let depth = 0;
            let inString = false;
            let escaped = false;

            for (let i = start; i < maxScan; i++) {
                const c = data[i];

                if (inString) {
                    if (escaped) {
                        escaped = false;
                        continue;
                    }
                    if (c === 92) { // '\\'
                        escaped = true;
                        continue;
                    }
                    if (c === 34) { // '"'
                        inString = false;
                    }
                    continue;
                }

                if (c === 34) { // '"'
                    inString = true;
                    continue;
                }
                if (c === 123) { // '{'
                    depth++;
                    continue;
                }
                if (c === 125) { // '}'
                    depth--;
                    if (depth === 0) {
                        return { start, end: i + 1 };
                    }
                    if (depth < 0) return null;
                }
            }

            return null;
        };

        // Prefer objects near where "mangoFiles" appears.
        const marker = new TextEncoder().encode('"mangoFiles"');
        const markerStarts: number[] = [];
        for (let i = 0; i <= maxScan - marker.length; i++) {
            let ok = true;
            for (let j = 0; j < marker.length; j++) {
                if (data[i + j] !== marker[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) markerStarts.push(i);
        }

        const candidateStarts: number[] = [];

        // Backtrack from each marker to likely object start.
        for (const m of markerStarts) {
            for (let i = m; i >= Math.max(0, m - 200_000); i--) {
                if (data[i] === 123) { // '{'
                    candidateStarts.push(i);
                    break;
                }
            }
        }

        // Fallback: scan for top-level object starts from file head.
        for (let i = 0; i < maxScan; i++) {
            if (data[i] === 123) candidateStarts.push(i);
            if (candidateStarts.length > 2000) break;
        }

        const seen = new Set<number>();
        for (const start of candidateStarts) {
            if (seen.has(start)) continue;
            seen.add(start);

            const bounds = tryExtractObjectBounds(start);
            if (!bounds) continue;

            try {
                const raw = decoder.decode(data.subarray(bounds.start, bounds.end));
                const parsed = JSON.parse(raw) as any;
                if (parsed && typeof parsed === 'object') {
                    if (parsed.mangoFiles || parsed.version || parsed.scene) {
                        return bounds;
                    }
                }
            } catch {
                // continue scanning
            }
        }

        // Helpful diagnostic if file is ZIP-like (PK\x03\x04)
        if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b) {
            throw new Error('Unsupported .lys container variant (ZIP-like). Manifest JSON header not found.');
        }

        throw new Error('LYS manifest JSON header not found');
    }

    private static decryptBytes(data: Uint8Array, key: string): Uint8Array {
        const out = new Uint8Array(data.length);
        const keyBytes = new TextEncoder().encode(key);
        const klen = keyBytes.length;

        for (let i = 0; i < data.length; i++) {
            // Python: (b - ord(key[i % klen])) % 256
            // JS: (b - key[i%klen]) & 0xFF checks out for modulo 256 wrap
            // Wait, Python's % operator handles negatives differently. 
            // If b < key, result is negative. Python -5 % 256 = 251. 
            // JS -5 % 256 = -5. 
            // So we need proper modulo: ((n % m) + m) % m
            const k = keyBytes[i % klen];
            const val = (data[i] - k);
            out[i] = ((val % 256) + 256) % 256;
        }
        return out;
    }

    private static parseGeometry(buffer: ArrayBuffer): THREE.BufferGeometry {
        const view = new DataView(buffer);

        // Header is 20 bytes
        // 0-3: Version
        // 4-7: Header Length
        // 8-11: Index Count
        // 12-15: Coord Count
        // 16-19: Padding / Reserved

        // Critical: Data starts at Offset 20
        const DATA_OFFSET = 20;

        if (buffer.byteLength < DATA_OFFSET) {
            throw new Error("Geometry file too short");
        }

        const nIndices = view.getUint32(8, true); // Little Endian
        const nCoords = view.getUint32(12, true);

        // Indices
        const indicesByteLen = nIndices * 4;
        const indicesStart = DATA_OFFSET;
        // Slice to create typed array
        const indices = new Uint32Array(buffer.slice(indicesStart, indicesStart + indicesByteLen));

        // Coords
        const coordsStart = indicesStart + indicesByteLen;
        const coordsByteLen = nCoords * 4;
        const coords = new Float32Array(buffer.slice(coordsStart, coordsStart + coordsByteLen));

        // Construct Geometry
        const geometry = new THREE.BufferGeometry();

        // Set Attributes
        geometry.setAttribute('position', new THREE.BufferAttribute(coords, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));

        // CRITICAL: User expects "STL-like" flat shading (sharp edges).
        // Indexed geometry with computeVertexNormals() creates smooth shading,
        // which looks bad on mechanical parts (cylinders, etc).
        // Converting to Non-Indexed splits vertices, ensuring flat face normals.
        const flatGeometry = geometry.toNonIndexed();

        // Compute normals for lighting (will now be flat per face)
        flatGeometry.computeVertexNormals();

        return flatGeometry;
    }
}
