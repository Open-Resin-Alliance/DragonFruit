export type DeleteHandler = () => void;

interface DeleteRegistryEntry {
  getCanDelete: () => boolean;
  performDelete: DeleteHandler;
  priority: number;
}

const registry = new Set<DeleteRegistryEntry>();

export function registerDeleteHandler(
  getCanDelete: () => boolean,
  performDelete: DeleteHandler,
  priority = 0,
) {
  const entry: DeleteRegistryEntry = { getCanDelete, performDelete, priority };
  registry.add(entry);
  return () => registry.delete(entry);
}

export function getActiveDeleteHandler(): DeleteHandler | null {
  let winner: DeleteRegistryEntry | null = null;
  for (const entry of registry) {
    if (!entry.getCanDelete()) continue;
    if (!winner || entry.priority > winner.priority) {
      winner = entry;
    }
  }
  return winner?.performDelete ?? null;
}

export function triggerDelete() {
  const handler = getActiveDeleteHandler();
  if (!handler) return false;
  handler();
  return true;
}
