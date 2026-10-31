import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { SupportInstanceBatch } from '../supportInstanceBatch';

/** The indexed unit shape every batch draws, one per test so none shares state. */
function unitShape(): THREE.BufferGeometry {
    return new THREE.BoxGeometry(1, 1, 1);
}

function matrixArray(batch: SupportInstanceBatch): Float32Array {
    return (batch.geometry.getAttribute('instanceMatrix') as THREE.InstancedBufferAttribute)
        .array as Float32Array;
}

function ratioArray(batch: SupportInstanceBatch): Float32Array {
    return (batch.geometry.getAttribute('iRatio') as THREE.InstancedBufferAttribute)
        .array as Float32Array;
}

function dataArray(batch: SupportInstanceBatch): Uint32Array {
    return (batch.geometry.getAttribute('iData') as THREE.InstancedBufferAttribute)
        .array as Uint32Array;
}

function pickArray(batch: SupportInstanceBatch): Uint32Array {
    return (batch.geometry.getAttribute('iPick') as THREE.InstancedBufferAttribute)
        .array as Uint32Array;
}

function colorArray(batch: SupportInstanceBatch): Float32Array {
    return (batch.geometry.getAttribute('color') as THREE.InstancedBufferAttribute)
        .array as Float32Array;
}

function slotMatrix(batch: SupportInstanceBatch, index: number): number[] {
    return Array.from(matrixArray(batch).subarray(index * 16, index * 16 + 16));
}

function translation(x: number, y: number, z: number): THREE.Matrix4 {
    return new THREE.Matrix4().makeTranslation(x, y, z);
}

test('a batch starts empty, on its own copy of the base shape', () => {
    const base = unitShape();
    const batch = new SupportInstanceBatch(base, 2);

    assert.ok(batch.geometry instanceof THREE.InstancedBufferGeometry);
    assert.equal(batch.count, 0);
    assert.equal(batch.capacity, 2);
    assert.equal(batch.geometry.instanceCount, 0);

    const position = batch.geometry.getAttribute('position') as THREE.BufferAttribute;
    assert.notEqual(position, base.getAttribute('position'), 'the batch owns its vertices');
    assert.deepEqual(Array.from(position.array), Array.from((base.getAttribute('position') as THREE.BufferAttribute).array));
    assert.deepEqual(
        Array.from((batch.geometry.getAttribute('normal') as THREE.BufferAttribute).array),
        Array.from((base.getAttribute('normal') as THREE.BufferAttribute).array),
    );
    assert.notEqual(batch.geometry.getIndex(), base.getIndex(), 'the batch owns its index');
    assert.equal(batch.geometry.getIndex()?.count, base.getIndex()?.count);

    const matrix = batch.geometry.getAttribute('instanceMatrix') as THREE.InstancedBufferAttribute;
    const ratio = batch.geometry.getAttribute('iRatio') as THREE.InstancedBufferAttribute;
    const data = batch.geometry.getAttribute('iData') as THREE.InstancedBufferAttribute;
    const pick = batch.geometry.getAttribute('iPick') as THREE.InstancedBufferAttribute;
    assert.equal(matrix.itemSize, 16);
    assert.equal(matrix.count, 2, 'the matrix buffer holds a slot per capacity');
    assert.ok(matrix.array instanceof Float32Array);
    assert.equal(ratio.itemSize, 1);
    assert.ok(ratio.array instanceof Float32Array);
    assert.ok(data.array instanceof Uint32Array, 'iData is a packed uint32');
    assert.ok(pick.array instanceof Uint32Array, 'iPick is a uint32 id');
    assert.equal(data.count, 2);
    assert.equal(pick.count, 2);

    const color = batch.geometry.getAttribute('color') as THREE.InstancedBufferAttribute;
    assert.equal(color.itemSize, 3);
    assert.equal(color.count, 2);
    assert.deepEqual(Array.from(colorArray(batch)), [1, 1, 1, 1, 1, 1], 'every slot starts white');
    assert.equal(matrix.usage, THREE.DynamicDrawUsage, 'instances are rewritten in place');
});

