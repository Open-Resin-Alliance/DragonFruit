/**
 * Shared GPU-instanced shader source for the hollow-voxel cube-edge
 * wireframe overlay (`HollowVoxelPreview.tsx`, `HollowVoxelEditOverlay.tsx`).
 *
 * `instanceTransform` is fed the exact same per-voxel matrix buffer already
 * built for the cube `InstancedMesh` in each file -- reusing that buffer
 * directly means the edge overlay costs zero additional per-voxel memory
 * beyond the shared 24-vertex cube-edge template, instead of the previous
 * fully-expanded 288-bytes/voxel world-space position buffer.
 *
 * Deliberately named `instanceTransform`, not `instanceMatrix`: three.js
 * only auto-injects its reserved `instanceMatrix` attribute handling for
 * objects with `isInstancedMesh === true` (see `WebGLPrograms.js`), which a
 * `THREE.LineSegments` never is. The actual instanced-draw machinery
 * (vertexAttribDivisor, mat4-attribute location splitting) is keyed on the
 * geometry side (`InstancedBufferGeometry`/`InstancedBufferAttribute`), not
 * the object type, so a self-contained attribute name here is correct and
 * avoids any ambiguity with three's built-in instancing path.
 *
 * `toneMapping()`/`linearToOutputTexel()` and the `TONE_MAPPING` define are
 * auto-provided by the renderer for any non-RawShaderMaterial with tone
 * mapping enabled (verified against `WebGLProgram.js` in this three.js
 * version) -- they must be called here for the edge color to visually match
 * the rest of the tonemapped/color-managed scene, but nothing else needs to
 * be declared for them to exist.
 */

export const INSTANCED_EDGE_VERTEX_SHADER = /* glsl */ `
attribute mat4 instanceTransform;

void main() {
  vec4 localPos = instanceTransform * vec4(position, 1.0);
  vec4 mvPosition = modelViewMatrix * localPos;
  gl_Position = projectionMatrix * mvPosition;
}
`;

export const INSTANCED_EDGE_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;

void main() {
  gl_FragColor = vec4(uColor, uOpacity);
  #if defined( TONE_MAPPING )
    gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
  #endif
  gl_FragColor = linearToOutputTexel( gl_FragColor );
}
`;
