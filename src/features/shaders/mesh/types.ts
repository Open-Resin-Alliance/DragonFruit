import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

export type MeshShaderType =
  | 'soft_clay'
  | 'flat_unlit'
  | 'matcap'
  | 'toon'
  | 'normal_debug'
  | 'wireframe'
  | 'opaque_wire_mesh'
  | 'xray'
  | 'overhang_heatmap';

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
  { value: 'soft_clay', label: msg({ message: 'Soft clay (lit)', comment: 'View mode: matte clay-like surface with scene lighting.' }) },
  { value: 'toon', label: msg({ message: 'Toon', comment: 'View mode: cel-shaded / cartoon look.' }) },
  { value: 'normal_debug', label: msg({ message: 'Normal (debug)', comment: 'View mode that colours the surface by its normal vector, for debugging. "Normal" is the geometry term, not the opposite of "unusual".' }) },
  { value: 'wireframe', label: msg({ message: 'Wireframe', comment: 'View mode: only the mesh edges are drawn.' }) },
  { value: 'opaque_wire_mesh', label: msg({ message: 'Opaque wire mesh', comment: 'View mode: mesh edges drawn over a solid surface, so back edges stay hidden.' }) },
  { value: 'xray', label: msg({ message: 'X-ray', comment: 'View mode: semi-transparent surface revealing the interior.' }) },
  { value: 'overhang_heatmap', label: msg({ message: 'Overhang heatmap', comment: 'View mode colouring surfaces by how steeply they overhang, which is where supports are needed.' }) },
];
