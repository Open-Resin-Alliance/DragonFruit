# DragonFruit Changelog

## Unreleased

### Rendering

- **Opt-in demand-mode rendering** (Settings → Mesh → "Reduce idle CPU"). When enabled, the 3D scene only redraws when content changes. Lower idle CPU and battery drain, especially on Linux. Does not change peak frame rate. Platform default stays OFF (opt-in) until a CI lint gate for useFrame invariants lands in a follow-up PR. If you see stale visuals in a specific interaction, disable and report via [issue #120](https://github.com/Open-Resin-Alliance/DragonFruit/issues/120).
- **Dev diagnostic overlay** (Settings → Mesh → "Diagnostics overlay"). Shows renders/sec + invalidation counter — helpful for reporting "scene isn't updating" issues.
- **Environment override**: set `NEXT_PUBLIC_DEMAND_FRAMELOOP=1` (or `0`) to force the frameloop mode for dev/CI runs.

See `1_Documentation/ARCHITECTURE_AND_HANDOFF.md` → "R3F Rendering Contract" for implementation details.
