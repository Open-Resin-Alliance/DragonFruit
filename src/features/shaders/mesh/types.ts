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

export type MatcapOption = {
  value: MatcapVariant;
  label: string;
};

export const MATCAP_OPTIONS: MatcapOption[] = [
  { value: 'neutral', label: 'Neutral' },
  { value: 'cool', label: 'Cool' },
  { value: 'warm', label: 'Warm' },
];

export type MeshShaderOption = {
  value: MeshShaderType;
  label: string;
};

export const MESH_SHADER_OPTIONS: MeshShaderOption[] = [
  { value: 'soft_clay', label: 'Soft Clay (Lit)' },
  { value: 'toon', label: 'Toon' },
  { value: 'normal_debug', label: 'Normal (Debug)' },
  { value: 'wireframe', label: 'Wireframe' },
  { value: 'opaque_wire_mesh', label: 'Opaque Wire Mesh' },
  { value: 'xray', label: 'X-ray' },
  { value: 'overhang_heatmap', label: 'Overhang Heatmap' },
];
