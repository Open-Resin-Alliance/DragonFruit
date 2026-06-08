import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const allowlistPath = path.join(repoRoot, 'src', 'config', 'complex-plugin-allowlist.json');

function isSorted(values) {
      const sorted = [...values].sort((a, b) => a.localeCompare(b));
      return sorted.every((value, index) => value === values[index]);
}

async function main() {
      const raw = await fs.readFile(allowlistPath, 'utf8');
      const parsed = JSON.parse(raw);

      if (!Number.isInteger(parsed?.version) || parsed.version < 1) {
            throw new Error('[allowlist-check] "version" must be a positive integer');
      }

      const entries = Array.isArray(parsed?.builtinComplexPlugins) ? parsed.builtinComplexPlugins : [];
      if (entries.length === 0) {
            throw new Error('[allowlist-check] "builtinComplexPlugins" must contain at least one plugin id');
      }

      const ids = entries.map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : ''));

      for (const id of ids) {
            if (!id) throw new Error('[allowlist-check] Plugin id cannot be empty');
            if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
                  throw new Error(`[allowlist-check] Plugin id "${id}" must match ^[a-z0-9][a-z0-9-]*$`);
            }
      }

      const unique = new Set(ids);
      if (unique.size !== ids.length) {
            throw new Error('[allowlist-check] Duplicate plugin id(s) found in allowlist');
      }

      // No lexicographic order required

      console.log(`[allowlist-check] OK (${ids.length} plugin id(s))`);
}

main().catch((error) => {
      console.error('[allowlist-check] Failed.', error);
      process.exitCode = 1;
});
