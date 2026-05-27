# LYS to STL Extraction Specification

This page documents the reverse-engineered mesh extraction contract used when importing `.lys` scene data and converting geometry to STL-like triangle meshes.

## Overview

A `.lys` file is a compressed archive containing:

1. **Manifest / Scene Data**: JSON files describing the scene, objects, and supports.
2. **Geometry Data**: Binary files (`.bin`) containing the raw mesh data (vertices and indices).

To extract geometry reliably:

1. unpack the `.lys` archive,
2. identify the geometry `.bin` file (usually the largest file),
3. parse the binary data according to the format below,
4. reconstruct mesh topology (triangle list),
5. write output triangles to STL.

## Binary mesh format (`.bin`)

The geometry file is a custom binary format containing a header, an index buffer, and a vertex buffer. All data is little-endian.

### File structure

| Section           | Offset (Bytes) | Size (Bytes)    | Description                            |
| :---------------- | :------------- | :-------------- | :------------------------------------- |
| **Header**        | 0              | 20              | Metadata (counts, version)             |
| **Index Buffer**  | 20             | `n_indices * 4` | List of vertex indices (`uint32`)      |
| **Vertex Buffer** | `20 + I_Size`  | `n_coords * 4`  | List of coordinate scalars (`float32`) |

### Header specification (20 bytes)

The header consists of 5 unsigned 32-bit integers (`uint32`).

| Field             | Byte Offset | Type     | Value / Notes                                  |
| :---------------- | :---------- | :------- | :--------------------------------------------- |
| **Version**       | 0-3         | `uint32` | Typically `2`.                                 |
| **Header Length** | 4-7         | `uint32` | Typically `12` or `20` (logic relies on `20`). |
| **Index Count**   | 8-11        | `uint32` | Number of indices (`n_indices`).               |
| **Coord Count**   | 12-15       | `uint32` | Number of scalar coordinates (`n_coords`).     |
| **Padding**       | 16-19       | `uint32` | Zero padding / reserved.                       |

!!! warning
      Data starts at byte 20. Reading from byte 16 shifts the index buffer and scrambles mesh topology.

### Index buffer

- Start offset: 20 bytes
- Data type: `uint32` (4 bytes per index)
- Count: `n_indices`
- Total size: `n_indices * 4`

**Topology**: triangle list. Every 3 indices form one triangle.

### Vertex buffer

- Start offset: `20 + (n_indices * 4)` bytes
- Data type: `float32`
- Count: `n_coords`
- Total size: `n_coords * 4`

Coordinates are grouped as `x, y, z` triplets.

## Conversion algorithm

### Step 1: Read header

Read counts from the first 16 bytes and set `DATA_OFFSET = 20`.

### Step 2: Read indices

Read and unpack `n_indices` little-endian `uint32` entries starting at offset 20.

### Step 3: Read vertices

Read and unpack `n_coords` little-endian `float32` entries starting immediately after the index buffer, then group by 3.

### Step 4: Reconstruct triangles

Iterate through indices in steps of 3 and emit triangle index triplets.

### Step 5: Write STL

Write binary STL:

1. 80-byte header
2. 4-byte triangle count
3. triangle records (50 bytes each): normal + three vertices + attribute byte count

## Troubleshooting

### Scrambled mesh / webbing

Likely offset error.

- Cause: reading from byte 16 instead of byte 20.
- Fix: enforce `DATA_OFFSET = 20`.

### Exploded vertices

Likely wrong scalar type.

- Cause: decoding as half-float or other type.
- Fix: use `float32`.

### Missing faces

Likely topology mismatch.

- Cause: attempting strip logic.
- Fix: parse as triangle list triplets.

## Related pages

- `docs/dev/formats.md`
- `docs/reference/file-formats.md`
