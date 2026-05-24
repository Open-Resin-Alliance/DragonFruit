/**
 * Physics-based automatic AA parameter prediction for mSLA printers.
 *
 * Derives AA settings from the physical voxel shape (XY pixel pitch vs. Z layer
 * height), plus a conservative UV-bloom model. Auto mode intentionally chooses
 * the backend kernel too: sharp prints use supersampled Coverage, ordinary 2D
 * smoothing uses Blur, and visibly anisotropic voxels use perturbation 3DAA.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Physical model
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * mSLA prints are composed of voxels defined by two length scales:
 *
 *   pixel pitch (XY) — the lateral size of one display pixel on the build plate
 *   layer height (Z) — the vertical thickness of one cured layer
 *
 * Voxel aspect ratio:  r = layerHeight / pixelPitch
 *
 *   r ≪ 1  →  "pancake" voxel — layers much thinner than pixels; Z steps fine
 *   r ≈ 1  →  cubic voxel     — equal staircase character in all directions
 *   r ≫ 1  →  "pillar" voxel  — layers much thicker than pixels; heavy Z steps
 *
 *
 * UV Bloom
 * ────────
 * UV light (typically 405 nm) passing through the LCD panel and FEP film
 * diffracts and scatters, creating a physical penumbra around each lit pixel.
 * Published edge-characterisation studies on mSLA pixel profiles
 * (Gong et al. 2014; Pan et al. 2012) put the 1/e² bloom radius at roughly
 * 0.25–0.35 × pixel pitch for standard 4–6K printers with 0.04–0.06 mm pitch.
 * High-resolution printers with tighter optics sit near the lower bound.
 *
 * Bloom softens edges "for free" — AA needs only to cover the remaining gap
 * between bloom-provided softening and the total desired edge gradient.
 *
 *
 * AA Strength (supersampling steps)
 * ───────────────────────────────────
 * Supersampling renders each layer at N times the native resolution and then
 * downsamples, distributing sub-pixel coverage across edge boundaries.
 * Perceptual benefit is sub-linear in N: 4× provides ~75 % of the theoretical
 * edge-quality maximum; 8× provides ~88 %; 16× adds less than 5 % more.
 *
 * We model this with a power-law scale anchored at 4× for a 0.05 mm reference
 * pitch.  The sub-linear exponent (0.65) matches the flattening of the
 * perceptual improvement curve reported in sub-pixel rendering literature and
 * avoids the runaway values produced by a linear 1/pitch formula on high-res
 * screens (e.g. 21× for a 12K printer at 0.019 mm pitch).
 *
 *
 * 2D Blur Width
 * ─────────────
 * A box/Gaussian blur applied after rasterization adds physical softening to
 * round off the remaining hard pixel boundary.  The target softening distance
 * (mm) is preset-dependent; bloom is subtracted because the printer already
 * provides that much softening naturally:
 *
 *   blur_px = max(1, round( (target_mm − bloom_mm) / pitch_mm ))
 *
 * Sharp intentionally targets 0 mm explicit blur and uses Coverage SSAA instead.
 *
 * This produces 1 px for most printers at Balanced (bloom covers much of the
 * target) and rises to 2–4 px only for very fine-pitch screens where even 1 px
 * of blur = very little physical distance.
 *
 *
 * 3DAA Look-back (blend window)
 * ─────────────────────────────
 * Z-axis anti-aliasing blends adjacent layers at sloped surfaces.  The look-back
 * depth controls how many layers above and below contribute to the blend.
 *
 * The blend/look-ahead window needs to cover the dominant stair-step period.
 * With very fine XY pixels and thicker layers, each new layer can jump several
 * pixels laterally, so we keep a few neighboring layers available. With very
 * thin layers and coarser pixels, several layers are required before a slope
 * crosses one pixel, so the window grows from the inverse aspect ratio instead.
 *
 *
 * Note on model geometry
 * ─────────────────────
 * Loaded model geometry (slope distribution, surface area) is intentionally NOT
 * incorporated because:
 *   a) The slope-adaptive blending mode inside the Rust slicer already performs
 *      per-pixel geometric analysis during rasterisation.
 *   b) Bounding-box data cannot reliably predict the dominant slope angles of a
 *      complex organic print.
 *   c) Pixel pitch + layer height already encode the print's voxel anisotropy,
 *      which is the correct first-order design target for parameter selection.
 */

