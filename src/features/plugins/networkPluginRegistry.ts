import { handleAthenaNetworkOperation } from '../../../plugins/athena/network/nanodlpHandlers';

/**
 * Shape returned by plugin-owned network handlers.
 *
 * Handlers return a normalized HTTP status + JSON body pair so route handlers
 * can remain thin transport adapters.
 */
export type PluginNetworkHandlerResult = {
  status: number;
  body: unknown;
};

/**
 * Generic function contract for plugin network operations.
 *
 * @param operationPath Path segments after plugin ID, e.g. `['nanodlp','connect']`.
 * @param payload Request JSON payload excluding route metadata.
 */
export type PluginNetworkOperationHandler = (
  operationPath: string[],
  payload: unknown,
) => Promise<PluginNetworkHandlerResult>;

const networkHandlersByPluginId = new Map<string, PluginNetworkOperationHandler>();
let builtinsRegistered = false;

/**
 * Register a plugin network handler.
 *
 * Plugins can call this at startup/initialization time. Re-registering the same
 * plugin ID replaces the previous handler.
 */
export function registerNetworkPluginHandler(
  pluginId: string,
  handler: PluginNetworkOperationHandler,
): void {
  const id = pluginId.trim().toLowerCase();
  if (!id) throw new Error('pluginId is required');
  networkHandlersByPluginId.set(id, handler);
}

/**
 * Register built-in plugin network handlers once per runtime.
 *
 * This keeps API route code generic while still allowing built-in plugins to
 * participate without separate bootstrap wiring.
 */
function ensureBuiltinNetworkPluginsRegistered(): void {
  if (builtinsRegistered) return;
  builtinsRegistered = true;

  registerNetworkPluginHandler('athena', handleAthenaNetworkOperation);
}

/**
 * Resolve a handler for a plugin ID, ensuring built-ins are registered first.
 */
export function getNetworkPluginHandler(pluginId: string): PluginNetworkOperationHandler | null {
  ensureBuiltinNetworkPluginsRegistered();
  return networkHandlersByPluginId.get(pluginId.trim().toLowerCase()) ?? null;
}