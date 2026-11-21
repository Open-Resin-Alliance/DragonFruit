// Next runs this before hydration, ahead of any app or plugin module.
import { installReactCommitHook } from '@/utils/debug/reactCommitWatch';
import { installColorMixShim } from '@/utils/legacyColorMix';
import { installLegacyWebKitPolyfills } from '@/utils/legacyWebKitPolyfills';

installLegacyWebKitPolyfills();
installColorMixShim({ force: readForceColorMixShim() });
// React reads the DevTools hook once, when react-dom is first evaluated.
installReactCommitHook();

/** `localStorage.dfForceColorMixShim = '1'` runs the shim in a current browser too. */
function readForceColorMixShim(): boolean {
  try {
    return window.localStorage.getItem('dfForceColorMixShim') === '1';
  } catch {
    return false;
  }
}
