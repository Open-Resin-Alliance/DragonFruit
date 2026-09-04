# Registration Seams

Several subsystems expose a "register something, then the host dispatches to it"
pattern. The shape is consistent across all of them:

- A `registerX(...)` function that adds a claim/handler to a module-level registry
  and returns an **unregister closure**.
- The host picks what to invoke at dispatch time, usually by a predicate and/or
  priority.
- Consumers never import each other — they just register against the seam.

This page documents the non-history seams. Undo/redo registration is covered in
`dev/history-and-undo-redo.md`; plugin registration is covered by the plugin docs.

## Delete registry

`src/features/delete/deleteRegistry.ts` is a priority-ordered claim registry for
"what does Delete do right now". Each claim provides a predicate and an action.

```ts
export type DeleteHandler = () => void;

interface DeleteRegistryEntry {
  getCanDelete: () => boolean;
  performDelete: DeleteHandler;
  priority: number;
}

export function registerDeleteHandler(
  getCanDelete: () => boolean,
  performDelete: DeleteHandler,
  priority = 0,
): () => void;

export function getActiveDeleteHandler(): DeleteHandler | null;
export function triggerDelete(): boolean;   // runs the highest-priority enabled claim
```

`useDeleteHotkey` (`src/features/delete/useDeleteHotkey.ts`) bridges the
configurable `GLOBAL.DELETE` binding (default Backspace) and the fixed `Delete`
key to `triggerDelete()`.

Every claimant currently registered, highest first — check this ladder before
choosing a number, because the middle of the range is occupied:

| Priority | Claimant | Registered in |
| -------: | -------- | ------------- |
| 200 | Cut tool seam edit — Delete edits the seam instead of deleting the model (`ORGANIC_CUT_DELETE_PRIORITY`) | `src/hotkeys/useOrganicCutHotkeys.ts` |
| 100 | Support interaction manager | `src/features/supports/useSupportInteractionManager.ts` |
| 50 | Hole punching | `src/features/hole-punching/useHolePunchManager.ts` |
| 30 | Delete selected models in prepare mode | `src/app/page.tsx` |
| 20 | "Select all models" deletion | `src/app/page.tsx` |
| 10 | Delete the active model | `src/features/scene/useSceneCollectionManager.ts` |
| 10 | Dispose a blob URL | `src/features/scene/useSceneManager.ts` |

**Ties fall back to registration order.** Dispatch keeps a winner only when
`entry.priority > winner.priority` — strictly greater — and the registry is an
insertion-ordered `Set`, so on an equal priority the *first* registration wins.
The two claimants at `10` above are both gated on prepare mode and differ only
in their predicates; do not add a third at that number expecting a defined
outcome. Pick a distinct priority instead.

Delete is deliberately **not** history-tied: every Cut edit is pushed to the app
history, so the normal global undo/redo inverts it.

## Mesh geometry store

`src/supports/autoBracing/meshGeometryStore.ts` is a module-level `Map` of
modelId → `THREE` geometry/transform used by auto-brace clearance. The scene
manager registers/unregisters a model's geometry as it is loaded/unloaded:

```ts
registerMeshForAutoBrace(modelId, geometry, transform);
unregisterMeshForAutoBrace(modelId);
```

Same seam shape: registration is keyed, unregistration is a `Map.delete`, and
consumers read the store by id without importing the registering module.

## Writing a new seam

Follow the existing shape so it reads like the rest of the codebase:

- Keep the registry module-level and dependency-free (a `Set`/`Map` of entries).
- `registerX` takes the claim plus an optional priority and returns an unregister
  closure that removes exactly its own entry.
- Dispatch selects at call time (highest priority whose predicate is true, or a
  per-key lookup) — never at registration time.
- Prefer returning a plain `() => void` unregister (not a fancy token) so callers
  can hold it in a `useEffect` cleanup or a returned disposer.

## Related pages

- `dev/history-and-undo-redo.md`
- `dev/plugins-framework.md`
