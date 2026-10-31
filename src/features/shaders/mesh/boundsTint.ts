import * as THREE from 'three';

/** Live uniforms: boundary crossings change values, never the shader variant. */
export function createBoundsTintUniforms() {
  return {
    uBoundsTintEnabled: { value: 0 },
    uBoundsTintMin: { value: new THREE.Vector3() },
    uBoundsTintMax: { value: new THREE.Vector3() },
    uBoundsTintColor: { value: new THREE.Color('#b6ff2e') },
  };
}

export type BoundsTintUniforms = ReturnType<typeof createBoundsTintUniforms>;

/** MeshStandardMaterial only; call after other onBeforeCompile modifications. */
export function applyBoundsTint(
  shader: Pick<Parameters<THREE.Material['onBeforeCompile']>[0], 'vertexShader' | 'fragmentShader' | 'uniforms'>,
  uniforms: BoundsTintUniforms,
): void {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = 'varying vec3 vBoundsTintWorldPosition;\n' + shader.vertexShader.replace(
    '#include <project_vertex>',
    `#include <project_vertex>
    vBoundsTintWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
  );
  shader.fragmentShader = `
    varying vec3 vBoundsTintWorldPosition;
    uniform float uBoundsTintEnabled;
    uniform vec3 uBoundsTintMin;
    uniform vec3 uBoundsTintMax;
    uniform vec3 uBoundsTintColor;
  ` + shader.fragmentShader.replace(
    '#include <dithering_fragment>',
    `#include <dithering_fragment>
    if (uBoundsTintEnabled > 0.5) {
      bool boundsTintOutside =
        vBoundsTintWorldPosition.x < uBoundsTintMin.x || vBoundsTintWorldPosition.x > uBoundsTintMax.x ||
        vBoundsTintWorldPosition.y < uBoundsTintMin.y || vBoundsTintWorldPosition.y > uBoundsTintMax.y ||
        vBoundsTintWorldPosition.z < uBoundsTintMin.z || vBoundsTintWorldPosition.z > uBoundsTintMax.z;
      if (boundsTintOutside) {
        float boundsTintSeed = (vBoundsTintWorldPosition.x + vBoundsTintWorldPosition.y + vBoundsTintWorldPosition.z) * 0.22;
        float boundsTintBand = step(0.5, fract(boundsTintSeed));
        vec3 boundsTintStripe = mix(uBoundsTintColor, vec3(1.0), boundsTintBand);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, boundsTintStripe, 0.42);
      }
    }`,
  );
}