test('append writes the instance, and count follows geometry.instanceCount', () => {
    const batch = new SupportInstanceBatch(unitShape(), 2);
    const first = translation(1, 2, 3);
    const second = translation(4, 5, 6);

    assert.equal(batch.append(first, 1.5, 0b0101, 7), 0);
    assert.equal(batch.append(second, 2, 0, 9), 1);

    assert.equal(batch.count, 2);
    assert.equal(batch.geometry.instanceCount, 2);
    assert.deepEqual(slotMatrix(batch, 0), first.toArray());
    assert.deepEqual(slotMatrix(batch, 1), second.toArray());
    assert.equal(ratioArray(batch)[0], 1.5);
    assert.equal(ratioArray(batch)[1], 2);
    assert.equal(dataArray(batch)[0], 5);
    assert.equal(pickArray(batch)[0], 7);
    assert.equal(pickArray(batch)[1], 9);
});

test('setters rewrite one live instance without touching the others', () => {
    const batch = new SupportInstanceBatch(unitShape(), 2);
    batch.append(translation(0, 0, 0), 1, 1, 10);
    batch.append(translation(1, 0, 0), 1, 2, 11);

    batch.setMatrix(1, translation(9, 8, 7));
    batch.setRatio(1, 3.5);
    batch.setData(1, 0xff);
    batch.setPick(1, 12);
    batch.setColor(1, 0.25, 0.5, 0.75);

    assert.deepEqual(slotMatrix(batch, 0), translation(0, 0, 0).toArray(), 'the other slot keeps its matrix');
    assert.deepEqual(slotMatrix(batch, 1), translation(9, 8, 7).toArray());
    assert.equal(ratioArray(batch)[0], 1);
    assert.equal(ratioArray(batch)[1], 3.5);
    assert.equal(dataArray(batch)[0], 1);
    assert.equal(dataArray(batch)[1], 0xff);
    assert.equal(pickArray(batch)[0], 10);
    assert.equal(pickArray(batch)[1], 12);
    assert.deepEqual(Array.from(colorArray(batch).subarray(0, 3)), [1, 1, 1], 'the other slot keeps white');
    assert.deepEqual(Array.from(colorArray(batch).subarray(3, 6)), [0.25, 0.5, 0.75]);
});

test('a packed write is coerced to uint32', () => {
    const batch = new SupportInstanceBatch(unitShape(), 1);
    batch.append(translation(0, 0, 0), 1, -1, 0x1_0000_0001);

    assert.equal(dataArray(batch)[0], 0xffff_ffff);
    assert.equal(pickArray(batch)[0], 1);
});

test('removeAt swaps the last instance into the hole and reports where it came from', () => {
    const batch = new SupportInstanceBatch(unitShape(), 3);
    batch.append(translation(0, 0, 0), 1, 100, 10);
    batch.append(translation(1, 0, 0), 2, 101, 11);
    batch.append(translation(2, 0, 0), 3, 102, 12);
    batch.setColor(2, 0.25, 0.5, 0.75);

    assert.equal(batch.removeAt(0), 2, 'the last instance moved from slot 2');
    assert.equal(batch.count, 2);
    assert.equal(batch.geometry.instanceCount, 2);
    assert.equal(pickArray(batch)[0], 12, 'slot 0 now holds the last instance');
    assert.equal(dataArray(batch)[0], 102);
    assert.equal(ratioArray(batch)[0], 3);
    assert.deepEqual(Array.from(colorArray(batch).subarray(0, 3)), [0.25, 0.5, 0.75], 'the tint follows its instance');
    assert.deepEqual(slotMatrix(batch, 0), translation(2, 0, 0).toArray());
    assert.equal(pickArray(batch)[1], 11, 'the middle instance did not move');

    batch.append(translation(3, 0, 0), 4, 103, 13);
    assert.deepEqual(Array.from(colorArray(batch).subarray(6, 9)), [1, 1, 1], 'a reused slot starts white');
    assert.deepEqual(Array.from(colorArray(batch).subarray(0, 3)), [0.25, 0.5, 0.75], 'and the moved tint stays put');
});

test('removing the last instance reports no move', () => {
    const batch = new SupportInstanceBatch(unitShape(), 3);
    batch.append(translation(0, 0, 0), 1, 0, 10);
    batch.append(translation(1, 0, 0), 1, 0, 11);

    assert.equal(batch.removeAt(1), null);
    assert.equal(batch.count, 1);
    assert.equal(batch.geometry.instanceCount, 1);
    assert.equal(pickArray(batch)[0], 10);

    assert.equal(batch.removeAt(0), null);
    assert.equal(batch.count, 0);
    assert.equal(batch.geometry.instanceCount, 0);
});