// ── Physical constants ────────────────────────────────────────────────────────

/**
 * Bloom radius as a fraction of pixel pitch.
 * Midpoint of the 0.25–0.35 range reported for typical 405 nm mSLA optics.
 */
const BLOOM_PITCH_FRACTION = 0.28;

/**
 * Reference pixel pitch (mm) at which base AA step count equals 4.
 * 0.05 mm ≈ a typical 4K mSLA screen (e.g. 2560 × 1440 on 128 × 80 mm plate).
 */
const REFERENCE_PITCH_MM = 0.05;

/**
 * Sub-linear exponent for AA step scaling with pixel pitch.
 *
 * At 0.019 mm pitch (12K printer) vs 0.05 mm reference:
 *   linear  (exp = 1.0): 4 × (0.05 / 0.019) ≈ 10.5 → 11  — overshoot
 *   sub-lin (exp = 0.65): 4 × 2.63^0.65     ≈  7.5 →  8  — sensible cap
 */
const PITCH_SCALE_EXPONENT = 0.65;

/**
 * Hard ceiling on automatically selected supersampling steps.
 *
 * Beyond 8× each doubling of steps costs proportional render time while
 * contributing imperceptible improvement at mSLA print resolution.
 * Users requiring higher values can switch to Advanced mode.
 */
const AA_STEPS_AUTO_MAX = 8;

/**
 * Physical blur targets (mm of desired edge gradient) per preset, before
 * subtracting bloom softening that the printer already provides naturally.
 *
 *   sharp    0.000 mm — no explicit blur; preserves fine detail and lettering
 *   balanced 0.040 mm — clear smoothing without destructive detail loss
 *   smooth   0.075 mm — aggressive softening; suited to organic/curved surfaces
 */
const BLUR_PHYSICAL_TARGET_MM = {
  sharp:    0.000,
  balanced: 0.040,
  smooth:   0.075,
} as const;

/**
 * Aspect ratio threshold below which 3DAA adds negligible benefit.
 *
 * When layerHeight / pixelPitch is low (e.g. 0.010 mm layers on a 0.047 mm
 * pitch printer), Z steps are sub-pixel in height and virtually invisible.
 * 3DAA blending would waste render time for no perceptible gain. Smooth mode
 * lowers the threshold because the user is explicitly asking for soft organic
 * curvature; sharp mode never enables 3DAA automatically.
 */
const MIN_ASPECT_RATIO_FOR_3DAA = {
  sharp: Number.POSITIVE_INFINITY,
  balanced: 0.35,
  smooth: 0.25,
} as const;


// ── Types ─────────────────────────────────────────────────────────────────────

/** Quality intent, matching the Auto mode preset buttons in the UI. */
export type AaPreset = 'sharp' | 'balanced' | 'smooth';

/**
 * Fully computed AA configuration produced by this module.
 * Includes both user-facing labels and the exact native backend mode.
 */
