import assert from 'node:assert/strict';
import test from 'node:test';
import { act, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';
import { formatFileSize } from '@/utils/meshStatsFormatting';

// Compiled by the React Compiler under test:dom, as in the app. The compiler
// caches these on `fmt`, so they only follow a locale switch if `fmt` changes.
function Readout({ bytes }: { bytes: number }) {
  const fmt = useLocaleFormat();
  const size = useMemo(() => formatFileSize(bytes, fmt), [bytes, fmt]);
  return <span>{fmt.fixed(1234.5, 1)} | {size}</span>;
}

test('useLocaleFormat output follows a locale switch', async () => {
  const i18n = setupI18n({ locale: 'en', messages: { en: {}, es: {} } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<I18nProvider i18n={i18n}><Readout bytes={1536} /></I18nProvider>);
  });
  assert.equal(container.textContent, '1,234.5 | 1.5 KB');

  await act(async () => i18n.activate('es'));
  assert.equal(container.textContent, '1234,5 | 1,5 KB');

  await act(async () => root.unmount());
  container.remove();
});