test('growth doubles the capacity and keeps every earlier instance', () => {
    const batch = new SupportInstanceBatch(unitShape(), 2);
    assert.equal(batch.append(translation(0, 0, 0), 1, 1, 20), 0);
    assert.equal(batch.append(translation(1, 0, 0), 2, 2, 21), 1);
    batch.setColor(0, 0.5, 0.25, 0.75);
    batch.setColor(1, 0.125, 0.375, 0.625);
    assert.equal(batch.append(translation(2, 0, 0), 3, 3, 22), 2, 'the third append grows the batch');

    assert.equal(batch.capacity, 4, 'two slots double to four');
    assert.equal(batch.count, 3);
    assert.equal(batch.geometry.instanceCount, 3);
    assert.equal(matrixArray(batch).length, 4 * 16);
    assert.equal(ratioArray(batch).length, 4);
    assert.equal(dataArray(batch).length, 4);
    assert.equal(pickArray(batch).length, 4);
    assert.equal(colorArray(batch).length, 4 * 3);
    assert.equal(
        (batch.geometry.getAttribute('iPick') as THREE.InstancedBufferAttribute).array,
        pickArray(batch),
        'the grown attributes are the ones on the geometry',
    );
    assert.deepEqual(
        Array.from(colorArray(batch)),
        [0.5, 0.25, 0.75, 0.125, 0.375, 0.625, 1, 1, 1, 1, 1, 1],
        'the tints move with their instances and the new slots start white',
    );

    for (let slot = 0; slot < 3; slot += 1) {
        assert.equal(pickArray(batch)[slot], 20 + slot);
        assert.equal(dataArray(batch)[slot], 1 + slot);
        assert.equal(ratioArray(batch)[slot], 1 + slot);
        assert.deepEqual(slotMatrix(batch, slot), translation(slot, 0, 0).toArray());
    }

    batch.append(translation(3, 0, 0), 4, 4, 23);
    assert.equal(batch.capacity, 4, 'a full batch of four still has a free slot');
    batch.setColor(3, 0.75, 0.5, 0.25);
    batch.append(translation(4, 0, 0), 5, 5, 24);
    assert.equal(batch.capacity, 8, 'the next append doubles again');
    assert.equal(batch.count, 5);
    assert.equal(pickArray(batch)[0], 20, 'growth never reorders the live range');
    assert.equal(pickArray(batch)[4], 24);
    assert.deepEqual(Array.from(colorArray(batch).subarray(0, 3)), [0.5, 0.25, 0.75]);
    assert.deepEqual(Array.from(colorArray(batch).subarray(9, 12)), [0.75, 0.5, 0.25]);
});

test('flush uploads each changed attribute once and leaves untouched ones alone', () => {
    const batch = new SupportInstanceBatch(unitShape(), 2);
    batch.append(translation(0, 0, 0), 1, 0, 0);
    batch.flush();

    const matrix = batch.geometry.getAttribute('instanceMatrix') as THREE.InstancedBufferAttribute;
    const ratio = batch.geometry.getAttribute('iRatio') as THREE.InstancedBufferAttribute;
    const color = batch.geometry.getAttribute('color') as THREE.InstancedBufferAttribute;
    const matrixVersion = matrix.version;
    const ratioVersion = ratio.version;
    const colorVersion = color.version;

    batch.setRatio(0, 2);
    batch.flush();

    assert.equal(ratio.version, ratioVersion + 1);
    assert.equal(matrix.version, matrixVersion, 'an untouched attribute is not re-sent');
    assert.equal(color.version, colorVersion, 'an untouched tint is not re-sent');

    batch.flush();
    assert.equal(ratio.version, ratioVersion + 1, 'a second flush with no writes uploads nothing');

    batch.setColor(0, 0.2, 0.4, 0.6);
    batch.flush();
    assert.equal(color.version, colorVersion + 1, 'the tint write is sent on the next flush');
    assert.equal(ratio.version, ratioVersion + 1, 'and the ratio is not sent again');

    batch.setPick(0, 5);
    batch.flush();
    const pick = batch.geometry.getAttribute('iPick') as THREE.InstancedBufferAttribute;
    assert.equal(pick.version, 2, 'the pick write is sent on the next flush');
});