export type PhysicalAaConfig = {
  /** User-facing family. 'Blur' includes Coverage and 2D Blur backend modes. */
  aaMode: 'Blur' | '3DAA';
  /** Actual native backend mode selected by Auto. */
  antiAliasingMode: 'Coverage' | 'Blur' | 'Vertical2';
  /**
   * Supersampling factor (integer ≥ 2).
   * Higher values resolve finer sub-pixel edge detail at proportional render cost.
   */
  aaSteps: number;
  /**
   * 2D blur kernel radius in printer pixels, applied after supersampling.
   * Compensates for residual edge softness after bloom is accounted for.
   */
  blurBrushRadiusPx: number;
  /** Optional Gaussian blur radius across neighboring layers, in layer units. */
  zBlurRadiusLayers: number;
  /**
   * 3DAA blend window: number of adjacent layers (above + below) included in
   * the Z-axis blending pass.  Sized to cover one full 45° slope pixel crossing.
   */
  zBlendLookBack: number;
  /** Area-equivalent XY pixel pitch used for the physical calculations. */
  pixelPitchMm: number;
  /** `layerHeight / pixelPitch`; values far from 1 indicate anisotropic voxels. */
  voxelAspectRatio: number;
};


// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}


// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Estimate the UV bloom radius (mm) for a given pixel pitch.
 *
 * Bloom softens edges physically — our explicit AA needs only to cover the
 * remaining edge gradient distance after bloom is accounted for.
 */
export function estimateBloomRadiusMm(pitchMm: number): number {
  return Math.max(0, pitchMm) * BLOOM_PITCH_FRACTION;
}

function resolveBackendMode(preset: AaPreset, aspectRatio: number): 'Coverage' | 'Blur' | 'Vertical2' {
  if (preset === 'sharp') {
    // Coverage SSAA preserves small lettering and mechanical edges better than
    // a blur pass. The slicer will supersample/downsample RLE without widening
    // the physical footprint.
    return 'Coverage';
  }

  if (aspectRatio >= MIN_ASPECT_RATIO_FOR_3DAA[preset]) {
    return 'Vertical2';
  }

  // Very thin layers already hide Z stairs; use simple XY blur rather than
  // paying the perturbation/neighbor-layer cost.
  return 'Blur';
}

function computeBlendWindow(aspectRatio: number, preset: AaPreset): number {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return 2;

  const periodLayers = aspectRatio >= 1
    ? Math.ceil(aspectRatio) + 1
    : Math.ceil(1 / aspectRatio);

  if (preset === 'smooth') {
    return clamp(Math.round(periodLayers * 1.35) + 1, 2, 10);
  }

  return clamp(periodLayers, 2, 8);
}

function computeZBlurRadiusLayers(aspectRatio: number, preset: AaPreset, use3DAA: boolean): number {
  if (!use3DAA) return 0;

  const base = aspectRatio >= 1.6 ? 2 : 1;
  const presetBoost = preset === 'smooth' ? 1 : 0;
  return clamp(base + presetBoost, 1, 4);
}

/**
 * Compute physics-grounded automatic AA parameters for an mSLA printer.
 *
 * All output parameters derive from two physical lengths (pixel pitch and
 * layer height) plus empirically calibrated optical constants.
 *
 * @param preset   Quality intent: 'sharp' / 'balanced' / 'smooth'
 * @param pitchMm  Physical X pixel pitch in mm
 * @param layerMm  Effective layer height in mm from the active material profile
 * @param pitchYMm Optional physical Y pixel pitch in mm for non-square pixels
 *
 * Reference outputs for common hardware at 0.05 mm layer height:
 *
 *   Printer      pitch   preset     steps  blur       backend   look-back
 *   ──────────   ──────  ─────────  ─────  ─────────  ────────  ─────────
 *   12K (0.019)  0.019   balanced    8×    2px XY/2L  3DAA      4 lyr
 *   12K (0.019)  0.019   smooth      8×    4px XY/3L  3DAA      6 lyr
 *   12K (0.019)  0.019   sharp       4×    none       Coverage  —
 *    8K (0.028)  0.028   balanced    6×    1px XY/2L  3DAA      3 lyr
 *    4K (0.047)  0.047   balanced    4×    1px XY/1L  3DAA      3 lyr
 *   low (0.085)  0.085   balanced    3×    1px XY/1L  3DAA      2 lyr
 */
