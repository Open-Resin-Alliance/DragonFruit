import * as THREE from 'three';

/** Floats per instance matrix, the stride three reads for a mat4 attribute. */
const MATRIX_STRIDE = 16;

/**
 * One instanced batch of Support-mode primitives: a shared unit shape plus the
 * per-instance attributes a support renderer writes while a drag is in flight.
 *
 * Slots are dense: every index below `count` holds a live instance, so a removal
 * swaps the last instance into the hole rather than leaving a gap. A caller that
 * needs a stable name for an instance keeps its own index -> id map and follows
 * the index `removeAt` reports.
 *
 * The four instance attributes:
 * - `instanceMatrix` (mat4) - the shape's world transform;
 * - `iRatio` (float) - per-instance shape ratio (taper, body/contact width);
 * - `iData` (uint32) - packed state bits (selected, hover, visible, ...);
 * - `iPick` (uint32) - the id the GPU pick pass writes.
 *
 * `iData` and `iPick` are integer attributes: three uploads a `Uint32Array`
 * through `vertexAttribIPointer`, so the material that draws this geometry must
 * be GLSL3 (`glslVersion: THREE.GLSL3`) and declare them `in uint iData;`. A
 * `float` declaration receives no bits.
 *
 * The unit shape is copied, not shared: `dispose()` frees the batch's own vertex
 * buffers and leaves the base geometry usable by the next batch. Growth replaces
 * the attribute objects (three throws on an in-place resize) and copies the live
 * instances across; the geometry object itself is stable for the batch's life.
 */
export class SupportInstanceBatch {
    /** The geometry a mesh draws: the unit shape plus the instance attributes. */
    readonly geometry: THREE.InstancedBufferGeometry;

    private slotCapacity: number;
    private used = 0;

    private instanceMatrix!: THREE.InstancedBufferAttribute;
    private iRatio!: THREE.InstancedBufferAttribute;
    private iData!: THREE.InstancedBufferAttribute;
    private iPick!: THREE.InstancedBufferAttribute;

    private matrixArray!: Float32Array;
    private ratioArray!: Float32Array;
    private dataArray!: Uint32Array;
    private pickArray!: Uint32Array;

    private matrixDirty = false;
    private ratioDirty = false;
    private dataDirty = false;
    private pickDirty = false;

    constructor(base: THREE.BufferGeometry, initialCapacity = 1) {
        const position = base.getAttribute('position');
        if (!position) {
            throw new Error('SupportInstanceBatch: the base geometry has no position attribute');
        }

        this.geometry = new THREE.InstancedBufferGeometry();
        const index = base.getIndex();
        if (index) this.geometry.setIndex(index.clone());
        this.geometry.setAttribute('position', position.clone());
        const normal = base.getAttribute('normal');
        if (normal) this.geometry.setAttribute('normal', normal.clone());

        // A zero, negative or NaN capacity still leaves one slot to grow from.
        this.slotCapacity = Math.max(1, Math.floor(initialCapacity) || 0);
        this.allocate(this.slotCapacity, false);
    }

    /** Live instances: the dense range `0 .. count - 1`, and `geometry.instanceCount`. */
    get count(): number {
        return this.used;
    }

    /** Slots allocated before the next growth. Always a power-of-two doubling. */
    get capacity(): number {
        return this.slotCapacity;
    }

    setMatrix(index: number, matrix: THREE.Matrix4): void {
        this.assertLive(index);
        matrix.toArray(this.matrixArray, index * MATRIX_STRIDE);
        this.matrixDirty = true;
    }

    setRatio(index: number, ratio: number): void {
        this.assertLive(index);
        this.ratioArray[index] = ratio;
        this.ratioDirty = true;
    }

    setData(index: number, bits: number): void {
        this.assertLive(index);
        this.dataArray[index] = bits >>> 0;
        this.dataDirty = true;
    }

    setPick(index: number, id: number): void {
        this.assertLive(index);
        this.pickArray[index] = id >>> 0;
        this.pickDirty = true;
    }

    /** Write a new instance in the slot after the last one, growing if needed. */
    append(matrix: THREE.Matrix4, ratio: number, data: number, pick: number): number {
        if (this.used === this.slotCapacity) this.grow(this.used + 1);

        const index = this.used;
        this.used = index + 1;
        this.geometry.instanceCount = this.used;
        this.setMatrix(index, matrix);
        this.setRatio(index, ratio);
        this.setData(index, data);
        this.setPick(index, pick);
        return index;
    }

