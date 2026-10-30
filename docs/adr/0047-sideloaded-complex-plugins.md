---
issue: sideloaded-complex-plugins
date: 2026-10-30
kind: decision
---

# ADR-0047: Sideloaded complex plugins — a separate plugin process, not dlopen

## Status

Proposed. Needs two external sign-offs, neither an engineering call:

1. counsel on the shared byte ring (the pipe-only transport is the fallback and
   is already specified), and on the AGPL argument in Decision 2;
2. ORA's decision on Windows code signing for partner executables.

ADR-0031 stays valid: in-tree format plugins remain git submodules compiled in
with generated registration. This ADR adds an opt-in tier beside it.

## Context

DragonFruit's plugin framework has been deliberately zero-trust:

- **Simple plugins** are data-only manifests installed from GitHub at runtime.
  `docs/dev/plugins-framework.md` states the rule as *runtime-installed
  plugins are data; executable plugin code is build-time only*, and lists
  "External binaries" under **Not allowed**.
- **Complex plugins** are source submodules under `plugins/<vendor>/`. The
  registry generator `#[path]`-includes their Rust into the engine
  (`rust/dragonfruit-slicing-engine/src/encoders/generated_plugin_encoders.rs`)
  and into the shell, then SHA-256 pins the allowlist at startup.

ORA's first commercial partner, AlphaBeta, needs a closed-source printer
integration — an output encoder plus network and import capability — and will
not open the source. DragonFruit is AGPL-3.0 and its licensing terms are not
changing, so the partner's code cannot be compiled into the shipped binary, and
the in-tree tier is unusable for them.

The first instinct was an in-process `dlopen` of a vendor `cdylib` behind a C
ABI, which would preserve the exact encode path. That is the one option the
AGPL rules out, and the SDK question follows from it: what can we publish that
lets a vendor build against us *without* becoming a derivative work?

## Decision

**1. A third tier: sideloaded complex plugins.** A `.dfplugin` package imported
at runtime through the Plugin Loader, behind a **default-off** advanced
setting. The package carries a plaintext signed manifest plus an AEAD-sealed
payload; the unsealing passphrase is typed once at import and stored locally.

**2. The plugin is a separate program, and bulk data crosses a shared ring, not
the pipe.** The payload is an executable the vendor builds, spawned as a child
process for a slice job (and kept warm for network operations). Control
(job JSON, progress, cancel, errors, capability handshake) travels as
length-prefixed frames over stdio; layer payloads travel through a
file-backed ring of fixed-size **byte** slots mapped by both processes, so the
rasterizer can write straight into a slot the encoder reads in place.

Why not `dlopen`, and why the ring is not "shared memory" in the FSF's sense:

> If the main program uses fork and exec to invoke plug-ins, and they establish
> intimate communication by sharing complex data structures, or shipping
> complex data structures back and forth, that can make them one single
> combined program. A main program that uses simple fork and exec to invoke
> plug-ins and does not establish intimate communication between them results
> in the plug-ins being a separate program.
>
> If the main program dynamically links plug-ins, and they make function calls
> to each other and share data structures, we believe they form a single
> combined program […] Using shared memory to communicate with complex data
> structures is pretty much equivalent to dynamic linking.

| Approach | FSF reading | Verdict |
| --- | --- | --- |
| `dlopen` + C vtable, borrowed buffers | combined work | unusable without a licence exception |
| child process + shared struct graph / shared objects | "equivalent to dynamic linking" | unusable |
| child process + wire protocol, bulk bytes in a documented ring | separate program, with one open question | **chosen** |
| child process + wire protocol, bulk bytes over the pipe | separate program, no open question | **supported fallback** |

The ring carries opaque bytes: no pointers, no Rust or C structs, no shared
allocator, one owner per slot at a time, layout documented in
`docs/dev/plugins-sideloaded.md`. The FSF sentence targets *complex data
structures*; a byte ring with a published layout is the closest we can get to
"smalltalk" while still feeding 59 MB masks. It is nevertheless the clause a
challenger would cite, so counsel signs off on it, and the handshake carries
`transport: "shm" | "pipe"`: a pipe-only mode is a configuration switch, not a
rewrite. Nothing about the package format or the vendor's code changes.

