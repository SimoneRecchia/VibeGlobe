/** Anti-aliasing modes (F397): none, a post-process pass (FXAA), or four samples per pixel (MSAA). */
export type AntialiasMode = 'none' | 'fxaa' | 'msaa4';

/** Atmosphere ray-marching levels (ADR 0040), or no atmosphere: no sky, haze or sun lighting. */
export type AtmosphereLevel = 'off' | 'low' | 'medium' | 'high' | 'ultra';

/**
 * Level of detail and effects, changeable at runtime between frames without recreating the renderer (F399; the
 * quality presets of `@vibeglobe/quality` apply them, ADR 0122). Fields not given keep their value.
 */
export interface QualitySettings {
  /** Multiplier of the device pixel ratio for the drawing buffer (as `Globe.setResolutionScale`). */
  readonly resolutionScale?: number;
  /** Largest projected geometric error in CSS pixels; imagery texels scale with it (default 1). */
  readonly maxScreenErrorPx?: number;
  /** Anisotropic filtering of imagery, at most the device's (F398; default its maximum). */
  readonly anisotropy?: number;
  /** Multisampling (`msaa4`, the default, where the renderer allows it), an FXAA pass, or none (F397, KB-140). */
  readonly antialias?: AntialiasMode;
  /** The atmosphere (F391–F396; default 'off'). */
  readonly atmosphere?: AtmosphereLevel;
  /** Haze and fog over the surface while the atmosphere is on (F394, F395; default true). */
  readonly fog?: boolean;
  /**
   * Loads coarser tiles where the fog hides the ground (F395; default true, while the fog is drawn); false loads full
   * detail under the fog too.
   */
  readonly fogAwareDetail?: boolean;
}

/** The atmosphere's scene settings (F394, F396); its level is a quality setting. Fields not given keep their value. */
export interface AtmosphereSettings {
  /** Shades the globe and terrain by the Sun at {@link AtmosphereSettings.timeMs} (default false). */
  readonly sunLighting?: boolean;
  /** The date and time of the Sun's position, Unix milliseconds UTC. */
  readonly timeMs?: number;
  /** Aerosol density relative to a clear day (default 1): more haze hides more of the distance. */
  readonly haze?: number;
}

/** What the renderer applies of {@link QualitySettings}: every field set. */
export interface RendererQuality {
  readonly anisotropy: number;
  readonly antialias: AntialiasMode;
  readonly atmosphere: AtmosphereLevel;
  readonly fog: boolean;
}
