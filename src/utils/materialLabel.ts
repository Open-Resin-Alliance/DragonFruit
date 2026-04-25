export type MaterialLabelInput = {
  brand?: string | null;
  resinFamily?: string | null;
  name?: string | null;
};

export function formatResinFamilyLabel(resinFamily: string | null | undefined): string {
  const normalized = (resinFamily ?? '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'standard') return 'Standard';
  if (normalized === 'abs-like') return 'ABS-like';
  if (normalized === 'tough') return 'Tough';
  if (normalized === 'flexible') return 'Flexible';
  if (normalized === 'engineering') return 'Engineering';
  if (normalized === 'other') return 'Other';
  return normalized;
}

function tokenizeWords(value: string): string[] {
  return value
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function appendWithWordOverlap(currentLabel: string, nextPart: string): string {
  const current = currentLabel.trim();
  const incoming = nextPart.trim();
  if (!incoming) return current;
  if (!current) return incoming;

  if (current.toLowerCase() === incoming.toLowerCase()) return current;

  const currentWords = tokenizeWords(current);
  const incomingWords = tokenizeWords(incoming);

  if (currentWords.length === 0) return incoming;
  if (incomingWords.length === 0) return current;

  const maxOverlap = Math.min(currentWords.length, incomingWords.length);
  for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
    let matches = true;
    for (let i = 0; i < overlap; i += 1) {
      const leftWord = currentWords[currentWords.length - overlap + i]?.toLowerCase();
      const rightWord = incomingWords[i]?.toLowerCase();
      if (leftWord !== rightWord) {
        matches = false;
        break;
      }
    }

    if (matches) {
      const remainder = incomingWords.slice(overlap).join(' ');
      return remainder ? `${current} ${remainder}` : current;
    }
  }

  return `${current} ${incoming}`;
}

export function resolveCompositeMaterialLabel(material: MaterialLabelInput | null | undefined): string | null {
  if (!material) return null;

  const brand = (material.brand ?? '').trim();
  const resinFamilyLabel = formatResinFamilyLabel(material.resinFamily);
  const name = (material.name ?? '').trim();

  let label = '';
  if (brand) {
    label = appendWithWordOverlap(label, brand);
  }
  if (resinFamilyLabel) {
    label = appendWithWordOverlap(label, resinFamilyLabel);
  }
  if (name) {
    label = appendWithWordOverlap(label, name);
  }

  const normalized = label.trim();
  return normalized.length > 0 ? normalized : null;
}
