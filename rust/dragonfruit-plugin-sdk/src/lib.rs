//! # DragonFruit plugin SDK
//!
//! Builds the process side of a sideloaded DragonFruit plugin: the frame codec,
//! the handshake, the capability declarations the host checks, and the accessors
//! for the shared byte ring that bulk layer data crosses.
//!
//! Licensed **MIT OR Apache-2.0** on purpose. The host is AGPL-3.0, and a vendor
//! links this crate — not DragonFruit — so their binary stays their own. Nothing
//! here contains engine code, scene types or the host's encoder traits; see
//! `docs/dev/plugins-sideloaded.md` and ADR-0047 for why the boundary is a
//! process and not a `dlopen`.
//!
//! ```no_run
//! use dragonfruit_plugin_sdk::{serve, Capability, FormatDecl, NoCapabilities, PluginIdentity};
//!
//! struct MyPlugin;
//!
//! impl PluginIdentity for MyPlugin {
//!     fn plugin_id(&self) -> &str { "example.plugin" }
//!     fn version(&self) -> &str { "1.0.0" }
//!     fn capabilities(&self) -> Vec<Capability> { vec![Capability::SlicerEncoder] }
//!     fn formats(&self) -> Vec<FormatDecl> {
//!         vec![FormatDecl { ext: ".exf".to_string() }]
//!     }
//! }
//!
//! fn main() -> std::io::Result<()> {
//!     serve(std::io::stdin().lock(), std::io::stdout().lock(), &MyPlugin, &NoCapabilities, None)
//! }
//! ```

pub mod frame;
pub mod harness;
pub mod protocol;
pub mod ring;

/// Wire protocol this crate speaks. The host refuses a package built against a
/// version it does not know, so this and the host's copy must move together.
pub const PROTOCOL_VERSION: u32 = 1;

pub use frame::{read_frame, write_frame, Frame, FrameError, FrameKind, MAX_FRAME_BYTES};
pub use harness::{
    serve, EncodeStart, Encoder, Importer, LayerRef, NoCapabilities, PluginCapabilities,
    PluginIdentity,
};
pub use protocol::{Capability, FormatDecl, HostMessage, PluginMessage, Transport};
pub use ring::{
    claim_slot, init_ring, publish_slot, read_layout, release_slot, slot_state, slot_view, RingError,
    RingLayout, SlotKind, SlotState, SlotView, DEFAULT_SLOT_BYTES, DEFAULT_SLOT_COUNT,
};
