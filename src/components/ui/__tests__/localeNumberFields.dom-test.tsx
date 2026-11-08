import assert from 'node:assert/strict';
import test from 'node:test';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { NumberInput } from '../NumberInput';
import { ScrollableNumberField } from '../scrollableNumberField';

/** Types `text` into `input` the way React sees a keystroke. */
async function type(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function mountInSpanish(render: (onChange: (value: number) => void) => React.ReactNode) {
  const i18n = setupI18n({ locale: 'es', messages: { es: {} } });
  const changes: number[] = [];
  function Field() {
    const [, setValue] = useState(0);
    return render((value) => {
      changes.push(value);
      setValue(value);
    });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<I18nProvider i18n={i18n}><Field /></I18nProvider>);
  });
  const input = container.querySelector('input');
  assert.ok(input);
  return {
    input,
    changes,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test('NumberInput shows and reads the locale decimal comma', async () => {
  const field = await mountInSpanish((onChange) => <NumberInput value={0.5} onChange={onChange} />);
  try {
    assert.equal(field.input.value, '0,5');
    await type(field.input, '1,25');
    assert.deepEqual(field.changes, [1.25]);
    await type(field.input, '1.5');
    assert.deepEqual(field.changes, [1.25, 1.5], 'a dot still reads as the decimal point');
    await type(field.input, '1,2,3');
    assert.equal(field.input.value, '1.5', 'a second separator is refused');
    await type(field.input, '-');
    assert.equal(field.input.value, '-', 'the way to a negative number is open');
    assert.deepEqual(field.changes, [1.25, 1.5], 'but is no number yet');
  } finally {
    await field.unmount();
  }
});

test('ScrollableNumberField shows and reads the locale decimal comma', async () => {
  const field = await mountInSpanish((onChange) => (
    // i18n-ignore: test fixture
    <ScrollableNumberField value={0.05} onChange={onChange} min={0} max={10} step={0.01} ariaLabel="Exposure" />
  ));
  try {
    assert.equal(field.input.value, '0,05');
    await type(field.input, '0,1');
    assert.deepEqual(field.changes, [0.1]);
    await act(async () => {
      field.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    assert.equal(field.changes.at(-1), 0.11, 'the arrow keys still step it');
    assert.equal(field.input.value, '0,11');
    await type(field.input, '');
    assert.equal(field.changes.length, 2, 'an emptied field is no zero');
  } finally {
    await field.unmount();
  }
});

function PrecisionField({ report, decimalPlaces }: { report(value: number): void; decimalPlaces?: number }) {
  const [value, setValue] = useState(0.075);
  return (
    <NumberInput
      value={value}
      min={0}
      step={0.001}
      decimalPlaces={decimalPlaces}
      onChange={(next) => {
        report(next);
        setValue(next);
      }}
    />
  );
}

test('NumberInput precision supports locale editing, blur, stepping and wheel without losing six-digit mm endpoints', async () => {
  const field = await mountInSpanish((report) => <PrecisionField report={report} decimalPlaces={6} />);
  try {
    assert.equal(field.input.value, '0,075');
    assert.equal(field.input.hasAttribute('decimalPlaces'), false, 'precision is not an input DOM attribute');
    await act(async () => field.input.focus());
    await type(field.input, '0,075123');
    assert.equal(field.changes.at(-1), 0.075123);
    await type(field.input, '0,0751234');
    assert.equal(field.input.value, '0,075123', 'digits beyond six are refused');
    await act(async () => field.input.blur());
    assert.equal(field.input.value, '0,075123', 'blur formats the committed value at the requested precision');
    const increase = [...(field.input.parentElement?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find((button) => button.getAttribute('aria-label') === 'Increase value');
    assert.ok(increase);
    await act(async () => increase.click());
    assert.equal(field.changes.at(-1), 0.076123);
    assert.equal(field.input.value, '0,076123');
    await act(async () => {
      field.input.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true }));
    });
    assert.equal(field.changes.at(-1), 0.075123);
    assert.equal(field.input.value, '0,075123');
    await type(field.input, '0.123456');
    assert.equal(field.changes.at(-1), 0.123456, 'dot remains accepted at extended precision');
  } finally {
    await field.unmount();
  }
});

test('NumberInput retains two-decimal default consumers and bounds the optional precision to zero through six', async () => {
  const legacy = await mountInSpanish((report) => <PrecisionField report={report} />);
  try {
    assert.equal(legacy.input.value, '0,07');
    await type(legacy.input, '1,25');
    assert.deepEqual(legacy.changes, [1.25]);
    await type(legacy.input, '1,251');
    assert.deepEqual(legacy.changes, [1.25], 'default consumers still accept only two fractional digits');
    assert.equal(legacy.input.value, '1,25');
  } finally {
    await legacy.unmount();
  }
  for (const precision of [-2, 20]) {
    const field = await mountInSpanish((report) => <PrecisionField report={report} decimalPlaces={precision} />);
    try {
      await type(field.input, precision < 0 ? '4' : '0,123456');
      assert.equal(field.changes.at(-1), precision < 0 ? 4 : 0.123456);
      await type(field.input, precision < 0 ? '4,1' : '0,1234567');
      assert.equal(field.changes.length, 1, 'out-of-range precision is bounded rather than opening extra digits');
    } finally {
      await field.unmount();
    }
  }
});
