// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { SwitchBoard } from './switches.js';
import type { NetworkMode, NetworkPolicy, PolicyDecision, PolicyRequest, ProviderRules } from './types.js';

/** What the default policy reads: the mode, the switches and each source's provider rules. */
export interface PolicyInputs {
  /** The mode in effect for a source in a layer (KB-184). */
  mode(sourceId: string, layerId: string): NetworkMode;
  readonly switches: SwitchBoard;
  rules(sourceId: string): ProviderRules | undefined;
}

/**
 * The built-in {@link NetworkPolicy} (docs/internal/plan/api.md): online only never reads packages (F291), offline only never
 * touches the network (F292), hybrid uses both (F293); the persistent cache is read and written only where its switch
 * and the provider allow it (F280, F318), and prefetches never touch the network without the prefetch switch.
 */
export function defaultNetworkPolicy(inputs: PolicyInputs): NetworkPolicy {
  return {
    resolve(request: PolicyRequest): PolicyDecision {
      const mode = inputs.mode(request.sourceId, request.layerId);
      const switches = inputs.switches.effective(request.sourceId, request.layerId, inputs.rules(request.sourceId));
      const purposeAllowed =
        request.purpose === 'visible' ||
        (request.purpose === 'prefetch' && switches.prefetch) ||
        (request.purpose === 'package' && switches.offlinePackaging);
      return {
        useNetwork: mode !== 'offline' && purposeAllowed,
        readPackages: mode !== 'online',
        readPersistentCache: switches.persistentCache,
        writePersistentCache: switches.persistentCache,
        keepInMemory: switches.memoryReuse,
      };
    },
  };
}
