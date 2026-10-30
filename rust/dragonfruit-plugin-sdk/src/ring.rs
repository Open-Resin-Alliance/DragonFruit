//! The shared byte ring bulk layer data crosses.
//!
//! Layout (little-endian, offsets from the start of the mapping):
//!
//! ```text
//! header (4096 bytes)
//!   0  u32 magic          0x44465247 ("DFRG")
//!   4  u32 version        1
//!   8  u32 slotCount
//!   12 u32 slotBytes
//!   16 u32 layerCapacity
//!   20 u32 reserved
//!   24 u64 seq            bumped by the publisher on every publish
//! slot headers (64 bytes each)
//!   0  u32 state          0 free | 1 filled | 2 consuming
//!   4  u32 kind           1 png | 2 rle | 3 raw mask
//!   8  u32 layerIndex
//!   12 u32 bytes
//!   16 u32 width
//!   20 u32 height
//!   24 u64 seq
//! payloads (slotBytes each, page aligned)
//! ```
//!
//! The ring carries **bytes only**: no pointers, no Rust or C structs, no shared
//! allocator. Ownership moves publisher→consumer by publishing a slot and
//! consumer→publisher by releasing it. `state` is the only field both sides
//! write, and each side only writes the transition it owns.
//!
//! # Safety contract
//!
//! The mapping must start at an 8-byte aligned address (a page-aligned `mmap`
//! is more than enough) and both processes must use the same [`RingLayout`].
//! `state` and `seq` are accessed atomically; the rest are plain little-endian
//! fields whose lifetime is bounded by the state word.

use std::sync::atomic::{fence, AtomicU32, AtomicU64, Ordering};

pub const RING_MAGIC: u32 = 0x4446_5247;
pub const RING_VERSION: u32 = 1;
pub const HEADER_BYTES: usize = 4096;
pub const SLOT_HEADER_BYTES: usize = 64;
pub const DEFAULT_SLOT_COUNT: u32 = 4;
pub const DEFAULT_SLOT_BYTES: u32 = 64 * 1024 * 1024;

const OFFSET_MAGIC: usize = 0;
const OFFSET_VERSION: usize = 4;
const OFFSET_SLOT_COUNT: usize = 8;
const OFFSET_SLOT_BYTES: usize = 12;
const OFFSET_LAYER_CAPACITY: usize = 16;
const OFFSET_SEQ: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotState {
    Free,
    Filled,
    Consuming,
}

impl SlotState {
    fn to_wire(self) -> u32 {
        match self {
            Self::Free => 0,
            Self::Filled => 1,
            Self::Consuming => 2,
        }
    }

