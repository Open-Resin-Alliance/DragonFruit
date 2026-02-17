# LYS to STL Extraction Specification

This document details the reverse-engineered specification for extracting 3D mesh geometry from Lychee Slicer (`.lys`) scene files and converting it to the standard STL format.

## 1. High-Level Overview

A `.lys` file is a compressed archive containing:
1.  **Manifest / Scene Data**: JSON files describing the scene, objects, and supports.
2.  **Geometry Data**: Binary files (`.bin`) containing the raw mesh data (vertices and indices).

To extract the STL, you must:
1.  **Unpack** the `.lys` archive.
2.  **Identify** the geometry `.bin` file (usually the largest file).
3.  **Parse** the binary data according to the format below.
4.  **Reconstruct** the mesh topology (Triangle List).
5.  **Write** to STL.

---

## 2. Binary Mesh Format (.bin)

The geometry file is a custom binary format containing a header, an index buffer, and a vertex buffer. All data is Little-Endian (`<`).

### 2.1. File Structure

| Section | Offset (Bytes) | Size (Bytes) | Description |
| :--- | :--- | :--- | :--- |
| **Header** | 0 | 20 | Metadata (Counts, Version) |
| **Index Buffer** | 20 | `n_indices * 4` | List of vertex indices (Uint32) |
| **Vertex Buffer**| `20 + I_Size` | `n_coords * 4` | List of coordinate scalars (Float32) |

### 2.2. Header Specification (20 Bytes)

The header consists of 5 unsigned 32-bit integers (`uint32`).

| Field | Byte Offset | Type | Value / Notes |
| :--- | :--- | :--- | :--- |
| **Version** | 0-3 | `uint32` | Typically `2`. |
| **Header Length** | 4-7 | `uint32` | Typically `12` or `20`. (Logic relies on 20). |
| **Index Count** | 8-11 | `uint32` | Number of indices (`n_indices`). Defines the length of Index Buffer. |
| **Coord Count** | 12-15 | `uint32` | Number of scalar coordinates (`n_coords`). Defines length of Vertex Buffer. |
| **Padding** | 16-19 | `uint32` | Zero padding / Reserved. |

**Critical Finding**: The data starts exactly at **Byte 20**. Attempting to read from Byte 16 (ignoring padding) will shift the index buffer, causing invalid topology (scrambled mesh).

### 2.3. Index Buffer

*   **Start Offset**: 20 bytes.
*   **Data Type**: `uint32` (4 bytes per index).
*   **Count**: `n_indices` (from Header).
*   **Total Size**: `n_indices * 4` bytes.

**Topology**: **Triangle List**.
The indices are organized in sequential triplets. Every 3 indices form one triangle.
*   Triangle 0: `(Index[0], Index[1], Index[2])`
*   Triangle 1: `(Index[3], Index[4], Index[5])`
*   ...

*Note: Earlier hypotheses about "Triangle Strips" were incorrect and caused by the Byte 16 offset error.*

### 2.4. Vertex Buffer

*   **Start Offset**: `20 + (n_indices * 4)` bytes.
*   **Data Type**: `float32` (4 bytes per scalar).
*   **Count**: `n_coords` (from Header).
*   **Total Size**: `n_coords * 4` bytes.

The coordinates are a flat list of `x, y, z` values.
*   Vertex 0: `(Coord[0], Coord[1], Coord[2])`
*   Vertex 1: `(Coord[3], Coord[4], Coord[5])`
*   ...

---

## 3. Conversion Algorithm (Python Logic)

### Step 1: Read Header
Read the first 16 bytes to get counts, but skip 20 bytes to reach data.

```python
# Read binary file
with open("geometry.bin", 'rb') as f:
    data = f.read()

# Parse Header Counts
# We only need indices count (at offset 8) and coords count (at offset 12)
vals = struct.unpack('<IIII', data[:16]) 
n_indices = vals[2]
n_coords = vals[3]

# Define Payload Start
DATA_OFFSET = 20 
```

### Step 2: Read Indices
```python
# Calculate Buffer End
indices_end_offset = DATA_OFFSET + (n_indices * 4)

# Extract Raw Bytes
indices_raw = data[DATA_OFFSET : indices_end_offset]

# Unpack as Uint32 (Little Endian)
indices = struct.unpack(f'<{n_indices}I', indices_raw)
```

### Step 3: Read Vertices
```python
# Calculate Buffer Start/End
coords_start_offset = indices_end_offset
coords_end_offset = coords_start_offset + (n_coords * 4)

# Extract Raw Bytes
coords_raw = data[coords_start_offset : coords_end_offset]

# Unpack as Float32 (Little Endian)
coords = struct.unpack(f'<{n_coords}f', coords_raw)

# Group into (x,y,z) tuples
vertices = []
for i in range(0, len(coords), 3):
    vertices.append((coords[i], coords[i+1], coords[i+2]))
```

### Step 4: Reconstruct Triangles (Triangle List)
```python
triangles = []
# Iterate in steps of 3
for i in range(0, len(indices) - 2, 3):
    v1_idx = indices[i]
    v2_idx = indices[i+1]
    v3_idx = indices[i+2]
    
    # Store the triangle
    triangles.append((v1_idx, v2_idx, v3_idx))
```

### Step 5: Write STL
Write the Standard Binary STL format:
1.  **Header**: 80 bytes (zeroed or description).
2.  **Triangle Count**: 4 bytes (`uint32`).
3.  **Triangles**: 50 bytes each:
    *   Normal (12 bytes, `float32` x3) - Can be set to `0,0,0` (slicers auto-calculate).
    *   Vertex 1 (12 bytes, `float32` x3).
    *   Vertex 2 (12 bytes, `float32` x3).
    *   Vertex 3 (12 bytes, `float32` x3).
    *   Attribute Byte Count (2 bytes, `uint16`) - Set to `0`.

---

## 4. Troubleshooting & Verification

*   **Scrambled Mesh / Webbing**: 
    If the mesh looks like a "spiderweb" or has "needles" shooting everywhere, you likely have an **Offset Error**.
    *   *Cause*: Reading from Byte 16 instead of Byte 20 shifts the index buffer by 4 bytes (1 integer). This turns `(0, 1, 2)` into `(X, 0, 1)`, connecting unrelated vertices.
    *   *Fix*: Ensure `DATA_OFFSET = 20`.

*   **Exploded Vertices**:
    If vertices are completely random noise.
    *   *Cause*: Incorrect Data Type (e.g., trying to read Half-Float 16-bit instead of Float32).
    *   *Fix*: Always use `float32`.

*   **Missing Faces (Holes)**:
    If the mesh has holes or missing triangles.
    *   *Cause*: Topology mismatch. You might be parsing as a Triangle Strip when it is a Triangle List.
    *   *Fix*: Use standard Triangle List parsing (triplets).
