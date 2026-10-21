import type { BackendName, GeoPosition, ViewInit } from '@vibeglobe/core';
import type { BackendChoice } from '@vibeglobe/renderer';

/** Messages from the page to the rendering worker (F065 experiment, `?render=worker`). */
export type ToWorker =
  | {
      readonly type: 'start';
      readonly canvas: OffscreenCanvas;
      readonly widthPx: number;
      readonly heightPx: number;
      readonly pixelRatio: number;
      readonly backend: BackendChoice;
      readonly view: ViewInit;
      readonly imageryUrl: string;
      readonly marker: GeoPosition;
    }
  | { readonly type: 'resize'; readonly widthPx: number; readonly heightPx: number; readonly pixelRatio: number }
  | {
      readonly type: 'pointer';
      readonly kind: 'down' | 'move' | 'up';
      readonly xPx: number;
      readonly yPx: number;
      /** Sequence number of the input event, for latency measurement. */
      readonly seq: number;
    }
  | {
      readonly type: 'wheel';
      readonly xPx: number;
      readonly yPx: number;
      readonly deltaZoom: number;
      readonly seq: number;
    };

/** Messages from the rendering worker to the page. */
export type FromWorker =
  | { readonly type: 'ready'; readonly backend: BackendName | undefined }
  | {
      readonly type: 'frame';
      /** When the frame was submitted, in ms since the Unix epoch (comparable across threads). */
      readonly timeMs: number;
      /** The last input event applied before this frame. */
      readonly seq: number;
      /** Where the frame shows the marker, CSS pixels. */
      readonly marker: { readonly xPx: number; readonly yPx: number } | undefined;
    }
  | { readonly type: 'error'; readonly message: string };

/** The marker drawn in the scene and mirrored by a DOM overlay, to measure overlay misalignment. */
export const MARKER: GeoPosition = { longitudeDeg: 10, latitudeDeg: 45, heightMeters: 0 };

/** Half the size of the marker quad, in degrees. */
export const MARKER_HALF_SIZE_DEG = 0.5;