    fn from_wire(value: u32) -> Result<Self, RingError> {
        match value {
            0 => Ok(Self::Free),
            1 => Ok(Self::Filled),
            2 => Ok(Self::Consuming),
            other => Err(RingError::UnknownState(other)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotKind {
    Png,
    Rle,
    RawMask,
}

impl SlotKind {
    fn to_wire(self) -> u32 {
        match self {
            Self::Png => 1,
            Self::Rle => 2,
            Self::RawMask => 3,
        }
    }

    fn from_wire(value: u32) -> Result<Self, RingError> {
        match value {
            1 => Ok(Self::Png),
            2 => Ok(Self::Rle),
            3 => Ok(Self::RawMask),
            other => Err(RingError::UnknownKind(other)),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RingLayout {
    pub slot_count: u32,
    pub slot_bytes: u32,
}

impl RingLayout {
    pub const fn new(slot_count: u32, slot_bytes: u32) -> Self {
        Self {
            slot_count,
            slot_bytes,
        }
    }

    pub const fn payload_offset(self) -> usize {
        align_up(HEADER_BYTES + self.slot_count as usize * SLOT_HEADER_BYTES, 4096)
    }

    pub const fn bytes_needed(self) -> usize {
        self.payload_offset() + self.slot_count as usize * self.slot_bytes as usize
    }

    fn slot_header_offset(self, slot: u32) -> usize {
        HEADER_BYTES + slot as usize * SLOT_HEADER_BYTES
    }

    fn payload_slot_offset(self, slot: u32) -> usize {
        self.payload_offset() + slot as usize * self.slot_bytes as usize
    }

    fn validate(self) -> Result<(), RingError> {
        if self.slot_count == 0 || self.slot_count > 64 {
            return Err(RingError::InvalidLayout("slot count must be 1..=64"));
        }
        if self.slot_bytes < 4096 || self.slot_bytes > 1024 * 1024 * 1024 {
            return Err(RingError::InvalidLayout("slot bytes must be 4 KiB..=1 GiB"));
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum RingError {
    BufferTooSmall,
    InvalidLayout(&'static str),
    NotInitialised,
    WrongVersion(u32),
    SlotOutOfRange(u32),
    SlotNotFree(u32),
    SlotNotReadable(u32),
    UnknownState(u32),
    UnknownKind(u32),
    PayloadTooLarge(usize),
    Misaligned,
}

impl std::fmt::Display for RingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BufferTooSmall => write!(f, "ring mapping is smaller than its layout"),
            Self::InvalidLayout(detail) => write!(f, "invalid ring layout: {detail}"),
            Self::NotInitialised => write!(f, "ring mapping is not initialised"),
            Self::WrongVersion(version) => write!(f, "ring version {version} is not supported"),
            Self::SlotOutOfRange(slot) => write!(f, "slot {slot} is out of range"),
            Self::SlotNotFree(slot) => write!(f, "slot {slot} is not free"),
            Self::SlotNotReadable(slot) => write!(f, "slot {slot} holds nothing to read"),
            Self::UnknownState(state) => write!(f, "unknown slot state {state}"),
            Self::UnknownKind(kind) => write!(f, "unknown slot kind {kind}"),
            Self::PayloadTooLarge(bytes) => write!(f, "payload of {bytes} bytes does not fit a slot"),
            Self::Misaligned => write!(f, "ring mapping is not 8-byte aligned"),
        }
    }
}

impl std::error::Error for RingError {}

/// The accessors below cast the mapping to atomics, which is only sound when
/// the base address is 8-byte aligned. Checked rather than assumed: a caller
/// that hands over a `Vec<u8>` would otherwise get silent undefined behaviour.
fn ensure_aligned(bytes: &[u8]) -> Result<(), RingError> {
    if (bytes.as_ptr() as usize) % 8 != 0 {
        return Err(RingError::Misaligned);
    }
    Ok(())
}

const fn align_up(value: usize, alignment: usize) -> usize {
    let remainder = value % alignment;
    if remainder == 0 {
        value
    } else {
        value + (alignment - remainder)
    }
}

fn atomic_u32(bytes: &[u8], offset: usize) -> &AtomicU32 {
    // SAFETY: every offset this reaches is 4-byte aligned (header fields and slot
    // headers sit on 64-byte boundaries), and the caller guarantees the mapping
    // start is 8-byte aligned.
    unsafe { &*(bytes.as_ptr().add(offset) as *const AtomicU32) }
}

fn atomic_u32_mut(bytes: &mut [u8], offset: usize) -> &mut AtomicU32 {
    // SAFETY: as `atomic_u32`, and `&mut [u8]` guarantees no aliasing slice.
    unsafe { &mut *(bytes.as_mut_ptr().add(offset) as *mut AtomicU32) }
}

fn atomic_u64(bytes: &[u8], offset: usize) -> &AtomicU64 {
    // SAFETY: 24 and the slot's 24 are 8-byte aligned; the mapping start is
    // 8-byte aligned and the header is page-sized.
    unsafe { &*(bytes.as_ptr().add(offset) as *const AtomicU64) }
}

fn atomic_u64_mut(bytes: &mut [u8], offset: usize) -> &mut AtomicU64 {
    // SAFETY: as `atomic_u64`, and `&mut [u8]` guarantees no aliasing slice.
    unsafe { &mut *(bytes.as_mut_ptr().add(offset) as *mut AtomicU64) }
}

fn write_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

/// Writes the header for `layout` into an unmapped-but-zeroed region.
pub fn init_ring(bytes: &mut [u8], layout: RingLayout) -> Result<(), RingError> {
    ensure_aligned(bytes)?;
    layout.validate()?;
    if bytes.len() < layout.bytes_needed() {
        return Err(RingError::BufferTooSmall);
    }
    write_u32(bytes, OFFSET_MAGIC, RING_MAGIC);
    write_u32(bytes, OFFSET_VERSION, RING_VERSION);
    write_u32(bytes, OFFSET_SLOT_COUNT, layout.slot_count);
    write_u32(bytes, OFFSET_SLOT_BYTES, layout.slot_bytes);
    write_u32(bytes, OFFSET_LAYER_CAPACITY, 0);
    write_u32(bytes, 20, 0);
    atomic_u64_mut(bytes, OFFSET_SEQ).store(0, Ordering::Release);
    for slot in 0..layout.slot_count {
        let offset = layout.slot_header_offset(slot);
        atomic_u32_mut(bytes, offset).store(SlotState::Free.to_wire(), Ordering::Release);
        atomic_u64_mut(bytes, offset + 24).store(0, Ordering::Release);
    }
    fence(Ordering::Release);
    Ok(())
}

/// Checks the mapping looks like a ring this build understands.
pub fn validate_ring(bytes: &[u8]) -> Result<(), RingError> {
    ensure_aligned(bytes)?;
    if bytes.len() < HEADER_BYTES {
        return Err(RingError::BufferTooSmall);
    }
    if read_u32(bytes, OFFSET_MAGIC) != RING_MAGIC {
        return Err(RingError::NotInitialised);
    }
    let version = read_u32(bytes, OFFSET_VERSION);
    if version != RING_VERSION {
        return Err(RingError::WrongVersion(version));
    }
    Ok(())
}

pub fn slot_state(bytes: &[u8], layout: &RingLayout, slot: u32) -> Result<SlotState, RingError> {
    if slot >= layout.slot_count {
        return Err(RingError::SlotOutOfRange(slot));
    }
    validate_ring(bytes)?;
    let offset = layout.slot_header_offset(slot);
    SlotState::from_wire(atomic_u32(bytes, offset).load(Ordering::Acquire))
}

/// Fills a free slot and publishes it. The consumer owns it until it releases it.
pub fn publish_slot(
    bytes: &mut [u8],
    layout: &RingLayout,
    slot: u32,
    kind: SlotKind,
    layer_index: u32,
    payload: &[u8],
    width: u32,
    height: u32,
) -> Result<(), RingError> {
    ensure_aligned(bytes)?;
    layout.validate()?;
    if slot >= layout.slot_count {
        return Err(RingError::SlotOutOfRange(slot));
    }
    if bytes.len() < layout.bytes_needed() {
        return Err(RingError::BufferTooSmall);
    }
    if payload.len() > layout.slot_bytes as usize {
        return Err(RingError::PayloadTooLarge(payload.len()));
    }
    validate_ring(bytes)?;

    let header = layout.slot_header_offset(slot);
    if SlotState::from_wire(atomic_u32(bytes, header).load(Ordering::Acquire))? != SlotState::Free {
        return Err(RingError::SlotNotFree(slot));
    }

    let seq = atomic_u64(bytes, OFFSET_SEQ).load(Ordering::Relaxed) + 1;
    atomic_u64_mut(bytes, OFFSET_SEQ).store(seq, Ordering::Relaxed);
    write_u32(bytes, header + 4, kind.to_wire());
    write_u32(bytes, header + 8, layer_index);
    write_u32(bytes, header + 12, payload.len() as u32);
    write_u32(bytes, header + 16, width);
    write_u32(bytes, header + 20, height);
    atomic_u64_mut(bytes, header + 24).store(seq, Ordering::Relaxed);

    let payload_offset = layout.payload_slot_offset(slot);
    bytes[payload_offset..payload_offset + payload.len()].copy_from_slice(payload);

    // The state store is the publish: everything above is visible before it.
    atomic_u32_mut(bytes, header).store(SlotState::Filled.to_wire(), Ordering::Release);
    fence(Ordering::SeqCst);
    Ok(())
}

/// Takes ownership of a filled slot without copying it: `filled` becomes
/// `consuming`. A consumer that wants to hold a slot across work claims it first;
/// one that reads in place can go straight to `slot_view`.
///
/// The transition is a compare-and-swap, so two consumers racing for the same
/// slot cannot both win.
pub fn claim_slot(bytes: &mut [u8], layout: &RingLayout, slot: u32) -> Result<(), RingError> {
    ensure_aligned(bytes)?;
    if slot >= layout.slot_count {
        return Err(RingError::SlotOutOfRange(slot));
    }
    validate_ring(bytes)?;
    let header = layout.slot_header_offset(slot);
    atomic_u32_mut(bytes, header)
        .compare_exchange(
            SlotState::Filled.to_wire(),
            SlotState::Consuming.to_wire(),
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .map_err(|_| RingError::SlotNotReadable(slot))?;
    fence(Ordering::SeqCst);
    Ok(())
}

#[derive(Debug)]
pub struct SlotView<'a> {
    pub kind: SlotKind,
    pub layer_index: u32,
    pub width: u32,
    pub height: u32,
    pub payload: &'a [u8],
}

/// Reads a published slot. `Ok(None)` means the slot is free or already being
/// consumed by someone else.
pub fn slot_view<'a>(
    bytes: &'a [u8],
    layout: &RingLayout,
    slot: u32,
) -> Result<Option<SlotView<'a>>, RingError> {
    ensure_aligned(bytes)?;
    if slot >= layout.slot_count {
        return Err(RingError::SlotOutOfRange(slot));
    }
    if bytes.len() < layout.bytes_needed() {
        return Err(RingError::BufferTooSmall);
    }
    validate_ring(bytes)?;

    let header = layout.slot_header_offset(slot);
    let state = SlotState::from_wire(atomic_u32(bytes, header).load(Ordering::Acquire))?;
    if state == SlotState::Free {
        return Ok(None);
    }
    let bytes_len = read_u32(bytes, header + 12) as usize;
    if bytes_len > layout.slot_bytes as usize {
        return Err(RingError::PayloadTooLarge(bytes_len));
    }
    let payload_offset = layout.payload_slot_offset(slot);
    Ok(Some(SlotView {
        kind: SlotKind::from_wire(read_u32(bytes, header + 4))?,
        layer_index: read_u32(bytes, header + 8),
        width: read_u32(bytes, header + 16),
        height: read_u32(bytes, header + 20),
        payload: &bytes[payload_offset..payload_offset + bytes_len],
    }))
}

/// Gives a consumed slot back to the publisher.
pub fn release_slot(bytes: &mut [u8], layout: &RingLayout, slot: u32) -> Result<(), RingError> {
    ensure_aligned(bytes)?;
    if slot >= layout.slot_count {
        return Err(RingError::SlotOutOfRange(slot));
    }
    validate_ring(bytes)?;
    let header = layout.slot_header_offset(slot);
    let state = SlotState::from_wire(atomic_u32(bytes, header).load(Ordering::Acquire))?;
    if state == SlotState::Free {
        return Err(RingError::SlotNotReadable(slot));
    }
    atomic_u32_mut(bytes, header).store(SlotState::Free.to_wire(), Ordering::Release);
    fence(Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAYOUT: RingLayout = RingLayout::new(2, 4096);

    #[repr(align(4096))]
    struct Aligned([u8; LAYOUT_BYTES]);

    const LAYOUT_BYTES: usize = LAYOUT.bytes_needed();

    fn ring() -> Box<Aligned> {
        let mut buffer = Box::new(Aligned([0u8; LAYOUT_BYTES]));
        init_ring(&mut buffer.0, LAYOUT).expect("init");
        buffer
    }

    #[test]
    fn layout_reserves_a_page_for_the_header_and_payloads_after_the_slot_headers() {
        assert_eq!(LAYOUT.payload_offset(), 8192);
        assert_eq!(LAYOUT.bytes_needed(), 8192 + 2 * 4096);
    }

    #[test]
    fn a_published_slot_round_trips_and_releases() {
        let mut buffer = ring();
        assert_eq!(slot_state(&buffer.0, &LAYOUT, 0).unwrap(), SlotState::Free);
        assert!(slot_view(&buffer.0, &LAYOUT, 0).unwrap().is_none());

        publish_slot(&mut buffer.0, &LAYOUT, 0, SlotKind::Rle, 7, b"runs", 0, 0).expect("publish");
        assert_eq!(slot_state(&buffer.0, &LAYOUT, 0).unwrap(), SlotState::Filled);

        let view = slot_view(&buffer.0, &LAYOUT, 0).unwrap().expect("filled");
        assert_eq!(view.kind, SlotKind::Rle);
        assert_eq!(view.layer_index, 7);
        assert_eq!(view.payload, b"runs");

        release_slot(&mut buffer.0, &LAYOUT, 0).expect("release");
        assert_eq!(slot_state(&buffer.0, &LAYOUT, 0).unwrap(), SlotState::Free);
        assert!(slot_view(&buffer.0, &LAYOUT, 0).unwrap().is_none());
    }

    #[test]
    fn publishing_over_a_filled_slot_is_refused() {
        let mut buffer = ring();
        publish_slot(&mut buffer.0, &LAYOUT, 1, SlotKind::Png, 0, b"png", 4096, 2560).expect("first");
        assert!(matches!(
            publish_slot(&mut buffer.0, &LAYOUT, 1, SlotKind::Png, 1, b"png", 0, 0),
            Err(RingError::SlotNotFree(1))
        ));
    }

    #[test]
    fn a_payload_larger_than_a_slot_is_refused() {
        let mut buffer = ring();
        let payload = vec![0u8; LAYOUT.slot_bytes as usize + 1];
        assert!(matches!(
            publish_slot(&mut buffer.0, &LAYOUT, 0, SlotKind::RawMask, 0, &payload, 0, 0),
            Err(RingError::PayloadTooLarge(_))
        ));
    }

    #[test]
    fn a_slot_can_be_claimed_before_reading() {
        let mut buffer = ring();
        publish_slot(&mut buffer.0, &LAYOUT, 0, SlotKind::Png, 2, b"png", 4096, 2560).expect("publish");

        claim_slot(&mut buffer.0, &LAYOUT, 0).expect("claim");
        assert_eq!(slot_state(&buffer.0, &LAYOUT, 0).unwrap(), SlotState::Consuming);
        let view = slot_view(&buffer.0, &LAYOUT, 0).unwrap().expect("still readable while consuming");
        assert_eq!(view.layer_index, 2);

        release_slot(&mut buffer.0, &LAYOUT, 0).expect("release");
        assert_eq!(slot_state(&buffer.0, &LAYOUT, 0).unwrap(), SlotState::Free);

        assert!(matches!(
            claim_slot(&mut buffer.0, &LAYOUT, 0),
            Err(RingError::SlotNotReadable(0))
        ));
    }

    #[test]
    fn claiming_twice_is_refused() {
        let mut buffer = ring();
        publish_slot(&mut buffer.0, &LAYOUT, 0, SlotKind::Png, 0, b"png", 0, 0).expect("publish");
        claim_slot(&mut buffer.0, &LAYOUT, 0).expect("first claim");
        assert!(matches!(
            claim_slot(&mut buffer.0, &LAYOUT, 0),
            Err(RingError::SlotNotReadable(0))
        ));
    }

    #[test]
    fn an_unaligned_buffer_is_refused() {
        // One byte of padding puts the mapping on an odd address.
        let mut backing = vec![0u8; LAYOUT_BYTES + 1];
        let offset = if (backing.as_ptr() as usize) % 8 == 0 { 1 } else { 0 };
        let bytes = &mut backing[offset..offset + LAYOUT_BYTES];
        assert!(matches!(init_ring(bytes, LAYOUT), Err(RingError::Misaligned)));
    }

    #[test]
    fn releasing_a_free_slot_is_refused() {
        let mut buffer = ring();
        assert!(matches!(
            release_slot(&mut buffer.0, &LAYOUT, 0),
            Err(RingError::SlotNotReadable(0))
        ));
    }

    #[test]
    fn an_uninitialised_mapping_is_refused() {
        let mut buffer = Box::new(Aligned([0u8; LAYOUT_BYTES]));
        assert!(matches!(
            slot_state(&buffer.0, &LAYOUT, 0),
            Err(RingError::NotInitialised)
        ));
        assert!(matches!(
            publish_slot(&mut buffer.0, &LAYOUT, 0, SlotKind::Png, 0, b"x", 0, 0),
            Err(RingError::NotInitialised)
        ));
    }

    #[test]
    fn publishing_bumps_the_sequence() {
        let mut buffer = ring();
        publish_slot(&mut buffer.0, &LAYOUT, 0, SlotKind::Png, 0, b"a", 0, 0).expect("publish");
        let first = atomic_u64(&buffer.0, OFFSET_SEQ).load(Ordering::Relaxed);
        release_slot(&mut buffer.0, &LAYOUT, 0).expect("release");
        publish_slot(&mut buffer.0, &LAYOUT, 0, SlotKind::Png, 1, b"b", 0, 0).expect("publish");
        let second = atomic_u64(&buffer.0, OFFSET_SEQ).load(Ordering::Relaxed);
        assert_eq!(second, first + 1);
    }
}
