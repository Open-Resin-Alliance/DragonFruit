//! Keeps CEF from killing the app over glibc's 32-bit `mallinfo()`.
//!
//! libcef.so is built against a sysroot older than glibc 2.33, so Chromium's
//! `MallocDumpProvider` reads heap statistics through the legacy `mallinfo()`,
//! whose fields are `int`. glibc fills them by truncating the real `size_t`
//! figures, and Chromium then runs `checked_cast<size_t>(arena + hblkhd)` and
//! `checked_cast<size_t>(uordblks)` on them. Whenever a figure modulo 4 GiB
//! lands in [2 GiB, 4 GiB) the cast traps (`ud2`, SIGILL) and the browser
//! process dies — the backend shares that process and its heap, so loading and
//! slicing big models gets us there. It fires on Chromium's memory dumps,
//! not on anything the user does, which is why the crash looks random.
//!
//! The executable exports its own `mallinfo`, and the dynamic linker binds
//! libcef's `mallinfo@GLIBC_2.2.5` reference to it ahead of glibc's (see the
//! `--export-dynamic-symbol` flag in build.rs). It reports the 64-bit figures
//! saturated so that every value, and `arena + hblkhd`, still fits in an
//! `int`. Above 2 GiB the numbers are wrong either way; this way they are
//! merely clamped instead of fatal.

use std::os::raw::c_int;

#[repr(C)]
pub struct Mallinfo {
    arena: c_int,
    ordblks: c_int,
    smblks: c_int,
    hblks: c_int,
    hblkhd: c_int,
    usmblks: c_int,
    fsmblks: c_int,
    uordblks: c_int,
    fordblks: c_int,
    keepcost: c_int,
}

#[repr(C)]
struct Mallinfo2 {
    arena: usize,
    ordblks: usize,
    smblks: usize,
    hblks: usize,
    hblkhd: usize,
    usmblks: usize,
    fsmblks: usize,
    uordblks: usize,
    fordblks: usize,
    keepcost: usize,
}

extern "C" {
    fn mallinfo2() -> Mallinfo2;
}

fn clamp(value: usize, ceiling: usize) -> c_int {
    value.min(ceiling) as c_int
}

/// The process-wide `mallinfo` every library resolves to.
#[no_mangle]
pub extern "C" fn mallinfo() -> Mallinfo {
    // SAFETY: mallinfo2 takes no arguments and only reads allocator state;
    // glibc has shipped it since 2.33, below every runtime we run on.
    saturate(unsafe { mallinfo2() })
}

fn saturate(info: Mallinfo2) -> Mallinfo {
    let max = c_int::MAX as usize;
    let arena = clamp(info.arena, max);
    Mallinfo {
        arena,
        ordblks: clamp(info.ordblks, max),
        smblks: clamp(info.smblks, max),
        hblks: clamp(info.hblks, max),
        // Chromium adds these two as ints before casting.
        hblkhd: clamp(info.hblkhd, max - arena as usize),
        usmblks: clamp(info.usmblks, max),
        fsmblks: clamp(info.fsmblks, max),
        uordblks: clamp(info.uordblks, max),
        fordblks: clamp(info.fordblks, max),
        keepcost: clamp(info.keepcost, max),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: usize = 1 << 30;

    fn heap(arena: usize, hblkhd: usize, uordblks: usize) -> Mallinfo2 {
        Mallinfo2 {
            arena,
            ordblks: 0,
            smblks: 0,
            hblks: 0,
            hblkhd,
            usmblks: 0,
            fsmblks: 0,
            uordblks,
            fordblks: 0,
            keepcost: 0,
        }
    }

    #[test]
    fn small_heaps_pass_through_unchanged() {
        let info = saturate(heap(270_336, GIB, 138_544));
        assert_eq!(
            (info.arena, info.hblkhd, info.uordblks),
            (270_336, GIB as c_int, 138_544)
        );
    }

    #[test]
    fn what_chromium_casts_stays_non_negative_past_2_gib() {
        // 3 GiB is what glibc's own mallinfo turns into -1 GiB.
        for (arena, hblkhd, uordblks) in [
            (0, 3 * GIB, 3 * GIB),
            (3 * GIB, 5 * GIB, 7 * GIB),
            (GIB, 2 * GIB, 0),
        ] {
            let info = saturate(heap(arena, hblkhd, uordblks));
            let sum = info.arena.checked_add(info.hblkhd);
            assert!(
                sum.is_some_and(|sum| sum >= 0),
                "arena + hblkhd overflows for {arena}, {hblkhd}"
            );
            assert!(info.uordblks >= 0);
        }
    }

    #[test]
    fn the_exported_symbol_reads_the_live_heap() {
        let big: Vec<u8> = std::hint::black_box(Vec::with_capacity(3 * GIB));
        // SAFETY: as in mallinfo().
        assert!(unsafe { mallinfo2() }.hblkhd >= 3 * GIB);
        let info = mallinfo();
        assert!(info
            .arena
            .checked_add(info.hblkhd)
            .is_some_and(|sum| sum >= 0));
        drop(big);
    }
}
