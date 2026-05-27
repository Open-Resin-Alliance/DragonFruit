# Native Twin Optimization Plan

This is a forward-looking plan for reducing frontend-to-backend geometry transfer during slicing and export.

## Goal

Move toward a native scene twin in Rust so the frontend can send small state diffs instead of repeatedly staging large geometry buffers.

## Key constraints

- Support editing in the frontend must stay smooth.
- Support fidelity must remain exact.
- The work should land after the stable beta path is complete.

## Architecture direction

- Frontend owns live interaction and preview.
- Backend owns canonical slice-ready state.
- Model assets are loaded by identity rather than resent repeatedly.
- Support changes are transmitted as graph diffs with stable IDs and resolved coordinates.

## Success criteria

- Less bulk geometry IPC.
- Better support-heavy export performance.
- Revision parity between frontend and twin before slicing/export.

## Status

This is a roadmap note, not a current runtime contract.

