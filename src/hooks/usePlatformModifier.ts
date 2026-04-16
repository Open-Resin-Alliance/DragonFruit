import { useEffect, useState } from 'react';
import { detectPlatform } from './usePlatform';

export function usePlatformModifier(): string {
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => {
    setMod(detectPlatform() === 'mac' ? 'Cmd' : 'Ctrl');
  }, []);
  return mod;
}
