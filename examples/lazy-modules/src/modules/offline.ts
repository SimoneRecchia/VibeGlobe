// Offline: the offline engine (network modes, packages, browser storage).
import { createOffline } from '@vibeglobe/offline';

export async function enable(): Promise<string> {
  const offline = createOffline();
  return `offline: ${typeof offline}`;
}
