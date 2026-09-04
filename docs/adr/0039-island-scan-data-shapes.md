---
issue: islands-memory
kind: decision
date: 2026-08-21
---

# ADR-0039: The island scan stores voxels in buffers, not in objects

**Status**: accepted

Context: a 5292-layer scan of a 3647×1814 grid put the WebKit content process at 27 GB and it was killed against WebKit's hard 16 GB ceiling, leaving the window grey with nothing to explain it. The process reported `javascript_gc_object_count: 99,593,201` as it died. Nothing was leaking — the memory came back between runs — the peak alone was fatal. Every structure involved was written the idiomatic way, and that is precisely what made it fatal: an object per voxel, a `Set` of boxed numbers per voxel, a typed array per row, a fresh coordinate object per lookup.

Decision: in the island scan's hot structures, **a voxel is an offset into a buffer, never an object**. Four shapes follow from that, and each one is load-bearing:

**Contact footprints are interleaved `Float32Array`s** behind accessor helpers, not `{ x, y }[]`. This alone took the live object count from 99.6 million to 11 million. Footprints are retained — they live in React state and in the scan cache — so their representation is the one that matters most.

**Empty RLE rows are one shared array.** A layer is 1814 rows and a scan is 5292 layers, so the naive `new Int32Array(0)` per empty row allocated 9.6 million typed arrays holding half a megabyte between them. Sharing is sound because rows are never written in place: producers build a fresh row and assign it. Structured clone preserves identity within a message, so the sharing survives the trip from the worker. Live arrays dropped from 9,599,688 to 32,304.

**The flood fill consumes its candidate set.** Deleting each voxel as it is reached makes the candidate set itself the unvisited set, instead of a second `Set` holding the same ten million boxed numbers. Claiming a neighbour becomes one hash lookup rather than three. The cost is a contract: `buildIslands` empties what it is given.

**Grid coordinates are read, not unpacked.** `unpack` returns a fresh object, and the flood calls it once per voxel as it walks plus twice more per voxel afterwards — around thirty million throwaway objects to carry three numbers. Component accessors do the same arithmetic and allocate nothing; that change alone took the flood from 20 seconds to 14.

Consequences: **the readable shape is the dangerous one here**, so these four will look like candidates for cleanup to anyone who has not measured. `{ x, y }` reads better than an accessor call, and a separate visited set reads better than mutating the input. Reverting any of them in good faith puts the peak back where it was. The boundary is drawn where the data stops being retained: the auto-support placement helpers still take point arrays, materialised for the duration of one placement run, because their results are discarded immediately and their algorithms are unit-tested against plain arrays. Peak footprint for a full scan went from 14 GB measured continuously — 27 GB at the crash — to 5.1 GB, and the scan from over a minute to about 45 seconds. Anything added to these paths should be measured against the phase and step timings the scan writes to the app log, rather than reasoned about from the source.
