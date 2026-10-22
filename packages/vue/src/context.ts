import type { Globe } from '@vibeglobe/core';
import type { InjectionKey, ShallowRef } from 'vue';

/** The engine of the nearest enclosing globe component, undefined until it starts and after it unmounts. */
export const GLOBE_KEY: InjectionKey<ShallowRef<Globe | undefined>> = Symbol('vibeglobe');