test('an index outside the live range is rejected', () => {
    const batch = new SupportInstanceBatch(unitShape(), 2);

    assert.throws(() => batch.setPick(0, 1), RangeError, 'no live instance to write');
    assert.throws(() => batch.setColor(0, 1, 1, 1), RangeError, 'no live instance to tint');
    assert.throws(() => batch.removeAt(0), RangeError);
    assert.throws(() => batch.setRatio(-1, 1), RangeError);

    batch.append(translation(0, 0, 0), 1, 0, 0);
    assert.throws(
        () => batch.setMatrix(1, translation(0, 0, 0)),
        RangeError,
        'inside the capacity but past count',
    );
    assert.throws(() => batch.setData(0.5, 1), RangeError);
    assert.throws(() => batch.setColor(1, 1, 1, 1), RangeError, 'past count even inside the capacity');
});

test('resizeTo grows from the end, keeping the instances already written', () => {
    const batch = new SupportInstanceBatch(unitShape(), 1);
    batch.append(translation(5, 0, 0), 1, 7, 3);
    batch.setColor(0, 0.25, 0.5, 0.75);

    batch.resizeTo(3, 42, 0.5);

    assert.equal(batch.count, 3);
    assert.equal(batch.geometry.instanceCount, 3);
    assert.deepEqual(slotMatrix(batch, 0), translation(5, 0, 0).toArray());
    assert.deepEqual(Array.from(colorArray(batch).subarray(0, 3)), [0.25, 0.5, 0.75]);
    for (let slot = 1; slot < 3; slot += 1) {
        assert.deepEqual(slotMatrix(batch, slot), new THREE.Matrix4().toArray(), 'new instances start at the identity');
        assert.equal(ratioArray(batch)[slot], 0.5);
        assert.equal(dataArray(batch)[slot], 42);
    }

    batch.resizeTo(1, 42, 0.5);
    assert.equal(batch.count, 1);
    assert.equal(batch.geometry.instanceCount, 1);
    assert.deepEqual(slotMatrix(batch, 0), translation(5, 0, 0).toArray(), 'a shrink drops the tail, never the head');

    // A count is a number of instances: a fraction or a negative cannot leave the
    // batch holding a slot three would not draw.
    batch.resizeTo(2.9, 42, 0.5);
    assert.equal(batch.count, 2);
    batch.resizeTo(-4, 42, 0.5);
    assert.equal(batch.count, 0);
});

test('growth through resizeTo drops three’s cached instance cap; a shrink keeps it', () => {
    const batch = new SupportInstanceBatch(unitShape(), 1);
    const geometry = batch.geometry as THREE.InstancedBufferGeometry & { _maxInstanceCount?: number };

    geometry._maxInstanceCount = batch.capacity;
    batch.resizeTo(1, 0, 1);
    assert.equal(geometry._maxInstanceCount, batch.capacity, 'no reallocation, no rebind');

    geometry._maxInstanceCount = batch.capacity;
    batch.resizeTo(4, 0, 1);
    assert.ok(batch.capacity >= 4);
    assert.equal(geometry._maxInstanceCount, undefined, 'the new buffers must be visible to the draw');

    geometry._maxInstanceCount = batch.capacity;
    batch.resizeTo(2, 0, 1);
    assert.equal(geometry._maxInstanceCount, batch.capacity, 'shrinking inside the capacity keeps the cache');

    geometry._maxInstanceCount = batch.capacity;
    batch.clearInstanceCountCache();
    assert.equal(geometry._maxInstanceCount, undefined, 'a caller that replaces attributes itself can clear it');
});

test('dispose frees the batch geometry and leaves the base shape alone', () => {
    const base = unitShape();
    const basePosition = base.getAttribute('position');
    const batch = new SupportInstanceBatch(base, 2);
    let disposals = 0;
    batch.geometry.addEventListener('dispose', () => {
        disposals += 1;
    });

    batch.dispose();

    assert.equal(disposals, 1);
    assert.equal(base.getAttribute('position'), basePosition, 'the unit shape outlives the batch');
    assert.ok(base.getIndex(), 'the base index outlives the batch');
});
