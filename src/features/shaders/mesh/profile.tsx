import React from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { ProfileLayerColorBand } from './types';
import { SoftClayMaterial } from './softClay';
import type { ProfileColorUniforms, ProfileColorUniformsRef } from './profileShader';

const ProfileColorContext = React.createContext<ProfileColorUniformsRef | null>(null);

export function ProfileColorOverlayProvider({
  bands,
  enabled,
  children,
}: {
  bands: readonly ProfileLayerColorBand[];
  enabled: boolean;
  children: React.ReactNode;
}) {
  const maxTextureSize = useThree((state) => state.gl.capabilities.maxTextureSize);
  const invalidate = useThree((state) => state.invalidate);
  const uniformsRef = React.useRef<ProfileColorUniforms | null>(null);
  if (uniformsRef.current === null) {
    uniformsRef.current = {
      uProfileBands: { value: null },
      uProfileBandCount: { value: 0 },
      uProfileTextureWidth: { value: 1 },
    };
  }

  React.useLayoutEffect(() => {
    const uniforms = uniformsRef.current!;
    if (!enabled || bands.length === 0) {
      invalidate();
      return;
    }

    const texelCount = bands.length * 2;
    // texelFetch uses signed integer addresses. Neither the hardware capacity
    // nor GLSL's address range may silently truncate the supplied table.
    if (texelCount > maxTextureSize * maxTextureSize || texelCount > 0x7fffffff) {
      throw new RangeError(`Profile band texture exceeds renderer capacity (${bands.length} bands, ${maxTextureSize}px maximum texture size)`);
    }
    const width = Math.min(texelCount, maxTextureSize);
    const height = Math.ceil(texelCount / width);
    const data = new Float32Array(width * height * 4);
    const color = new THREE.Color();
    for (let index = 0; index < bands.length; index += 1) {
      const band = bands[index];
      const offset = index * 8;
      data[offset] = band.lowerMm;
      data[offset + 1] = band.upperMm;
      // Color.set converts CSS/sRGB input to three's linear working space.
      color.set(band.color);
      data[offset + 4] = color.r;
      data[offset + 5] = color.g;
      data[offset + 6] = color.b;
      data[offset + 7] = 1;
    }

    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    texture.internalFormat = 'RGBA32F';
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    uniforms.uProfileBands.value = texture;
    uniforms.uProfileBandCount.value = bands.length;
    uniforms.uProfileTextureWidth.value = width;
    invalidate();

    return () => {
      uniforms.uProfileBands.value = null;
      uniforms.uProfileBandCount.value = 0;
      uniforms.uProfileTextureWidth.value = 1;
      texture.dispose();
      invalidate();
    };
  }, [bands, enabled, invalidate, maxTextureSize]);

  return (
    <ProfileColorContext.Provider value={enabled ? uniformsRef : null}>
      {children}
    </ProfileColorContext.Provider>
  );
}

export function useProfileColorUniformsRef(): ProfileColorUniformsRef | null {
  return React.useContext(ProfileColorContext);
}

export function ProfileMaterial(props: Omit<React.ComponentProps<typeof SoftClayMaterial>, 'profileColorUniformsRef'>) {
  const profileColorUniformsRef = useProfileColorUniformsRef();
  return <SoftClayMaterial {...props} profileColorUniformsRef={profileColorUniformsRef} />;
}

