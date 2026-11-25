# Native Mesh Store

The native mesh store holds meshes on the Rust side under ids the caller passes back. Put a
mesh, get an id, name the id in each command, and collect each result by the id the command
returns. Reach for it whenever a native mesh operation needs a mesh from the frontend: passes
that use it can run at the same time on different meshes, which the staging register cannot do.

[ADR-0048](../adr/0048-native-mesh-store.md) records the decision and the migration order.

## Why not the staging register

`stage_mesh_binary_set` writes one process-wide slot, and the next command that reads staging
reads whatever is there. Two passes in flight on two meshes read each other's mesh and nothing
errors, so the frontend had to queue every pass. The register stays for the families not yet
migrated (hole punch, organic cut, islands, shrink-wrap, slicing); new code should not add
callers to it.

## Public surface

**Rust** (`src-tauri/src/mesh_store.rs`, no Tauri types):

- `MeshStore` with `put`, `get`, `take`, `owner_of`, `drop_ids`, `drop_other_frontend_clients`
  and `stats`; `mesh_store::global()` is the process's store.
- Readers that check the kind: `get_soup`, `read_bytes` and `take_bytes` (a soup or a buffer),
  and `hollow_source`.
- `Entry`: what an entry holds, a closed enum.
  - `Entry::Soup`: a little-endian `f32` triangle soup, nine floats per triangle.
  - `Entry::Buffer`: an output that is not a mesh, as raw little-endian bytes. The command
    that returns its id says what is in it.
  - `Entry::Session`: what a long-lived operation keeps between calls.
    `Session::Hollow` holds a `HollowSource` (`hollow_source.rs`).
- `Owner`: who an entry belongs to. `Owner::Frontend` is one page load.
- `StoreError`, whose string form starts with `mesh-store/<code>:`:
  - `Expired`: released to stay inside the budget.
  - `Unknown`: never stored, or dropped.
  - `WrongKind`: the id holds another kind than the reader asked for.

**Commands** (`src-tauri/src/mesh_store_ipc.rs`):

| Command | Does |
| --- | --- |
| `mesh_store_put` | Stores the raw request body as a soup; the client id rides in the `x-mesh-client-id` header. Returns the id. |
| `mesh_store_read(meshId, release?)` | Returns the bytes of a soup or a buffer. With `release` the entry is dropped as it is read, without a copy when no operation holds it. A session fails with `wrong_kind` and stays. |
| `mesh_store_drop(meshIds)` | Drops ids, returns how many were still there. A missing id is not an error. |
| `mesh_store_open_client(clientId)` | Announces a page load's client and drops the entries of earlier ones. |
| `mesh_store_stats` | `entries`, `bytes`, `peakBytes`, `budgetBytes`, `evictions`, `expiredReads`. |

**Operation commands on the store.** These take an optional `meshId` (input) and `clientId`
(owner of the result). With either, the result goes into the store, owned by the client or by
whoever owns the input, and its id comes back as `meshId` in the command's JSON. With neither,
the command uses the staging register as before.

| Command | Input | Result |
| --- | --- | --- |
| `mesh_analyze_staged` | `meshId` | none (analysis only) |
| `mesh_classify_staged` | `meshId` | `meshId` in the report |
| `mesh_repair_staged` | `meshId` | `meshId` in the report |
| `mesh_repair_from_path`, `mesh_repair_parts_from_path` | a file path | `meshId` in the report, with `clientId` |
| `mesh_load_from_path` | a file path | the id itself, with `clientId` |

**Hollowing** runs on the store only. No caller is left on the register, so its commands
require their ids. Every result belongs to the owner of the input, or of the session.

| Command | Input | Result |
| --- | --- | --- |
| `mesh_hollow_staged(optionsJson, meshId)` | `meshId` | `meshId`, and `cavityId` when the mode leaves an interior surface |
| `mesh_hollow_session_open(meshId)` | `meshId` | the session's id |
| `mesh_hollow_session_preview(sessionId, optionsJson)` | `sessionId` | `meshId`, `cavityId`, `infillId`, and four buffers (see below) |
| `mesh_hollow_session_apply(sessionId, optionsJson)` | `sessionId` | `meshId` and `cavityId`, as `mesh_hollow_staged` |
| `mesh_hollow_session_select_removed_voxels(sessionId, requestJson)` | `sessionId` | the selected voxel indices (`u32`), directly |

The preview's buffers are `removedVoxelCentersId` and `blockedVoxelCentersId` (`f32`, three
per voxel) and `removedVoxelIndicesId` and `blockedVoxelIndicesId` (`u32`). `cavityId` and
`infillId` appear only when the mode produces them.

