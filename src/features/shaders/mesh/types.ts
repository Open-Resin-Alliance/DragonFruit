import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

// Every type the app can render, as a runtime list as well as a type: stored
// values are validated against it, and deriving the union from the list keeps
// the two from drifting apart (they had: a stored heatmap mode fell back to the
// default because the validator knew five types out of nine).
export const MESH_SHADER_TYPES = [
  'soft_clay',
  'flat_unlit',
  'matcap',
  'normal_debug',
  'wireframe',
  'opaque_wire_mesh',
  'xray',
  'overhang_heatmap',
] as const;

export type MeshShaderType = (typeof MESH_SHADER_TYPES)[number];

export type MatcapVariant = 'neutral' | 'cool' | 'warm';

// Labels are message descriptors, not strings: this module is imported by both
// the View mode dropdown and the mesh settings tab, and neither can translate a
// bare string it did not author. Callers render them with `_(option.label)`.
export type MatcapOption = {
  value: MatcapVariant;
  label: MessageDescriptor;
};

export const MATCAP_OPTIONS: MatcapOption[] = [
  { value: 'neutral', label: msg({ message: 'Neutral', comment: 'Matcap lighting preset: neither warm nor cool.' }) },
  { value: 'cool', label: msg({ message: 'Cool', comment: 'Matcap lighting preset with a cool (blueish) tint.' }) },
  { value: 'warm', label: msg({ message: 'Warm', comment: 'Matcap lighting preset with a warm (orange) tint.' }) },
];

export type MeshShaderOption = {
  value: MeshShaderType;
  label: MessageDescriptor;
};

export const MESH_SHADER_OPTIONS: MeshShaderOption[] = [
  { value: 'soft_clay', label: msg({ message: 'Standard', comment: 'View mode: matte surface lit by the scene lights. The default view.' }) },
  { value: 'overhang_heatmap', label: msg({ message: 'Overhangs', comment: 'View mode colouring surfaces by how steeply they overhang, which is where supports are needed.' }) },
  { value: 'opaque_wire_mesh', label: msg({ message: 'Mesh', comment: 'View mode: mesh edges drawn over a solid surface, so back edges stay hidden.' }) },
  { value: 'wireframe', label: msg({ message: 'Wireframe', comment: 'View mode: only the mesh edges are drawn, so the surface between them shows through.' }) },
  { value: 'xray', label: msg({ message: 'X-Ray', comment: 'View mode: semi-transparent surface revealing the interior.' }) },
  { value: 'normal_debug', label: msg({ message: 'Normals', comment: 'View mode that colours the surface by its normal vector, for debugging. "Normal" is the geometry term, not the opposite of "unusual".' }) },
];
