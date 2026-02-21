// Main exports
export { SupportSidebar } from './SupportSidebar';

// Types
export type {
    SupportSettings,
    TipProfile,
    ShaftProfile,
    RootsProfile,
    BaseFlareProfile,
    JointProfile,
    GridSettings,
    MeshToMeshSettings,
    SupportPreset,
    PresetCollection,
} from './types';
export { createDefaultSettings } from './types';
export type { AutoBracingSettings, AutoBracingPattern } from '../autoBracing/settings';

// State
export {
    getSettings,
    getTipProfile,
    getShaftProfile,
    getRootsProfile,
    getBaseFlareProfile,
    getJointProfile,
    getGridSettings,
    getMeshToMeshSettings,
    getAutoBracingSettings,
    setSettings,
    updateTipProfile,
    updateShaftProfile,
    updateRootsProfile,
    updateBaseFlareProfile,
    updateJointProfile,
    updateGridSettings,
    updateMeshToMeshSettings,
    updateAutoBracingSettings,
    subscribeToSettings,
    getSettingsSnapshot,
} from './state';

// Presets
export {
    getActivePreset,
    getPresetList,
    getPresetById,
    setActivePreset,
    subscribeToPresets,
} from './presets';

// Components (for direct use if needed)
export * from './components';
