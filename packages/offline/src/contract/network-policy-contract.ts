// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { NetworkPolicy, PolicyDecision, PolicyRequest } from '../types.js';
import type { ContractResult } from './cache-store-contract.js';

const FIELDS: readonly (keyof PolicyDecision)[] = [
  'useNetwork',
  'readPackages',
  'readPersistentCache',
  'writePersistentCache',
  'keepInMemory',
];

const REQUESTS: readonly PolicyRequest[] = [
  { sourceId: 'a', layerId: 'a', purpose: 'visible' },
  { sourceId: 'a', layerId: 'base', purpose: 'prefetch' },
  { sourceId: 'unknown-source', layerId: 'unknown-layer', purpose: 'package' },
];

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const POLICY_CHECKS: Record<string, (policy: NetworkPolicy) => void> = {
  'every decision has the five tier flags as booleans': (policy) => {
    for (const request of REQUESTS) {
      const decision = policy.resolve(request);
      for (const field of FIELDS)
        expect(typeof decision[field] === 'boolean', `${field} is not a boolean for ${request.sourceId}`);
    }
  },
  'the same request gets the same decision': (policy) => {
    for (const request of REQUESTS)
      expect(
        JSON.stringify(policy.resolve(request)) === JSON.stringify(policy.resolve({ ...request })),
        `two decisions differ for ${request.sourceId}`,
      );
  },
  'unknown sources, layers and every purpose are decided without throwing': (policy) => {
    for (const purpose of ['visible', 'prefetch', 'package'] as const)
      policy.resolve({ sourceId: `never-registered-${purpose}`, layerId: '', purpose });
  },
  'the decision object is not shared between calls': (policy) => {
    const first = policy.resolve(REQUESTS[0] ?? { sourceId: 'a', layerId: 'a', purpose: 'visible' });
    const copy = { ...first };
    policy.resolve(REQUESTS[2] ?? { sourceId: 'b', layerId: 'b', purpose: 'package' });
    expect(JSON.stringify(first) === JSON.stringify(copy), 'a later call changed an earlier decision');
  },
};

/**
 * The contract every {@link NetworkPolicy} meets (F327): the built-in policy and an application's own run the same
 * checks. `create` returns a fresh policy for each check.
 */
export function runNetworkPolicyContract(create: () => NetworkPolicy): ContractResult[] {
  return Object.entries(POLICY_CHECKS).map(([name, check]) => {
    try {
      check(create());
      return { name, passed: true };
    } catch (error) {
      return { name, passed: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
}
