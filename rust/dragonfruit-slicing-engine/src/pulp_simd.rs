//! Runtime SIMD entry points and exact unsigned arithmetic shared by blur paths.

use std::mem::MaybeUninit;
use std::sync::OnceLock;

use pulp::{Simd, WithSimd};

#[derive(Clone, Copy, Debug)]
pub(crate) enum Backend {
    Scalar,
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    V2(pulp::x86::V2),
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    V3(pulp::x86::V3),
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    V4(pulp::x86::V4),
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    Native(pulp::Arch),
}

impl Backend {
    #[inline]
    pub(crate) fn detected() -> Self {
        static BACKEND: OnceLock<Backend> = OnceLock::new();
        *BACKEND.get_or_init(|| {
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            {
                if let Some(simd) = pulp::x86::V4::try_new() {
                    return Self::V4(simd);
                }
                if let Some(simd) = pulp::x86::V3::try_new() {
                    return Self::V3(simd);
                }
                // Pulp's stock x86 Arch skips V2; retain native SSE on v2 CPUs.
                if let Some(simd) = pulp::x86::V2::try_new() {
                    return Self::V2(simd);
                }
                Self::Scalar
            }
            #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
            {
                match pulp::Arch::new() {
                    pulp::Arch::Scalar => Self::Scalar,
                    arch => Self::Native(arch),
                }
            }
        })
    }

    /// Enter this gate on the thread that executes the operation, including Rayon workers.
    #[inline(always)]
    pub(crate) fn dispatch<Op: WithSimd>(self, op: Op) -> Op::Output {
        match self {
            Self::Scalar => Simd::vectorize(pulp::Scalar, op),
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            Self::V2(simd) => Simd::vectorize(simd, op),
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            Self::V3(simd) => Simd::vectorize(simd, op),
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            Self::V4(simd) => Simd::vectorize(simd, op),
            #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
            Self::Native(arch) => arch.dispatch(op),
        }
    }

    #[cfg(test)]
    pub(crate) fn supported_for_tests() -> impl Iterator<Item = Self> {
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        let backends = [
            Some(Self::Scalar),
            pulp::x86::V2::try_new().map(Self::V2),
            pulp::x86::V3::try_new().map(Self::V3),
            pulp::x86::V4::try_new().map(Self::V4),
        ];
        #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
        let backends = [
            Some(Self::Scalar),
            match Self::detected() {
                Self::Scalar => None,
                native => Some(native),
            },
        ];
        backends.into_iter().flatten()
    }
}

#[inline(always)]
pub(crate) fn u32_lanes<S: Simd>() -> usize {
    S::U32_LANES
}

#[inline(always)]
pub(crate) fn u64_lanes<S: Simd>() -> usize {
    S::U64_LANES
}

#[inline(always)]
pub(crate) fn load_u8_as_u32<S: Simd>(_simd: S, src: &[u8]) -> S::u32s {
    let src = &src[..u32_lanes::<S>()];
    let mut out = MaybeUninit::<S::u32s>::uninit();
    // Every u32 lane is written; Simd vectors are Pod, with no padding. This
    // exposes widening to the compiler without zeroing/copying a scratch array.
    unsafe {
        let lanes = out.as_mut_ptr().cast::<u32>();
        for (i, &value) in src.iter().enumerate() {
            lanes.add(i).write_unaligned(u32::from(value));
        }
        out.assume_init()
    }
}

#[inline(always)]
pub(crate) fn load_u16_as_u32<S: Simd>(_simd: S, src: &[u16]) -> S::u32s {
    let src = &src[..u32_lanes::<S>()];
    let mut out = MaybeUninit::<S::u32s>::uninit();
    // As above, initialize exactly one complete vector without a scratch copy.
    unsafe {
        let lanes = out.as_mut_ptr().cast::<u32>();
        for (i, &value) in src.iter().enumerate() {
            lanes.add(i).write_unaligned(u32::from(value));
        }
        out.assume_init()
    }
}

#[inline(always)]
pub(crate) fn sat_add_u32<S: Simd>(simd: S, a: S::u32s, b: S::u32s) -> S::u32s {
    let sum = simd.add_u32s(a, b);
    simd.select_u32s(simd.less_than_u32s(sum, a), simd.splat_u32s(u32::MAX), sum)
}

