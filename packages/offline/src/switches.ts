import type { LoadingSwitch, LoadingSwitches, ProviderRules, SwitchScope } from './types.js';

/** Every switch on: the default (F271). */
export const ALL_ON: Readonly<LoadingSwitches> = Object.freeze({
  persistentCache: true,
  memoryReuse: true,
  prefetch: true,
  offlinePackaging: true,
});

/** The names of the switches, in a fixed order. */
const SWITCH_NAMES: readonly LoadingSwitch[] = ['persistentCache', 'memoryReuse', 'prefetch', 'offlinePackaging'];

/**
 * The loading switches set globally, per source and per layer (F290). The effective value for a source in a layer is
 * `global ∧ layer ∧ source ∧ profileAllows` (docs/plan/architecture.md §8): an override or a profile can only switch a
 * feature off where a wider setting has it on, and switching it back on restores the wider setting.
 */
export class SwitchBoard {
  private global: LoadingSwitches = { ...ALL_ON };
  private readonly bySource = new Map<string, Partial<LoadingSwitches>>();
  private readonly byLayer = new Map<string, Partial<LoadingSwitches>>();
  /** Incremented by every change, so callers can tell a setting changed without comparing. */
  version = 0;

  /** Sets switches globally, or for one source or layer when `scope` names it. */
  set(switches: Partial<LoadingSwitches>, scope: SwitchScope = {}): void {
    const defined = Object.fromEntries(
      Object.entries(switches).filter(
        ([name, value]) => SWITCH_NAMES.includes(name as LoadingSwitch) && value !== undefined,
      ),
    ) as Partial<LoadingSwitches>;
    if (scope.sourceId !== undefined) this.merge(this.bySource, scope.sourceId, defined);
    if (scope.layerId !== undefined) this.merge(this.byLayer, scope.layerId, defined);
    if (scope.sourceId === undefined && scope.layerId === undefined) this.global = { ...this.global, ...defined };
    this.version++;
  }

  /** The global switches. */
  globalSwitches(): LoadingSwitches {
    return { ...this.global };
  }

  /** The effective switches of a source in a layer, with the provider's rules applied. */
  effective(sourceId: string, layerId: string, rules?: ProviderRules): LoadingSwitches {
    const result = { ...this.global };
    const source = this.bySource.get(sourceId);
    const layer = this.byLayer.get(layerId);
    for (const name of SWITCH_NAMES) {
      result[name] = result[name] && source?.[name] !== false && layer?.[name] !== false && !rules?.forbids.has(name);
    }
    return result;
  }

  private merge(map: Map<string, Partial<LoadingSwitches>>, key: string, switches: Partial<LoadingSwitches>): void {
    map.set(key, { ...map.get(key), ...switches });
  }
}
