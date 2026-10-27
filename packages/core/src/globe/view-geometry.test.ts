import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { DEFAULT_VIEW_CURVES } from '../view/curves.js';
import { ViewState } from '../view/view-state.js';
import { renderDrawing, screenOf } from './view-geometry.js';

describe('queries while a frame is drawn (KB-210)', () => {
  it('reuse the drawn camera instead of updating it for every point, and update it otherwise', () => {
    const camera = new Camera();
    camera.widthPx = 800;
    camera.heightPx = 600;
    const view = new ViewState(DEFAULT_VIEW_CURVES);
    let updates = 0;
    const update = camera.update.bind(camera);
    camera.update = () => {
      updates++;
      update();
    };
    const position = { longitudeDeg: 0, latitudeDeg: 0 };
    screenOf(camera, view, position);
    expect(updates).toBe(1);
    // A renderer whose layers project points while the frame is drawn.
    const renderer = {
      render: (): boolean => {
        for (let i = 0; i < 10; i++) screenOf(camera, view, position);
        // Another globe's camera is still brought up to date.
        screenOf(new Camera(), view, position);
        return true;
      },
    };
    expect(renderDrawing(camera, renderer, undefined, undefined)).toBe(true);
    expect(updates).toBe(1);
    screenOf(camera, view, position);
    expect(updates).toBe(2);
  });
});