**TypeScript** (`src/utils/nativeMeshStore.ts`) is the only frontend module that calls the
primitives:

- `withNativeMesh(core, geometry, pass)` stores a geometry for the length of `pass` and drops it
  afterwards, whether the pass succeeds or not.
- `takeResultPositions(core, commandResult, command)` reads a command's result and drops it.
- `openNativeMeshClient(core)` returns this page load's client id, opening it on first use.
- `putNativeMesh`, `readNativeMesh`, `readNativeBuffer`, `dropNativeMeshes`,
  `nativeMeshStoreStats` for the cases the two helpers above do not cover.
- `NativeMeshStoreError` with `code` `expired`, `unknown` or `wrong_kind`, and
  `asNativeMeshStoreError` to recognise one in a rejected command.

`src/utils/meshHollowing.ts` holds the hollow session on the frontend:

- `openHollowSession(geometry, sourceKey)` returns the open session for that key, or opens a
  new one and drops the previous.
- `previewHollowSession`, `applyHollowSession` and `selectRemovedVoxelsInPolygon` take its id.
- Every output id a command returns is read once and dropped, including the ones the caller
  does not use. When the store has lost the session, it is forgotten, so the next
  `openHollowSession` opens a new one; the error still reaches the caller.

## Sessions

A session is an entry that keeps an operation's expensive state between calls. Hollowing
opens one per source geometry: the session parses the mesh once and keeps the voxel grid it
builds, and the grid is rebuilt only when the resolution or the rotation changes. Changing the
shell, the infill or the blockers reuses it.

- **A session keeps its own copy of the source.** Once it is open, the mesh it was opened from
  can be dropped; `openHollowSession` drops it straight away. Pinning a stored source, so that
  two families can share one, comes when hole punching moves.
- **A session is dropped like any id.** `openHollowSession` drops the previous session when
  the source changes. Commands already running on the old one hold their own reference and
  finish; a command sent with its id afterwards fails with `unknown`.
- **The budget counts the parsed source, not the grid.** The grid is built on first use and
  its size depends on the resolution, so `HollowSource::byte_len` leaves it out for now.
- **Two sessions never see each other's mesh.** `hollow_sessions_on_two_meshes_never_see_each_other`
  in `mesh_repair.rs` previews two sessions from several threads at once.

## Usage

A pass on a geometry, from `classifyFromGeometry` in `src/utils/meshRepair.ts`:

```ts
return withNativeMesh(core, geometry, async (meshId) => {
  const reportJson = await core.invoke<string>('mesh_classify_staged', { optionsJson, meshId });
  const raw: unknown = JSON.parse(reportJson);
  const positions = await takeResultPositions(core, raw, 'mesh_classify_staged');
  return { report: normalizeMeshHealthReport(raw), positions };
});
```

A command that reads a file has no input id, so it names the client instead:

```ts
const clientId = await openNativeMeshClient(core);
const meshId = await core.invoke<string | null>('mesh_load_from_path', { filePath, clientId });
```

On the Rust side, a command reads its input with `staged_input` and delivers its result with
`result_target` and `deliver_result` (all in `mesh_repair.rs`); those three are what keep the
register and the store behind one code path while families move.

## Constraints

- **Drop what you put.** Use `withNativeMesh` for inputs and `takeResultPositions` (or
  `readNativeMesh` with `release`) for results. A command that returns several ids needs each
  one read or dropped, sessions included. A forgotten id is held until the budget releases it
  or the page reloads.
- **Entries do not change.** An operation reads its input and stores a new result; it never
  writes into the entry it was given.
- **No retry on `expired`.** It means an id was held longer than the budget allowed. The error is
  logged and reaches the caller; re-uploading silently would hide that.
- **Keep the store free of Tauri types.** It is driven directly by `cargo test`, and it moves to
  a crate once the mesh operations leave `src-tauri`.
- **Results indexed against geometry still travel with the geometry.** A stored mesh is the
  same bytes the frontend put, so it is safe to index against, but a command that returns
  per-element values for a mesh the frontend renders should keep taking that mesh in the
  request until its family moves; see the rule in `tauri-ipc-bridge.md`.
- **The budget is provisional.** `DEFAULT_BUDGET_BYTES` is 2 GiB until `mesh_store_stats` has
  measured the peak on a dense multi-plate scene.

## Related pages

- [Tauri IPC and Native Bridge](tauri-ipc-bridge.md): the IPC seam and the staging rules
- [Mesh Wire Formats](mesh-wire-formats.md): what the loaders return
- [Mesh Repair Passes](mesh-repair-passes.md): what the repair commands run
- [ADR-0048](../adr/0048-native-mesh-store.md): the decision and the migration order
