// Next runs this before hydration, ahead of any app or plugin module.
import { installReactCommitHook } from '@/utils/debug/reactCommitWatch';
import { installLegacyWebKitPolyfills } from '@/utils/legacyWebKitPolyfills';

installLegacyWebKitPolyfills();
// React reads the DevTools hook once, when react-dom is first evaluated.
installReactCommitHook();
