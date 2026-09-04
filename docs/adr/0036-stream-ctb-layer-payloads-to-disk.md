---
issue: df-plugin-ctb-10
kind: decision
date: 2026-07-20
---

# ADR-0036: Stream CTB layer payloads to disk instead of buffering the whole job in memory

**Status**: accepted

Context: laminating a 10M-triangle mesh with 3DAA (3-bit) at 16k resolution to `.ctb` (Saturn 4 Ultra) OOM'd on both Windows and Debian — RSS grew linearly with no plateau, from ~9GB to ~42.8GB, before crashing. Investigation found this had two independent causes, not one: the 3DAA raster pipeline itself produced layers faster than Z-blend/support-compositing/LUT/dithering could drain them (fixed separately by Aaron, upstream of any output encoder — capped the same job around 16GB), and, downstream of that, `CtbRleStreamingEncoder` in the `df-plugin-ctb` submodule retained every layer's encoded bytes in a `Vec` for the entire job, only releasing them at finalize, while the container assembler additionally triple-copied the payload region when writing the final file.

Decision: `CtbRleStreamingEncoder` now writes each layer's encoded payload straight to a scratch file as it arrives (with a small out-of-order reorder buffer, since 3DAA's parallel post-processing can finish layers out of index order), keeping only a lightweight per-layer record in memory instead of the payload bytes. `finalize_to_path` streams the non-encrypted CTB v5 container straight to the destination file. We deliberately scoped this to the non-encrypted format only — encrypted (v5enc) CTB's layer-pointer table needs random-access patching, which isn't trivially streamable, so it still assembles once in memory at finalize (a one-time cost now, not a sustained one) rather than extending the streaming machinery or the shared `FormatEncoder`/`RleStreamEncoder` trait to cover it.

Consequences: the fix lives in `plugins/ctb` (df-plugin-ctb PR #10, branch `ender/ctb-streaming-encoder-oom-fix`), separate from the raster-side fix Aaron landed in `dragonfruit-slicing-engine`. Both were needed — fixing only one leaves the other as the new memory ceiling. Both bugs manifested identically as "RSS grows linearly with no plateau" in an external memory graph (Windows Perf Monitor / Debian `smem`); that graph alone couldn't localize which internal structure was responsible, since the pipeline has several candidate unbounded buffers across raster → Z-blend/LUT/dithering → RLE encode → container encode. If a "memory grows without bound" report shows up again in this pipeline, don't stop at the first unbounded-looking structure — check backpressure at every producer/consumer boundary along that chain. If encrypted CTB profiles need laminating at 16k+, `build_ctb_encrypted_container_bytes_with_progress` will need the same treatment; that's deferred here as out of scope.
