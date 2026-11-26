import React from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import {
  getHoveredStressLayerZ,
  subscribeHoveredStressLayerZ,
  type LayerPeelPoint,
  type PrintabilityReport,
  type SupportFrameStressReport,
} from '@/supports/autoSupport';

const LAYER_TEX_WIDTH = 128;
const MAX_STRESS_SPOTS = 32;
const STRESS_SPOT_RADIUS_MM = 1.15;
const STRESS_SPOT_RADIUS_SQ = STRESS_SPOT_RADIUS_MM * STRESS_SPOT_RADIUS_MM;

// Never disposed: acts as initial placeholder texture across StrictMode remounts.
const FALLBACK_DATA = new Uint8Array([0, 0, 0, 255]);
const FALLBACK_LAYER_TEX = new THREE.DataTexture(FALLBACK_DATA, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
FALLBACK_LAYER_TEX.needsUpdate = true;
const FALLBACK_MASK_TEX = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
FALLBACK_MASK_TEX.needsUpdate = true;

function buildLayerForceTexture(layers: readonly LayerPeelPoint[]): {
  layerTex: THREE.DataTexture;
  zMin: number;
  zMax: number;
} {
  const texData = new Uint8Array(LAYER_TEX_WIDTH * 4);
  let zMin = 0;
  let zMax = 1;

  if (layers.length === 1) {
    zMin = layers[0].zMm - 0.5;
    zMax = layers[0].zMm + 0.5;
    for (let i = 0; i < LAYER_TEX_WIDTH; i++) {
      const t = i / (LAYER_TEX_WIDTH - 1) - 0.5;
      const bell = Math.exp(-(t * t) / (2 * 0.18 * 0.18));
      const off = i * 4;
      texData[off] = Math.round(bell * 255);
      texData[off + 1] = Math.round(Math.min(1, Math.max(layers[0].maxTipUtilPct, layers[0].maxMemberUtilPct) / 100) * 255);
      texData[off + 2] = 0;
      texData[off + 3] = 255;
    }
  } else if (layers.length > 1) {
    zMin = layers[0].zMm;
    zMax = Math.max(zMin + 1e-3, layers[layers.length - 1].zMm);

    let maxForce = 0.05;
    for (const l of layers) {
      if (l.peelForceN > maxForce) maxForce = l.peelForceN;
    }

    let cursor = 0;
    for (let i = 0; i < LAYER_TEX_WIDTH; i++) {
      const z = zMin + (i / (LAYER_TEX_WIDTH - 1)) * (zMax - zMin);
      while (cursor + 1 < layers.length && layers[cursor + 1].zMm < z) {
        cursor++;
      }
      const a = layers[cursor];
      const b = layers[Math.min(layers.length - 1, cursor + 1)];
      const span = b.zMm - a.zMm;
      const frac = span > 1e-6 ? Math.min(1, Math.max(0, (z - a.zMm) / span)) : 0;

      const force = a.peelForceN + (b.peelForceN - a.peelForceN) * frac;
      const utilA = Math.max(a.maxTipUtilPct, a.maxMemberUtilPct);
      const utilB = Math.max(b.maxTipUtilPct, b.maxMemberUtilPct);
      const util = utilA + (utilB - utilA) * frac;

      const off = i * 4;
      texData[off] = Math.round(Math.min(1, Math.max(0, force / maxForce)) * 255);
      texData[off + 1] = Math.round(Math.min(1, Math.max(0, util / 100)) * 255);
      texData[off + 2] = 0;
      texData[off + 3] = 255;
    }
  } else {
    for (let i = 0; i < LAYER_TEX_WIDTH; i++) {
      texData[i * 4 + 3] = 255;
    }
  }

  const layerTex = new THREE.DataTexture(texData, LAYER_TEX_WIDTH, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  layerTex.minFilter = THREE.LinearFilter;
  layerTex.magFilter = THREE.LinearFilter;
  layerTex.wrapS = THREE.ClampToEdgeWrapping;
  layerTex.wrapT = THREE.ClampToEdgeWrapping;
  layerTex.needsUpdate = true;

  return { layerTex, zMin, zMax };
}

function buildOverloadSpots(report: SupportFrameStressReport): {
  spots: THREE.Vector4[];
  spotCount: number;
} {
  const memberMaxByEntity = new Map<string, number>();
  for (const seg of report.memberSegments) {
    if (seg.utilizationPct <= 100) continue;
    const prev = memberMaxByEntity.get(seg.entityId) ?? 0;
    if (seg.utilizationPct > prev) memberMaxByEntity.set(seg.entityId, seg.utilizationPct);
  }

  const candidates: Array<{ x: number; y: number; z: number; utilPct: number }> = [];
  for (const tip of report.tipPoints) {
    const eff = Math.max(tip.utilizationPct, memberMaxByEntity.get(tip.entityId) ?? 0);
    if (eff <= 100) continue;
    candidates.push({ x: tip.pos.x, y: tip.pos.y, z: tip.pos.z, utilPct: eff });
  }

  for (const h of report.hotspots) {
    if (h.utilizationPct <= 100) continue;
    const duplicate = candidates.some((c) => {
      const dx = c.x - h.pos.x;
      const dy = c.y - h.pos.y;
      const dz = c.z - h.pos.z;
      return dx * dx + dy * dy + dz * dz < 1.0;
    });
    if (!duplicate) {
      candidates.push({ x: h.pos.x, y: h.pos.y, z: h.pos.z, utilPct: h.utilizationPct });
    }
  }

  candidates.sort((a, b) => b.utilPct - a.utilPct);
  const spotCount = Math.min(MAX_STRESS_SPOTS, candidates.length);
  const spots: THREE.Vector4[] = Array.from({ length: MAX_STRESS_SPOTS }, (_, idx) => {
    if (idx < spotCount) {
      const c = candidates[idx];
      return new THREE.Vector4(c.x, c.y, c.z, Math.min(1.5, c.utilPct / 100));
    }
    return new THREE.Vector4(0, 0, 0, 0);
  });

  return { spots, spotCount };
}

/**
 * Stefan adhesion as a plan texture (R = peak peel pressure). One texel covers
 * `cellMm` of world XY, so the shader samples it in world space and the paint
 * survives the model's transform. No sampled fields → disabled uniform.
 */
function buildPeelTexture(printability: PrintabilityReport | null | undefined): {
  tex: THREE.DataTexture;
  min: THREE.Vector2;
  invSize: THREE.Vector2;
  enabled: number;
} {
  const overlay = printability?.peelOverlay;
  if (!overlay || overlay.nx <= 0 || overlay.ny <= 0) {
    return {
      tex: FALLBACK_MASK_TEX,
      min: new THREE.Vector2(0, 0),
      invSize: new THREE.Vector2(0, 0),
      enabled: 0,
    };
  }
  const data = new Uint8Array(overlay.nx * overlay.ny * 4);
  for (let i = 0; i < overlay.peel.length; i++) {
    const off = i * 4;
    data[off] = overlay.peel[i];
    data[off + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, overlay.nx, overlay.ny, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return {
    tex,
    // Half-texel offset so each rasterized cell centre lands on a texel centre
    // (LinearFilter would otherwise smear the paint half a cell to the low side).
    min: new THREE.Vector2(overlay.minX - overlay.cellMm * 0.5, overlay.minY - overlay.cellMm * 0.5),
    invSize: new THREE.Vector2(1 / (overlay.cellMm * overlay.nx), 1 / (overlay.cellMm * overlay.ny)),
    enabled: 1,
  };
}

export function StressForceHeatmapMaterial({
  report,
  printability,
  clippingPlanes,
  materialRoughness,
}: {
  /** Peel/stress layer report; absent when only the printability paint is shown. */
  report?: SupportFrameStressReport | null;
  /** Live printability report; its `peelOverlay` paints the Stefan adhesion. */
  printability?: PrintabilityReport | null;
  clippingPlanes: THREE.Plane[];
  materialRoughness?: number;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const fakeLightDir = React.useMemo(() => new THREE.Vector3(0.35, 0.58, 0.74).normalize(), []);
  const initialSpots = React.useMemo(
    () => Array.from({ length: MAX_STRESS_SPOTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    [],
  );

  const uniformsRef = React.useRef({
    uLayerForceTex: { value: FALLBACK_LAYER_TEX },
    uZMin: { value: 0 },
    uZMax: { value: 1 },
    uHoverZ: { value: -1e6 },
    uSpotCount: { value: 0 },
    uSpotRadiusSq: { value: STRESS_SPOT_RADIUS_SQ },
    uStressSpots: { value: initialSpots },
    uPeelTex: { value: FALLBACK_MASK_TEX },
    uPeelMin: { value: new THREE.Vector2(0, 0) },
    uPeelInvSize: { value: new THREE.Vector2(0, 0) },
    uPeelEnabled: { value: 0 },
    uFakeAoStrength: { value: 0.22 },
    uFakeLightDir: { value: fakeLightDir },
  });

  React.useEffect(() => {
    const u = uniformsRef.current;
    // The band is useful without supports: the demand curve exists as soon as
    // the profile is sampled, so fall back to it when no frame was solved.
    const layers = report && report.layerProfile.length > 0
      ? report.layerProfile
      : printability?.peelCurve ?? [];
    if (layers.length === 0) {
      u.uLayerForceTex.value = FALLBACK_LAYER_TEX;
      u.uZMin.value = 0;
      u.uZMax.value = 1;
      u.uSpotCount.value = 0;
      invalidate();
      return;
    }
    const { layerTex, zMin, zMax } = buildLayerForceTexture(layers);
    const { spots, spotCount } = report ? buildOverloadSpots(report) : { spots: initialSpots, spotCount: 0 };
    u.uLayerForceTex.value = layerTex;
    u.uZMin.value = zMin;
    u.uZMax.value = zMax;
    u.uSpotCount.value = spotCount;
    u.uStressSpots.value = spots;
    invalidate();
    return () => {
      u.uLayerForceTex.value = FALLBACK_LAYER_TEX;
      layerTex.dispose();
    };
  }, [report, printability, invalidate, initialSpots]);

  React.useEffect(() => {
    const u = uniformsRef.current;
    const { tex, min, invSize, enabled } = buildPeelTexture(printability);
    u.uPeelTex.value = tex;
    u.uPeelMin.value = min;
    u.uPeelInvSize.value = invSize;
    u.uPeelEnabled.value = enabled;
    invalidate();
    return () => {
      if (tex !== FALLBACK_MASK_TEX) tex.dispose();
      u.uPeelTex.value = FALLBACK_MASK_TEX;
      u.uPeelEnabled.value = 0;
    };
  }, [printability, invalidate]);

  React.useEffect(() => {
    const syncHover = () => {
      const z = getHoveredStressLayerZ();
      uniformsRef.current.uHoverZ.value = z ?? -1e6;
      invalidate();
    };
    syncHover();
    return subscribeHoveredStressLayerZ(syncHover);
  }, [invalidate]);

  return (
    <meshStandardMaterial
      color="#454b59"
      emissive="#000000"
      emissiveIntensity={0}
      metalness={0.02}
      roughness={materialRoughness ?? 0.88}
      envMapIntensity={0.34}
      clippingPlanes={clippingPlanes}
      side={THREE.FrontSide}
      flatShading={false}
      customProgramCacheKey={() => 'df-stress-force-heatmap'}
      onBeforeCompile={(shader) => {
        shader.uniforms.uLayerForceTex = uniformsRef.current.uLayerForceTex;
        shader.uniforms.uZMin = uniformsRef.current.uZMin;
        shader.uniforms.uZMax = uniformsRef.current.uZMax;
        shader.uniforms.uHoverZ = uniformsRef.current.uHoverZ;
        shader.uniforms.uSpotCount = uniformsRef.current.uSpotCount;
        shader.uniforms.uSpotRadiusSq = uniformsRef.current.uSpotRadiusSq;
        shader.uniforms.uStressSpots = uniformsRef.current.uStressSpots;
        shader.uniforms.uPeelTex = uniformsRef.current.uPeelTex;
        shader.uniforms.uPeelMin = uniformsRef.current.uPeelMin;
        shader.uniforms.uPeelInvSize = uniformsRef.current.uPeelInvSize;
        shader.uniforms.uPeelEnabled = uniformsRef.current.uPeelEnabled;
        shader.uniforms.uFakeAoStrength = uniformsRef.current.uFakeAoStrength;
        shader.uniforms.uFakeLightDir = uniformsRef.current.uFakeLightDir;

        shader.vertexShader = `
          varying vec3 vWorldPosStress;
          varying vec3 vWorldNormalStress;
        ` + shader.vertexShader;

        shader.vertexShader = shader.vertexShader.replace(
          '#include <worldpos_vertex>',
          `
            #include <worldpos_vertex>
            vWorldPosStress = (modelMatrix * vec4(transformed, 1.0)).xyz;
            vWorldNormalStress = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
          `,
        );

        shader.fragmentShader = `
          uniform sampler2D uLayerForceTex;
          uniform float uZMin;
          uniform float uZMax;
          uniform float uHoverZ;
          uniform int uSpotCount;
          uniform float uSpotRadiusSq;
          uniform vec4 uStressSpots[32];
          uniform sampler2D uPeelTex;
          uniform vec2 uPeelMin;
          uniform vec2 uPeelInvSize;
          uniform float uPeelEnabled;
          uniform float uFakeAoStrength;
          uniform vec3 uFakeLightDir;
          varying vec3 vWorldPosStress;
          varying vec3 vWorldNormalStress;
        ` + shader.fragmentShader;

        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          `
            #include <color_fragment>

            float zSpan = max(uZMax - uZMin, 0.001);
            float zNorm = clamp((vWorldPosStress.z - uZMin) / zSpan, 0.0, 1.0);
            float edgeFade = smoothstep(uZMin - 0.6, uZMin + 0.1, vWorldPosStress.z)
              * (1.0 - smoothstep(uZMax - 0.1, uZMax + 0.6, vWorldPosStress.z));
            vec4 layerSample = texture2D(uLayerForceTex, vec2(zNorm, 0.5));
            float peelForceNorm = clamp(layerSample.r * edgeFade, 0.0, 1.0);
            float downwardMod = 0.84 + 0.16 * clamp(-vWorldNormalStress.z * 0.5 + 0.5, 0.0, 1.0);
            float t = clamp(peelForceNorm * downwardMod, 0.0, 1.0);

            vec3 cSlate = vec3(0.271, 0.294, 0.349);  // #454b59
            vec3 cCool  = vec3(0.180, 0.490, 0.608);  // #2e7d9b
            vec3 cTeal  = vec3(0.180, 0.714, 0.490);  // #2eb67d
            vec3 cAmber = vec3(0.961, 0.620, 0.043);  // #f59e0b
            vec3 cCrit  = vec3(0.894, 0.329, 0.329);  // #e45454

            vec3 bandColor;
            if (t < 0.25) {
              bandColor = mix(cSlate, cCool, t / 0.25);
            } else if (t < 0.50) {
              bandColor = mix(cCool, cTeal, (t - 0.25) / 0.25);
            } else if (t < 0.75) {
              bandColor = mix(cTeal, cAmber, (t - 0.50) / 0.25);
            } else {
              bandColor = mix(cAmber, cCrit, (t - 0.75) / 0.25);
            }
            // The 1D Z band is the fallback: when the adhesion overlay is present
            // the colour comes from plan-space pressure instead, so two points at
            // one height read differently by where the peel lands.
            if (uPeelEnabled < 0.5) {
              diffuseColor.rgb = mix(diffuseColor.rgb, bandColor, 0.78);
            }

            // Live graph-hovered Z contour ring
            float slope = sqrt(max(0.0, 1.0 - vWorldNormalStress.z * vWorldNormalStress.z));
            if (uHoverZ > -1e5) {
              float hoverDist = abs(vWorldPosStress.z - uHoverZ) / max(slope, 0.08);
              float hoverRing = 1.0 - smoothstep(0.10, 0.28, hoverDist);
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.38, 0.68), hoverRing * 0.85);
            }

            // Pinpoint overload highlights only (>100% overloaded beam/tip anchors)
            float maxOverCover = 0.0;
            for (int i = 0; i < 32; i++) {
              if (i >= uSpotCount) break;
              vec4 spot = uStressSpots[i];
              vec3 d = vWorldPosStress - spot.xyz;
              float distSq = dot(d, d);
              float w = exp(-distSq / (2.0 * uSpotRadiusSq));
              maxOverCover = max(maxOverCover, w);
            }
            if (maxOverCover > 0.03) {
              diffuseColor.rgb = mix(diffuseColor.rgb, cCrit, clamp(maxOverCover * 0.75, 0.0, 0.75));
            }

            // Stefan adhesion overlay: the plan-space peel pressure, max-projected
            // over the sampled layers, on the faces the vat actually pulls on.
            if (uPeelEnabled > 0.5) {
              vec2 peelUv = (vWorldPosStress.xy - uPeelMin) * uPeelInvSize;
              float inside = step(0.0, peelUv.x) * step(peelUv.x, 1.0)
                * step(0.0, peelUv.y) * step(peelUv.y, 1.0);
              float peel = texture2D(uPeelTex, peelUv).r * inside;
              float underside = 1.0 - smoothstep(-0.65, 0.15, vWorldNormalStress.z);

              vec3 adhesion = mix(cCool, cTeal, smoothstep(0.10, 0.55, peel));
              adhesion = mix(adhesion, cAmber, smoothstep(0.55, 0.92, peel));
              // Readable from the working view (top faces get a lighter wash) and
              // strongest on the peel face (downward normals).
              float weight = clamp(peel * mix(0.40, 1.0, underside), 0.0, 1.0);
              diffuseColor.rgb = mix(diffuseColor.rgb, adhesion, weight * 0.80);
            }
          `,
        );

        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <output_fragment>',
          `
            #include <output_fragment>
            vec3 n = normalize(normal);
            float nDotL = max(dot(n, normalize(uFakeLightDir)), 0.0);
            float cavity = pow(1.0 - nDotL, 1.35);
            float fakeAo = 1.0 - (cavity * uFakeAoStrength);
            gl_FragColor.rgb *= fakeAo;
          `,
        );
      }}
    />
  );
}
