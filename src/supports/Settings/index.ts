// This barrel must stay free of React components. Engine modules and the
// plugin submodules import it for `getSettings` / `createDefaultSettings` /
// `SupportSettings`, and the unit tests run under tsx with no Lingui macro
// transform — re-exporting the sidebar dragged the whole (translated) settings
// UI into those import graphs and blew the suite up. Import components from
// their own module: `@/supports/Settings/SupportSidebar`, `.../components`.

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