This matches how AGPL projects with real plugin ecosystems already work:
Grafana (AGPL-3.0) runs backend plugins as subprocesses over gRPC and publishes
an Apache-2.0 Go SDK; the SDK carries no Grafana code, so a plugin author never
touches AGPL terms. That is the shape we copy.

**3. `dragonfruit-plugin-sdk`: a permissive crate, protocol only.** Yes — we
write one. It contains the wire protocol types, framing, the child-side harness
loop and a trait per capability, licensed **MIT OR Apache-2.0** and versioned in
lockstep with the protocol. It contains no engine code, no `FormatEncoder`, no
scene types — only the byte-level contract and helpers to read/write it. The
vendor depends on that crate and never on DragonFruit itself, which is what
keeps their binary out of AGPL scope.

**4. Capabilities: encoder, network, file-type import.** The manifest declares
them, the import sheet shows them before the plugin can be enabled, and the
handshake refuses a capability the manifest did not declare. Nothing is
implied.

**5. Fast paths without a shared address space.** The encoder protocol is built
to keep bulk data out of JSON and off the disk:

- JSON frames carry control and metadata only (job, progress, errors).
- Layer payloads travel as length-prefixed binary frames on the same pipe
  (PNG bytes or RLE runs), so there is no base64, no temp file, no per-layer
  round trip.
- The plugin owns its own thread pool inside its process, so per-layer
  parallel encode still happens; only the engine's rayon pool no longer hosts
  it.
- The plugin writes the finished container straight to the destination path.

What is genuinely lost versus a compiled-in encoder: one pipe hop per layer and
the engine's shared thread pool. Not the algorithms. A vendor's encoder runs at
native Rust speed inside its own process.

**6. Encryption is distribution control, not licensing.** A leaked `.dfplugin`
must be inert without the passphrase. It has no bearing on the AGPL question
— the app decrypts and executes the code, so the vendor's freedom to run it
comes from the process boundary, not from the seal.

## Consequences

- The framework's headline invariant changes. "Runtime-installed plugins are
  data" becomes "runtime-installed plugins are data *unless* the user turns on
  sideloaded complex plugins and imports a signed package". Zero-trust stays
  the default, not an absolute.
- Crash isolation comes free: a panic or abort in the plugin fails the job, not
  the app. That is a genuine improvement over the `dlopen` design this ADR
  replaces.
- macOS is simpler too: spawning an executable we decrypted into app data needs
  no `com.apple.security.cs.disable-library-validation`, so hardened runtime
  and library validation stay strict.
- The protocol is now a public contract with a compatibility promise. Major
  bump = breaking, minor = additive; the host refuses a package whose
  `protoVersion` it does not know rather than guessing.
- The encoder lookup in `rust/dragonfruit-slicing-engine/src/encoders/registry.rs`
  gains a runtime-registered arm whose encode path proxies to the child
  process. Compiled-in encoders keep precedence on an extension collision.
- Sideloaded plugins cannot use the generated-registry integrity check
  (allowlist SHA-256); their integrity is the package signature plus the stored
  publisher fingerprint.
- Windows builds are unsigned today, so a partner executable will attract
  SmartScreen and some AV heuristics on first run. Provenance comes from the
  package signature, not the OS.
- Flatpak needs no new permission: the plugin lives under the app's writable
  data dir, which the sandbox already sees.
- If ORA ever wants the in-process variant, the missing piece is an explicit
  plugin linking exception in the licence — a copyright-holder decision, not an
  engineering one. The package format keeps `entry.kind` so that variant can be
  added without a format break.

## References

- Plugin framework rules: `docs/dev/plugins-framework.md`
- Compile-in path this sits beside: `docs/adr/0031-plugin-format-architecture.md`
- Encoder traits the protocol mirrors: `rust/dragonfruit-slicing-engine/src/encoders/mod.rs`
- Spec: `docs/dev/plugins-sideloaded.md`
- FSF plug-in FAQ (`#GPLPlugins`): <https://www.gnu.org/licenses/gpl-faq.en.html#GPLPlugins>
- Grafana backend plugins (AGPL app, subprocess plugins, Apache-2.0 SDK):
  <https://grafana.com/developers/plugin-tools/key-concepts/backend-plugins>