#[inline(always)]
pub(crate) fn sat_mul_u32<S: Simd>(simd: S, a: S::u32s, b: S::u32s) -> S::u32s {
    let (low, high) = simd.widening_mul_u32s(a, b);
    simd.select_u32s(
        simd.equal_u32s(high, simd.splat_u32s(0)),
        low,
        simd.splat_u32s(u32::MAX),
    )
}

#[inline(always)]
pub(crate) fn sat_add_u64<S: Simd>(simd: S, a: S::u64s, b: S::u64s) -> S::u64s {
    let sum = simd.add_u64s(a, b);
    simd.select_u64s(simd.less_than_u64s(sum, a), simd.splat_u64s(u64::MAX), sum)
}

/// Exact division by a denominator reused across pixels; no floating-point rounding.
#[derive(Clone, Copy)]
pub(crate) struct U32Divider {
    pub(crate) denominator: u32,
    pub(crate) multiplier: u32,
}

impl U32Divider {
    #[inline]
    pub(crate) fn new(denominator: u32) -> Self {
        debug_assert_ne!(denominator, 0);
        let multiplier = if denominator == 1 { 0 } else { ((1u64 << 32) / u64::from(denominator)) as u32 };
        Self { denominator, multiplier }
    }

    #[inline(always)]
    pub(crate) fn divide(self, numerator: u32) -> u32 {
        if self.denominator == 1 { return numerator; }
        let quotient = ((u64::from(numerator) * u64::from(self.multiplier)) >> 32) as u32;
        quotient + u32::from(numerator - quotient * self.denominator >= self.denominator)
    }

    #[inline(always)]
    pub(crate) fn divide_simd<S: Simd>(self, simd: S, numerator: S::u32s) -> S::u32s {
        if self.denominator == 1 { return numerator; }
        divide_u32s(simd, numerator, simd.splat_u32s(self.denominator), simd.splat_u32s(self.multiplier))
    }
}

/// Per-lane denominators and their precomputed floor(2^32 / denominator).
#[inline(always)]
pub(crate) fn divide_u32s<S: Simd>(
    simd: S, numerator: S::u32s, denominator: S::u32s, multiplier: S::u32s,
) -> S::u32s {
    // Replace n/d with the high half of n*floor(2^32/d), then correct the
    // remainder. The estimate never exceeds floor(n/d) and is at most one
    // below it for every u32 numerator. Thus q*d cannot overflow, and this
    // integer correction preserves exact ties in (sum + d/2)/d. d=1 uses
    // multiplier=0 and is selected separately (2^32 does not fit in u32).
    let (_, quotient) = simd.widening_mul_u32s(numerator, multiplier);
    let remainder = simd.sub_u32s(numerator, simd.mul_u32s(quotient, denominator));
    let corrected = simd.select_u32s(
        simd.less_than_u32s(remainder, denominator), quotient,
        simd.add_u32s(quotient, simd.splat_u32s(1)),
    );
    simd.select_u32s(simd.equal_u32s(denominator, simd.splat_u32s(1)), numerator, corrected)
}

/// Gaussian emission needs only min(n/d, 255), not a full 64-bit quotient.
#[derive(Clone, Copy)]
pub(crate) struct U64ByteDivider {
    pub(crate) denominator: u64,
    multiplier: u64,
}

impl U64ByteDivider {
    #[inline]
    pub(crate) fn new(denominator: u64) -> Self {
        debug_assert_ne!(denominator, 0);
        // floor(2^64/d), without a 128-bit divide during setup. d=1 is identity.
        let multiplier = if denominator == 1 { 0 } else {
            u64::MAX / denominator + u64::from(u64::MAX % denominator == denominator - 1)
        };
        Self { denominator, multiplier }
    }

    #[inline(always)]
    pub(crate) fn divide(self, numerator: u64) -> u8 {
        if self.denominator == 1 { return numerator.min(255) as u8; }
        // As for U32Divider, multiply-high underestimates by at most one.
        // This replaces per-pixel hardware division with a reused exact constant.
        let quotient = ((u128::from(numerator) * u128::from(self.multiplier)) >> 64) as u64;
        let quotient = quotient + u64::from(numerator - quotient * self.denominator >= self.denominator);
        quotient.min(255) as u8
    }

