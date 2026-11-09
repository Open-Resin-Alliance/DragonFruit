import * as THREE from 'three';

/**
 * The matrix a hidden instance takes: scaled to nothing, so the instance keeps
 * its slot in the batch and costs no pixels.
 *
 * A batch hides an excluded model this way rather than dropping it from its
 * arrays. The arrays are laid out once (about 0.1 us per instance), and an
 * activation change that only moves a model between the world layer and its own
 * attached layer must not pay that again.
 */
export const HIDDEN_INSTANCE_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