export function computePhysicalAaConfig(
  preset: AaPreset,
  pitchMm: number,
  layerMm: number,
  pitchYMm = pitchMm,
): PhysicalAaConfig {
  const safePitchX = Math.max(pitchMm, 1e-4);
  const safePitchY = Math.max(pitchYMm, 1e-4);
  const finePitch = Math.min(safePitchX, safePitchY);
  const coarsePitch = Math.max(safePitchX, safePitchY);
  const safePitch = Math.sqrt(finePitch * coarsePitch);
  const safeLayer = Math.max(layerMm, 0.001);

  const bloomMm = estimateBloomRadiusMm(safePitch);

  /**
   * Voxel aspect ratio: r = layerHeight / pixelPitch.
   *
   *   r < 1  →  "pancake" voxel — Z steps finer than XY pixels
   *   r ≈ 1  →  cubic voxel     — equal staircase in XY and Z
   *   r > 1  →  "pillar" voxel  — Z stepping very visible on sloped faces
   *
   * This drives the 3DAA look-back depth and the decision to use 3DAA at all.
   */
  const aspectRatio = safeLayer / safePitch;
  const anisotropyRatio = coarsePitch / finePitch;


  // ── AA Steps ──────────────────────────────────────────────────────────────
  //
  // Power-law scaling anchored at 4× for the 0.05 mm reference pitch.
  // Sub-linear exponent models diminishing perceptual returns at fine pitch.
  //
  const anisotropyBoost = anisotropyRatio >= 1.20 ? 1 : 0;
  const baseSteps = clamp(
    Math.round(4 * Math.pow(REFERENCE_PITCH_MM / safePitch, PITCH_SCALE_EXPONENT)) + anisotropyBoost,
    2,
    AA_STEPS_AUTO_MAX,
  );

  let aaSteps: number;
  switch (preset) {
    case 'sharp':
      // Crisp intent: AA is a minimal staircase correction, not a smoothing pass.
      // Halve the base, floor at 2, cap at 4 — sharp never needs heavy sampling.
      aaSteps = clamp(Math.round(baseSteps * 0.6), 2, 4);
      break;
    case 'smooth':
      // Max useful smoothing: bump by 2 steps, stay within the auto ceiling.
      aaSteps = clamp(baseSteps + 2, 4, AA_STEPS_AUTO_MAX);
      break;
    default: // 'balanced'
      aaSteps = baseSteps;
  }


  // ── Blur Width ────────────────────────────────────────────────────────────
  //
  // Bloom already softens edges by ~bloomMm.  We only add blur for the delta
  // between bloom and the preset's total target softening distance.
  //
  //   blur_px = max(1, round( (target_mm − bloom_mm) / pitch_mm ))
  //
  // At fine pitch, each pixel spans less physical distance, so more pixels of
  // blur are required to achieve the same mm of physical softening — the
  // formula handles this automatically.
  //
  const remainingBlurMm = Math.max(0, BLUR_PHYSICAL_TARGET_MM[preset] - bloomMm);
  const computedBlurPx = Math.round(remainingBlurMm / safePitch);

  const antiAliasingMode = resolveBackendMode(preset, aspectRatio);
  const use3DAA = antiAliasingMode === 'Vertical2';
  const aaMode: 'Blur' | '3DAA' = use3DAA ? '3DAA' : 'Blur';
  const blurBrushRadiusPx = antiAliasingMode === 'Coverage'
    ? 0
    : clamp(Math.max(1, computedBlurPx), 1, 6);


  let zBlendLookBack = 2; // safe default; only meaningful when aaMode === '3DAA'

  if (use3DAA) {
    zBlendLookBack = computeBlendWindow(aspectRatio, preset);
  }

  const zBlurRadiusLayers = computeZBlurRadiusLayers(aspectRatio, preset, use3DAA);

  return {
    aaMode,
    antiAliasingMode,
    aaSteps,
    blurBrushRadiusPx,
    zBlurRadiusLayers,
    zBlendLookBack,
    pixelPitchMm: safePitch,
    voxelAspectRatio: aspectRatio,
  };
}
