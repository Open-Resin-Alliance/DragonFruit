---
issue: native-mesh-store
date: 2026-11-24
kind: decision
status: proposed
---

# ADR-0048: Native meshes are held under ids the caller passes back

## Context

Native mesh operations take their input from one process-wide slot and leave their
result in it. The frontend stages a soup with `stage_mesh_binary_set`, and whichever
command runs next reads it: 14 commands read the slot (`read_staging_bytes`, which copies
it), 13 write their result back over it (`replace_staging_with_mesh`), and the frontend
reads results with `mesh_repair_read_positions`. Slicing consumes it with `take()`. The
staging slot also has a file form (`STAGED_MESH_FILE_PATH`), filled by the same appender
exports write output files with. On top of that, the hollow, hole punch and organic cut
sessions copy the slot into 18 more `OnceLock` slots of their own in `mesh_repair.rs`.

So the slot is one mesh for the whole process, and a request is only correct while no
other request runs. Two requests in flight on two meshes read each other's mesh, and
nothing errors: the VOXL import built four models at once, two classify passes
interleaved, and the viewport showed one model's geometry in another's place. The fix
was `withStagedMesh`, a queue in `meshRepair.ts` that serialised the repair passes. It
did not cover hollowing, hole punching, islands or slicing, which stage on the same slot.

Concurrent requests and long-lived sessions are where the scripting roadmap goes (#929,
H4): a caller that keeps several meshes and chains operations on them cannot work against
one slot. Keyed native state already exists in-tree: `CANCELS` (cancel flags by progress
token), the AO bake's mesh registry (meshes by token), `undo_spill.rs` (files by key) and
the sideloaded plugin runtime (slots by id).

## Decision

1. **A store of entries under opaque ids.** `mesh_store.rs` holds entries under ids Rust
   mints; a caller puts a mesh, gets an id, and names that id in each command. The module
   has no Tauri types; its commands live in `mesh_store_ipc.rs`. It moves to a crate when
   the mesh operations leave `src-tauri`.
2. **Results are entries.** A command run on the store returns its result's id (as
   `meshId` in its JSON), and that id can be the next command's input. An operation never
   changes its input entry.
3. **Entries are a closed enum.** A reader asks for the variant it needs, and asking for
   the wrong one is a coded error (`wrong_kind`). The triangle soup came first, and
   hollowing added auxiliary buffers and sessions; indexed meshes and files are added by
   the family that first stores one.
4. **Lifetime is explicit, with a budget as the net.** Callers drop ids (a list at a time);
   a byte budget releases least-recently-used entries when a caller forgets. An operation
   holds its own reference while it runs, so a release only drops the store's. A released
   id fails with `expired`, a dropped or never-minted one with `unknown`, never with another
   mesh. The budget is provisional (2 GiB) until `mesh_store_stats` has measured the peak
   on a dense multi-plate scene.
5. **Entries have owners.** Each page load of the frontend is a client with its own id;
   opening a client drops what earlier page loads left. A later scripting session is
   another owner, and closing it drops its entries.
6. **Errors carry codes.** Store errors start with `mesh-store/<code>:` so the frontend
   tells them apart without matching prose. An expired id is not re-uploaded silently: it
   is logged and reaches the caller, and a retry is added only if measurement shows
   legitimate expiries.
7. **Migration goes family by family.** Each command gains optional `meshId`/`clientId`
   arguments; without them it keeps using the staging slot, so families not yet migrated
   are untouched. The first family is classify, analyze and repair (staged, from a path,
   by parts, and the plain load); `withStagedMesh` goes with it. Then, one change each:
   hollow, hole punch, organic cut, islands, the AO registry and slicing. Sessions become
   entries, replacing the `*_capture_staged_source` copies; a family that keeps nothing
   between runs but its source holds that source as a stored soup instead. The
   output-file writer becomes its own module with an `open → handle` of its own, and
   slicing cancel moves onto the per-token `CANCELS` pattern.

## Consequences

- Passes of a migrated family can run at the same time on different meshes, and nothing
  on the frontend queues them. The staging slot keeps its hazard for the families still
  on it, which a characterisation test in `mesh_repair.rs` records until it is gone.
- A stored input is read without the copy `read_staging_bytes` makes, and a result is
  collected with `release`, which moves its bytes out without a copy.
- Callers must drop what they put. `withNativeMesh` (`nativeMeshStore.ts`) scopes an
  input to one pass, and results are released as they are read.
- The staging slot, its file form and the 18 session slots stay until their families
  move; they are deleted as each one does. Hollowing's ten went first, then hole punching's
  two.

## Alternatives considered

- **Keep queuing on the frontend.** `withStagedMesh` and `runExclusiveNativeWrite` work
  only for callers that go through them, and they make every native pass wait for every
  other one. They cannot serve more than one caller.
- **Send the mesh with every request.** Right for results indexed against geometry (the
  AO bake does it), but a chain of operations would send the same mesh across IPC again
  for each step, and sessions would have nowhere to keep it.
- **Ids chosen by the frontend.** Two callers can collide, and the store could not tell a
  stale id from a reused one.
