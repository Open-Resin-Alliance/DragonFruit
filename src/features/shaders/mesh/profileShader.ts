import type * as THREE from 'three';
import type * as React from 'react';

/** Shared by every profile material in one Canvas. Keep the boxes stable: three
 * retains these references after onBeforeCompile, including across table edits. */
export interface ProfileColorUniforms {
  uProfileBands: THREE.IUniform<THREE.DataTexture | null>;
  uProfileBandCount: THREE.IUniform<number>;
  uProfileTextureWidth: THREE.IUniform<number>;
}

export type ProfileColorUniformsRef = React.RefObject<ProfileColorUniforms | null>;

/** Decorates a standard-material shader without allocating a texture. Imperative
 * callers must use a profile-specific customProgramCacheKey and mark the material
 * needsUpdate when enabling/disabling the decorator. No provider means no tint. */
export function applyProfileColorShader(
  shader: Pick<THREE.WebGLProgramParametersWithUniforms, 'uniforms' | 'vertexShader' | 'fragmentShader'>,
  uniforms: ProfileColorUniforms,
): void {
  shader.uniforms.uProfileBands = uniforms.uProfileBands;
  shader.uniforms.uProfileBandCount = uniforms.uProfileBandCount;
  shader.uniforms.uProfileTextureWidth = uniforms.uProfileTextureWidth;

  shader.vertexShader = 'varying float vProfileWorldZ;\n' + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace(
    '#include <worldpos_vertex>',
    `
      #include <worldpos_vertex>
      // Unlike three's worldPosition, this is needed even without shadows/envmap.
      // transformed already includes morphing, skinning and displacement.
      vec4 profileWorldPosition = vec4(transformed, 1.0);
      #ifdef USE_BATCHING
        profileWorldPosition = batchingMatrix * profileWorldPosition;
      #endif
      #ifdef USE_INSTANCING
        profileWorldPosition = instanceMatrix * profileWorldPosition;
      #endif
      vProfileWorldZ = (modelMatrix * profileWorldPosition).z;
    `,
  );

  shader.fragmentShader = `
    varying float vProfileWorldZ;
    uniform highp sampler2D uProfileBands;
    uniform int uProfileBandCount;
    uniform int uProfileTextureWidth;

    vec4 profileTexel(int address) {
      return texelFetch(uProfileBands, ivec2(address % uProfileTextureWidth, address / uProfileTextureWidth), 0);
    }

    vec4 profileColorAtHeight(float z) {
      if (z < 0.0 || uProfileBandCount == 0) return vec4(0.0);
      // First band whose inclusive upper bound reaches z; then reject any gap.
      int first = 0;
      int end = uProfileBandCount;
      while (first < end) {
        int middle = first + (end - first) / 2;
        if (profileTexel(middle * 2).y < z) {
          first = middle + 1;
        } else {
          end = middle;
        }
      }
      if (first == uProfileBandCount) return vec4(0.0);
      vec2 bounds = profileTexel(first * 2).xy;
      if (z > bounds.x || (z == 0.0 && bounds.x == 0.0)) {
        return profileTexel(first * 2 + 1);
      }
      return vec4(0.0);
    }
  ` + shader.fragmentShader;

  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    `
      #include <color_fragment>
      vec4 profileColor = profileColorAtHeight(vProfileWorldZ);
      if (profileColor.a > 0.0) {
        diffuseColor.rgb = mix(diffuseColor.rgb, profileColor.rgb, 0.85);
      }
    `,
  );
}
