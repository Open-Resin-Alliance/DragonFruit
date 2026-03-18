import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const srcRoot = path.join(projectRoot, 'src');

const ALLOWED_CORE_IMPORT_SEAMS = new Set([
      path.normalize('src/features/plugins/pluginRegistry.ts'),
      path.normalize('src/features/plugins/networkPluginRegistry.ts'),
      path.normalize('src/features/slicing/formats/registry.ts'),
      path.normalize('src/features/plugins/builtinComplexPlugins.ts'),
      path.normalize('src/features/plugins/builtinComplexPluginNetworkHandlers.ts'),
      path.normalize('src/features/plugins/builtinComplexPluginUploadHandlers.ts'),
      path.normalize('src/features/plugins/pluginUploadBridge.ts'),
]);

const IMPORT_RE = /from\s+['"][^'"]*plugins\/athena\//g;

async function* walk(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                  yield* walk(fullPath);
                  continue;
            }
            yield fullPath;
      }
}

async function main() {
      const violations = [];

      for await (const filePath of walk(srcRoot)) {
            if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) continue;

            const relativePath = path.normalize(path.relative(projectRoot, filePath));
            const file = await fs.readFile(filePath, 'utf8');

            if (!IMPORT_RE.test(file)) continue;
            if (ALLOWED_CORE_IMPORT_SEAMS.has(relativePath)) continue;

            violations.push(relativePath);
      }

      if (violations.length === 0) {
            console.log('[plugin-boundary] OK: no new direct athena plugin imports in core src files.');
            return;
      }

      console.error('[plugin-boundary] Found disallowed direct plugin imports:');
      for (const item of violations) {
            console.error(`  - ${item}`);
      }
      console.error('Allowed seams are limited to registry integration files only.');
      process.exit(1);
}

main().catch((error) => {
      console.error('[plugin-boundary] Failed to run check:', error);
      process.exit(1);
});