    #[inline(always)]
    pub(crate) fn divide_simd<S: Simd>(self, simd: S, mut numerator: S::u64s) -> S::u64s {
        if S::U64_LANES < 8 {
            // The eight-step path took 11% longer in complete V3 Gaussian
            // workloads. Narrow vectors use the cached multiply-high constant;
            // accumulation stays SIMD, and no per-pixel divisor setup is added.
            for value in pulp::bytemuck::cast_slice_mut::<S::u64s, u64>(std::slice::from_mut(&mut numerator)) {
                *value = u64::from(self.divide(*value));
            }
            return numerator;
        }
        // Replace each scalar u64 division followed by min(255) with eight
        // restoring-division steps. Greedily testing d*128 through d*1 gives
        // the exact quotient below 256, and 255 for every larger quotient.
        // Skip products that cannot fit: no u64 numerator could reach them.
        // This avoids V2/V3's scalarized u64 multiplication and float error.
        let mut quotient = simd.splat_u64s(0);
        for bit in (0..8).rev() {
            if self.denominator <= u64::MAX >> bit {
                let scaled = simd.splat_u64s(self.denominator << bit);
                let take = simd.greater_than_or_equal_u64s(numerator, scaled);
                numerator = simd.select_u64s(take, simd.sub_u64s(numerator, scaled), numerator);
                quotient = simd.add_u64s(quotient, simd.select_u64s(take, simd.splat_u64s(1 << bit), simd.splat_u64s(0)));
            }
        }
        quotient
    }
}

/// Gaussian border vectors can have a different denominator in each lane.
#[inline(always)]
pub(crate) fn divide_u64s_to_u8<S: Simd>(
    simd: S, mut numerator: S::u64s, denominator: S::u64s,
) -> S::u64s {
    if S::U64_LANES < 8 {
        // Only mixed-denominator border tiles take this narrow-vector path.
        // Keep their original division rather than rebuild a reciprocal per
        // pixel; the uniform interior uses U64ByteDivider's cached constant.
        let divisors = pulp::bytemuck::cast_slice::<S::u64s, u64>(std::slice::from_ref(&denominator));
        for (value, &divisor) in pulp::bytemuck::cast_slice_mut::<S::u64s, u64>(std::slice::from_mut(&mut numerator)).iter_mut().zip(divisors) {
            *value = (*value / divisor).min(255);
        }
        return numerator;
    }
    // Same exact clipped quotient as U64ByteDivider. Form powers of two by
    // vector addition, not mul_u64s (scalar on V3), and reject wrapped scales.
    let mut scaled = [denominator; 8];
    for bit in 1..8 { scaled[bit] = simd.add_u64s(scaled[bit - 1], scaled[bit - 1]); }
    let mut quotient = simd.splat_u64s(0);
    for bit in (0..8).rev() {
        let take = simd.and_m64s(
            simd.less_than_or_equal_u64s(denominator, simd.splat_u64s(u64::MAX >> bit)),
            simd.greater_than_or_equal_u64s(numerator, scaled[bit]),
        );
        numerator = simd.select_u64s(take, simd.sub_u64s(numerator, scaled[bit]), numerator);
        quotient = simd.add_u64s(quotient, simd.select_u64s(take, simd.splat_u64s(1 << bit), simd.splat_u64s(0)));
    }
    quotient
}

