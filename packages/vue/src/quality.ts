import type { Globe } from '@vibeglobe/core';
import type { QualityController, QualityPresetName } from '@vibeglobe/quality';
import { watch } from 'vue';

/** The `qualityPreset` prop's values: a preset of `@vibeglobe/quality`, or 'auto' to choose it from the device. */
export type QualityPresetChoice = QualityPresetName | 'auto';

/**
 * Applies the `qualityPreset` prop to a running engine (F474, F399): once the engine is ready, `@vibeglobe/quality`
 * (loaded only when a preset is set) applies the preset with adaptive quality; later changes switch the preset in
 * place. Returns the function that stops watching and detaches the controller.
 */
export function watchQualityPreset(engine: Globe, preset: () => QualityPresetChoice | undefined): () => void {
  let controller: QualityController | undefined;
  let stopped = false;
  let starting: Promise<void> | undefined;
  const apply = (choice: QualityPresetChoice | undefined): void => {
    if (choice === undefined || stopped) return;
    if (controller) {
      if (choice !== 'auto') return controller.setPreset(choice);
      // 'auto' chooses from the device: a new controller does (KB-148).
      controller.destroy();
      controller = undefined;
      starting = undefined;
    }
    starting ??= engine.ready
      .then(() => import('@vibeglobe/quality'))
      .then(({ createQuality }) => {
        const latest = preset();
        if (stopped || latest === undefined) return;
        controller = createQuality(engine, { preset: latest });
      })
      .catch(() => undefined);
  };
  apply(preset());
  const stop = watch(preset, apply);
  return () => {
    stopped = true;
    stop();
    controller?.destroy();
  };
}