    /**
     * Remove an instance, swapping the last instance into its slot.
     *
     * Returns the index the last instance moved from - the slot that is now past
     * `count`, so a caller's index -> id map can move that entry too - or null
     * when the removed instance was already the last one.
     */
    removeAt(index: number): number | null {
        this.assertLive(index);

        const last = this.used - 1;
        this.used = last;
        this.geometry.instanceCount = last;
        if (index === last) return null;

        this.matrixArray.copyWithin(
            index * MATRIX_STRIDE,
            last * MATRIX_STRIDE,
            last * MATRIX_STRIDE + MATRIX_STRIDE,
        );
        this.ratioArray[index] = this.ratioArray[last];
        this.dataArray[index] = this.dataArray[last];
        this.pickArray[index] = this.pickArray[last];
        this.matrixDirty = true;
        this.ratioDirty = true;
        this.dataDirty = true;
        this.pickDirty = true;
        return last;
    }

    /**
     * Upload the instances written since the last flush.
     *
     * Only the attributes that changed are marked, so a drag that writes ratios
     * does not re-send every matrix. Whole attributes are sent: three's partial
     * ranges (`addUpdateRange`, which replaced the deprecated `updateRange`) are
     * not used here - a drag touches every instance it moves, and a range list
     * costs more to merge than the batch costs to re-send.
     */
    flush(): void {
        if (this.matrixDirty) {
            this.instanceMatrix.needsUpdate = true;
            this.matrixDirty = false;
        }
        if (this.ratioDirty) {
            this.iRatio.needsUpdate = true;
            this.ratioDirty = false;
        }
        if (this.dataDirty) {
            this.iData.needsUpdate = true;
            this.dataDirty = false;
        }
        if (this.pickDirty) {
            this.iPick.needsUpdate = true;
            this.pickDirty = false;
        }
    }

    /** Free the batch's vertex and instance buffers. The base geometry is untouched. */
    dispose(): void {
        this.geometry.dispose();
    }

    private grow(minimum: number): void {
        let capacity = this.slotCapacity;
        while (capacity < minimum) capacity *= 2;
        this.slotCapacity = capacity;
        this.allocate(capacity, true);
    }

    private allocate(capacity: number, copyExisting: boolean): void {
        const matrix = new Float32Array(capacity * MATRIX_STRIDE);
        const ratio = new Float32Array(capacity);
        const data = new Uint32Array(capacity);
        const pick = new Uint32Array(capacity);

        if (copyExisting) {
            matrix.set(this.matrixArray.subarray(0, this.used * MATRIX_STRIDE));
            ratio.set(this.ratioArray.subarray(0, this.used));
            data.set(this.dataArray.subarray(0, this.used));
            pick.set(this.pickArray.subarray(0, this.used));
        }

        this.matrixArray = matrix;
        this.ratioArray = ratio;
        this.dataArray = data;
        this.pickArray = pick;

        this.instanceMatrix = instanced(matrix, MATRIX_STRIDE);
        this.iRatio = instanced(ratio, 1);
        this.iData = instanced(data, 1);
        this.iPick = instanced(pick, 1);

        this.geometry.setAttribute('instanceMatrix', this.instanceMatrix);
        this.geometry.setAttribute('iRatio', this.iRatio);
        this.geometry.setAttribute('iData', this.iData);
        this.geometry.setAttribute('iPick', this.iPick);
        this.geometry.instanceCount = this.used;

        this.matrixDirty = true;
        this.ratioDirty = true;
        this.dataDirty = true;
        this.pickDirty = true;
    }

    private assertLive(index: number): void {
        if (!Number.isInteger(index) || index < 0 || index >= this.used) {
            throw new RangeError(
                `SupportInstanceBatch: instance ${index} is outside 0..${this.used - 1}`,
            );
        }
    }
}

function instanced(
    array: Float32Array | Uint32Array,
    itemSize: number,
): THREE.InstancedBufferAttribute {
    const attribute = new THREE.InstancedBufferAttribute(array, itemSize);
    attribute.setUsage(THREE.DynamicDrawUsage);
    return attribute;
}
