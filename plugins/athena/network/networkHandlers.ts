// Canonical complex-plugin network entrypoint used by generated registries.
//
// The underlying Athena implementation currently lives in `nanodlpHandlers.ts`.
// This file keeps the external plugin contract generic and vendor-agnostic.
export { handlePluginNetworkOperation, handleAthenaNetworkOperation } from './nanodlpHandlers';