/// Full-range products in pixel order: lower half first, then upper half.
/// Scalar has one product in the first vector and zero in the second.
#[inline(always)]
pub(crate) fn widening_mul_u32_to_u64<S: Simd>(
    simd: S,
    a: S::u32s,
    b: S::u32s,
) -> (S::u64s, S::u64s) {
    // V2/V3 mul_u64s is scalar, so obtain native widening 32-bit products instead.
    let (low, high) = simd.widening_mul_u32s(a, b);
    let low = pulp::bytemuck::cast_slice::<S::u32s, u32>(std::slice::from_ref(&low));
    let high = pulp::bytemuck::cast_slice::<S::u32s, u32>(std::slice::from_ref(&high));
    if S::IS_SCALAR {
        let product = u64::from(low[0]) | (u64::from(high[0]) << 32);
        return (simd.splat_u64s(product), simd.splat_u64s(0));
    }

    // Portable bitwise interleave/cast, independent of host endianness and of
    // Pulp's lane-local AVX shuffles. Write both halves completely, with no
    // zero-filled intermediate buffer and no scalar 64-bit multiplication.
    assert_eq!(u32_lanes::<S>(), 2 * u64_lanes::<S>());
    let mut out = MaybeUninit::<[S::u64s; 2]>::uninit();
    unsafe {
        let lanes = out.as_mut_ptr().cast::<u64>();
        for i in 0..u32_lanes::<S>() {
            lanes.add(i).write_unaligned(u64::from(low[i]) | (u64::from(high[i]) << 32));
        }
        let [first, second] = out.assume_init();
        (first, second)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_dividers_preserve_quotient_boundaries_and_lane_order() {
        struct Check;
        impl WithSimd for Check {
            type Output = ();
            fn with_simd<S: Simd>(self, simd: S) {
                let denominators = [1, 2, 3, 5, 7, 9, 25, 81, 255, 256, 511, 1_024,
                    65_535, 65_536, u32::MAX / 255, u32::MAX];
                let count = u32_lanes::<S>();
                for &denominator in &denominators {
                    let divider = U32Divider::new(denominator);
                    for quotient in [0u64, 1, 2, 127, 254, 255, 256, 65_535, u64::from(u32::MAX / denominator)] {
                        for delta in [-1i64, 0, 1] {
                            let boundary = quotient * u64::from(denominator);
                            let boundary = boundary as i64 + delta;
                            if !(0..=i64::from(u32::MAX)).contains(&boundary) { continue; }
                            let numerators: [u32; 16] = std::array::from_fn(|i| {
                                (boundary as u32).wrapping_add((i as u32).wrapping_mul(0x9e37_79b9))
                            });
                            let result = divider.divide_simd(simd, simd.partial_load_u32s(&numerators[..count]));
                            let result = pulp::bytemuck::cast_slice::<S::u32s, u32>(std::slice::from_ref(&result));
                            for i in 0..count {
                                assert_eq!(divider.divide(numerators[i]), numerators[i] / denominator);
                                assert_eq!(result[i], numerators[i] / denominator);
                            }
                        }
                    }
                }
                for offset in 0..16 {
                    let ds: [u32; 16] = std::array::from_fn(|i| denominators[(i + offset) % 16]);
                    let ms: [u32; 16] = std::array::from_fn(|i| U32Divider::new(ds[i]).multiplier);
                    let ns: [u32; 16] = std::array::from_fn(|i| u32::MAX.wrapping_sub((i as u32 + offset as u32).wrapping_mul(0x8765_4321)));
                    let result = divide_u32s(simd, simd.partial_load_u32s(&ns[..count]),
                        simd.partial_load_u32s(&ds[..count]), simd.partial_load_u32s(&ms[..count]));
                    let result = pulp::bytemuck::cast_slice::<S::u32s, u32>(std::slice::from_ref(&result));
                    for i in 0..count { assert_eq!(result[i], ns[i] / ds[i]); }
                }
                let count = u64_lanes::<S>();
                for denominator in [1u64, 2, 3, 81, 1 << 32, (1 << 53) + 1, u64::MAX / 255, u64::MAX / 2, u64::MAX] {
                    let divider = U64ByteDivider::new(denominator);
                    for quotient in [0u64, 1, 127, 254, 255, 256, 511] {
                        let Some(boundary) = denominator.checked_mul(quotient) else { continue; };
                        let ns = [boundary.saturating_sub(1), boundary, boundary.saturating_add(1),
                            u64::MAX, 0, denominator / 2, denominator, denominator.saturating_add(1)];
                        for offset in 0..8 {
                            let input: [u64; 8] = std::array::from_fn(|i| ns[(i + offset) % 8]);
                            let result = divider.divide_simd(simd, simd.partial_load_u64s(&input[..count]));
                            let result = pulp::bytemuck::cast_slice::<S::u64s, u64>(std::slice::from_ref(&result));
                            for i in 0..count {
                                let expected = (input[i] / denominator).min(255);
                                assert_eq!(u64::from(divider.divide(input[i])), expected);
                                assert_eq!(result[i], expected);
                            }
                        }
                    }
                }
                let ds64 = [1u64, 3, 81, 1 << 32, (1 << 53) + 1, u64::MAX / 255, u64::MAX / 2, u64::MAX];
                for offset in 0..8 {
                    let ds: [u64; 8] = std::array::from_fn(|i| ds64[(i + offset) % 8]);
                    let ns: [u64; 8] = std::array::from_fn(|i| u64::MAX.wrapping_sub((i as u64 + offset as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)));
                    let result = divide_u64s_to_u8(simd, simd.partial_load_u64s(&ns[..count]), simd.partial_load_u64s(&ds[..count]));
                    let result = pulp::bytemuck::cast_slice::<S::u64s, u64>(std::slice::from_ref(&result));
                    for i in 0..count { assert_eq!(result[i], (ns[i] / ds[i]).min(255)); }
                }
            }
        }
        for backend in Backend::supported_for_tests() { backend.dispatch(Check); }
    }

    #[test]
    fn unsigned_products_and_sums_preserve_boundaries_and_lane_order() {
        struct Check;

        impl WithSimd for Check {
            type Output = ();

            fn with_simd<S: Simd>(self, simd: S) {
                let values32 = [
                    0, 1, 2, 255, 65_535, 65_536, 0x7fff_ffff, 0x8000_0000,
                    u32::MAX - 1, u32::MAX, 1_024, 17, 3, 0x4000_0000, 65_537, 257,
                ];
                for offset in 0..values32.len() {
                    let a: [u32; 16] = std::array::from_fn(|i| values32[(i + offset) % 16]);
                    let b: [u32; 16] = std::array::from_fn(|i| values32[(3 * i + offset + 1) % 16]);
                    let count = u32_lanes::<S>();
                    let av = simd.partial_load_u32s(&a[..count]);
                    let bv = simd.partial_load_u32s(&b[..count]);
                    let sum = sat_add_u32(simd, av, bv);
                    let mul = sat_mul_u32(simd, av, bv);
                    let (first, second) = widening_mul_u32_to_u64(simd, av, bv);
                    let sum = pulp::bytemuck::cast_slice::<S::u32s, u32>(std::slice::from_ref(&sum));
                    let mul = pulp::bytemuck::cast_slice::<S::u32s, u32>(std::slice::from_ref(&mul));
                    let halves = [first, second];
                    let products = pulp::bytemuck::cast_slice::<S::u64s, u64>(&halves);
                    for i in 0..count {
                        assert_eq!(sum[i], a[i].saturating_add(b[i]));
                        assert_eq!(mul[i], a[i].saturating_mul(b[i]));
                        assert_eq!(products[i], u64::from(a[i]) * u64::from(b[i]));
                    }
                    if S::IS_SCALAR {
                        assert_eq!(products[1], 0);
                    }
                }

                let values64 = [0, 1, 2, u64::MAX / 2, 1 << 63, u64::MAX - 1, u64::MAX, 1_024];
                for offset in 0..values64.len() {
                    let a: [u64; 8] = std::array::from_fn(|i| values64[(i + offset) % 8]);
                    let b: [u64; 8] = std::array::from_fn(|i| values64[(3 * i + offset + 1) % 8]);
                    let count = u64_lanes::<S>();
                    let sum = sat_add_u64(
                        simd,
                        simd.partial_load_u64s(&a[..count]),
                        simd.partial_load_u64s(&b[..count]),
                    );
                    let sum = pulp::bytemuck::cast_slice::<S::u64s, u64>(std::slice::from_ref(&sum));
                    for i in 0..count {
                        assert_eq!(sum[i], a[i].saturating_add(b[i]));
                    }
                }
            }
        }

        for backend in Backend::supported_for_tests() {
            backend.dispatch(Check);
        }
    }
}
