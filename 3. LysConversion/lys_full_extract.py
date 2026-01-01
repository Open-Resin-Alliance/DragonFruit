"""
Lychee Slicer - FULL EXTRACTOR (Scratch)

Purpose:
- Given a .lys file, extract ALL embedded files per manifest (with SHA256 verification)
- For every extracted *.bin:
    - Decrypt using applicationId key (default: v7.4.5)
    - Attempt MessagePack decode and emit JSON sidecar
- Build a supports-focused index summarizing where support positions/angles/IDs are found

Usage:
  python lys_full_extract.py <path/to/file.lys> [--app-id UUID] [--out DIR]

Notes:
- Default app-id key is for Lychee Slicer 7.4.5 (applicationId)
- Output directory defaults to <lys_stem>_full_extract next to the .lys
"""

import argparse
import hashlib
import json
import struct
from pathlib import Path
import msgpack

DEFAULT_APP_ID = "a8ee1146-8d03-4b69-8a67-59009a3f9ee7"  # v7.4.5 applicationId

SUPPORT_KEYS = {
    "supports", "support", "islands", "tips", "anchors", "nodes", "edges",
    "pillars", "cones", "contact", "contactPoints", "base", "raft",
    "angle", "angles", "rotation", "rot", "quaternion", "orientation",
    "position", "pos", "origin", "transform", "matrix", "translation",
    "id", "uid", "uuid", "hash", "name", "type"
}


def decrypt_bytes(data: bytes, key: str) -> bytes:
    out = bytearray(len(data))
    klen = len(key)
    for i, b in enumerate(data):
        out[i] = (b - ord(key[i % klen])) % 256
    return bytes(out)


def find_json_header(data: bytes) -> tuple[int, int]:
    # Find JSON header by brace counting from '{"version"'
    start = data.find(b'{"version"')
    if start == -1:
        raise ValueError("JSON manifest start not found in .lys")
    brace = 0
    end = start
    for i in range(start, len(data)):
        c = data[i]
        if c == 123:  # '{'
            brace += 1
        elif c == 125:  # '}'
            brace -= 1
            if brace == 0:
                end = i + 1
                break
    if end <= start:
        raise ValueError("JSON manifest end not found / unbalanced braces")
    return start, end


def extract_manifest(lys_bytes: bytes) -> tuple[dict, int, bytes, bytes]:
    js, je = find_json_header(lys_bytes)
    manifest = json.loads(lys_bytes[js:je].decode("utf-8"))
    # Save the header bytes (everything before manifest JSON)
    header = lys_bytes[0:js]
    # Data section starts after header (skip null padding)
    ds = je
    while ds < len(lys_bytes) and lys_bytes[ds] == 0:
        ds += 1
    # Save the exact padding bytes
    padding = lys_bytes[je:ds]
    return manifest, ds, header, padding


def write_bytes(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def verify_sha256(label: str, data: bytes, expected_hash: str):
    actual = hashlib.sha256(data).hexdigest()
    ok = (actual == expected_hash)
    return ok, actual


def scan_json_for_supports(obj, path_prefix=""):
    findings = []
    def rec(node, p):
        if isinstance(node, dict):
            for k, v in node.items():
                pk = f"{p}.{k}" if p else k
                if k in SUPPORT_KEYS:
                    # Summarize the shape of the value
                    summary = {
                        "path": pk,
                        "type": type(v).__name__,
                    }
                    if isinstance(v, (int, float, str, bool)) or v is None:
                        summary["value_preview"] = v
                    elif isinstance(v, (list, tuple)):
                        summary["len"] = len(v)
                        if v:
                            summary["first_item_type"] = type(v[0]).__name__
                    elif isinstance(v, dict):
                        summary["keys"] = list(v.keys())[:15]
                    findings.append(summary)
                rec(v, pk)
        elif isinstance(node, (list, tuple)):
            for idx, v in enumerate(node):
                rec(v, f"{p}[{idx}]")
    rec(obj, path_prefix)
    return findings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lys", help="Path to .lys file")
    ap.add_argument("--app-id", default=DEFAULT_APP_ID, help="applicationId key (default: v7.4.5)")
    ap.add_argument("--out", default=None, help="Output directory (default: <lys_stem>_full_extract)")
    args = ap.parse_args()

    lys_path = Path(args.lys)
    if not lys_path.exists():
        raise FileNotFoundError(lys_path)

    out_dir = Path(args.out) if args.out else lys_path.with_name(f"{lys_path.stem}_full_extract")
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Reading: {lys_path}")
    data = lys_path.read_bytes()

    print("Parsing manifest...")
    manifest, data_start, header, padding = extract_manifest(data)

    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"Manifest saved: {out_dir / 'manifest.json'}")
    
    # Save header and padding for rebuilding
    (out_dir / "header.bin").write_bytes(header)
    print(f"Header saved: {out_dir / 'header.bin'} ({len(header)} bytes)")
    (out_dir / "padding.bin").write_bytes(padding)
    print(f"Padding saved: {out_dir / 'padding.bin'} ({len(padding)} bytes)")

    # Extract all files listed in manifest
    files_info = manifest.get("mangoFiles", {})
    results_index = {
        "source": str(lys_path),
        "out_dir": str(out_dir),
        "manifest_version": manifest.get("version"),
        "files": [],
        "support_findings": []
    }

    for fname, info in files_info.items():
        size = info.get("size")
        off = int(info.get("offset", 0))
        sha = info.get("integrity", {}).get("hash", "")
        abs_off = data_start + off
        blob = data[abs_off:abs_off + size]

        raw_out = out_dir / fname
        write_bytes(raw_out, blob)

        ok, actual = verify_sha256(fname, blob, sha)
        results_index["files"].append({
            "name": fname,
            "size": size,
            "offset": off,
            "sha256_expected": sha,
            "sha256_actual": actual,
            "sha256_ok": ok,
            "path": str(raw_out)
        })
        status = "OK" if ok else "MISMATCH"
        print(f"Extracted {fname} ({size} bytes) - SHA256 {status}")

        # For .bin, try decrypt and msgpack
        if fname.lower().endswith(".bin"):
            dec = decrypt_bytes(blob, args.app_id)
            dec_path = raw_out.with_suffix(".decrypted.bin")
            write_bytes(dec_path, dec)

            # Try decode as MessagePack
            try:
                obj = msgpack.unpackb(dec, raw=False, strict_map_key=False)
                json_path = raw_out.with_suffix(".decrypted.json")
                write_bytes(json_path, json.dumps(obj, indent=2, ensure_ascii=False).encode("utf-8"))
                print(f"  -> Decrypted+Decoded: {json_path.name}")

                # Scan for supports
                findings = scan_json_for_supports(obj, path_prefix=fname+".decrypted")
                results_index["support_findings"].extend(findings)
            except Exception as e:
                print(f"  -> Not MessagePack / decode failed: {type(e).__name__}: {e}")

    # Save index
    index_path = out_dir / "__index_full_extract.json"
    write_bytes(index_path, json.dumps(results_index, indent=2, ensure_ascii=False).encode("utf-8"))
    print(f"\nIndex saved: {index_path}")

    # Also write a focused supports report
    supports_path = out_dir / "__supports_summary.json"
    write_bytes(supports_path, json.dumps(results_index.get("support_findings", []), indent=2, ensure_ascii=False).encode("utf-8"))
    print(f"Supports summary: {supports_path}")

    print("\nDONE: Full extraction and decryption complete.")


if __name__ == "__main__":
    main()
