import { promises as fs } from 'node:fs';
import path from 'node:path';

const docsDir = path.resolve('docs');
const placeholderRoot = path.join(docsDir, 'assets', 'placeholders');
const markdownLinkPattern = /(?:\.\.\/)+assets\/placeholders\/([^\s)>"']+)/g;

const transparentPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Y3W0AAAAASUVORK5CYII=';

async function collectMarkdownFiles(rootDir) {
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

function placeholderSvgLabel(relativePath) {
  const baseName = path.basename(relativePath, path.extname(relativePath));
  return baseName.replace(/[-_]/g, ' ');
}

function createPlaceholderSvg(relativePath) {
  const label = placeholderSvgLabel(relativePath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540" role="img" aria-label="${label}">
  <rect width="960" height="540" fill="#111216"/>
  <rect x="24" y="24" width="912" height="492" rx="28" fill="none" stroke="#2b2f38" stroke-width="4" stroke-dasharray="16 14"/>
  <text x="480" y="250" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" fill="#f2f4f8">${label}</text>
  <text x="480" y="300" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#aeb5c2">Placeholder image</text>
</svg>
`;
}

async function main() {
  const markdownFiles = await collectMarkdownFiles(docsDir);
  const referencedPlaceholders = new Set();

  for (const filePath of markdownFiles) {
    const content = await fs.readFile(filePath, 'utf8');
    for (const match of content.matchAll(markdownLinkPattern)) {
      referencedPlaceholders.add(match[1]);
    }
  }

  const created = [];

  for (const relativePath of referencedPlaceholders) {
    const targetPath = path.join(placeholderRoot, relativePath);
    const ext = path.extname(targetPath).toLowerCase();

    try {
      await fs.access(targetPath);
      continue;
    } catch {
      // Fall through and create the placeholder.
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    if (ext === '.svg') {
      await fs.writeFile(targetPath, createPlaceholderSvg(relativePath));
    } else if (ext === '.png') {
      await fs.writeFile(targetPath, Buffer.from(transparentPngBase64, 'base64'));
    } else {
      throw new Error(
        `Unsupported placeholder asset extension '${ext}' for ${path.relative(docsDir, targetPath)}`,
      );
    }

    created.push(path.relative(docsDir, targetPath));
  }

  if (created.length > 0) {
    console.log(`Created ${created.length} placeholder asset(s):`);
    for (const filePath of created) {
      console.log(`- ${filePath}`);
    }
  } else {
    console.log('No missing placeholder assets found.');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
