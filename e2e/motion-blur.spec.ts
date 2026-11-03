// Motion blur (F694): off by default; with `motionBlur` a camera that keeps moving smears each pixel along its motion
// on screen, more at a higher level, while a still camera's frames, a jump and the frame after the camera stops stay
// sharp, on WebGPU and forced WebGL2, with each anti-aliasing mode.
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 320, height: 240 } });

const VIEW = 'lon=12&lat=42&zoom=6';
/** The pan of each frame, in degrees of longitude: about 12 px at zoom 6. */
const STEP_DEG = 0.25;

const luminance = (image: PNG, i: number): number =>
  0.2126 * (image.data[i] ?? 0) + 0.7152 * (image.data[i + 1] ?? 0) + 0.0722 * (image.data[i + 2] ?? 0);

/** The mean luminance change to the next pixel across and down the middle half of the frame: its detail by direction. */
function detail(image: PNG): { across: number; down: number } {
  let across = 0;
  let down = 0;
  let count = 0;
  for (let y = image.height / 4; y < (image.height * 3) / 4; y++)
    for (let x = image.width / 4; x < (image.width * 3) / 4; x++) {
      const i = (y * image.width + x) * 4;
      across += Math.abs(luminance(image, i + 4) - luminance(image, i));
      down += Math.abs(luminance(image, i + image.width * 4) - luminance(image, i));
      count++;
    }
  return { across: across / count, down: down / count };
}

/** The mean absolute difference of two frames' channels. */
function difference(a: PNG, b: PNG): number {
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0));
  return sum / a.data.length;
}

/**
 * Pans east by `frames` steps from the camera at rest, one drawn frame each, and captures the last step's frame as it
 * is drawn; then puts the camera back and waits until it rests.
 */
async function panFrame(page: Page, frames: number): Promise<PNG> {
  const frame = await page.evaluate(
    async ({ frames, step }) => {
      const globe = window.vibeglobePlayground?.globe;
      if (!globe) throw new Error('no globe');
      const start = globe.camera;
      const drawn = async (): Promise<void> => {
        const n = globe.frameNumber;
        while (globe.frameNumber === n) await new Promise((resolve) => requestAnimationFrame(resolve));
      };
      const pan = (i: number) => globe.jumpTo({ longitudeDeg: start.longitudeDeg + i * step });
      for (let i = 1; i < frames; i++) {
        pan(i);
        await drawn();
      }
      pan(frames);
      const capture = await globe.captureFrame();
      globe.jumpTo(start);
      const bytes = new Uint8Array(capture.rgba.buffer, capture.rgba.byteOffset, capture.rgba.byteLength);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      return { widthPx: capture.widthPx, heightPx: capture.heightPx, base64: btoa(binary) };
    },
    { frames, step: STEP_DEG },
  );
  await waitForIdle(page);
  const image = new PNG({ width: frame.widthPx, height: frame.heightPx });
  image.data.set(Buffer.from(frame.base64, 'base64'));
  return image;
}

const setBlur = (page: Page, settings: { motionBlur?: number; antialias?: 'none' | 'fxaa' | 'msaa4' }) =>
  page.evaluate(async (s) => {
    window.vibeglobePlayground?.globe.setQualitySettings(s);
    // The blur's pass loads with the change: a few frames until the frames use it.
    for (let i = 0; i < 10; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  }, settings);

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`motion blur smears a moving camera's frames along the motion, by level, and keeps still frames sharp, on ${backend} (F694)`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openGlobe(page, `backend=${backend}&${VIEW}`);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.qualitySettings.motionBlur)).toBe(0);
    await waitForIdle(page);
    const still = await canvasImage(page);
    const sharp = detail(await panFrame(page, 3));
    const sharpJump = detail(await panFrame(page, 1));
    for (const antialias of ['msaa4', 'fxaa', 'none'] as const) {
      await setBlur(page, { antialias, motionBlur: 0 });
      const reference = detail(await panFrame(page, 3));
      await setBlur(page, { motionBlur: 1 });
      const full = detail(await panFrame(page, 3));
      console.log(
        `[motion-blur] ${backend} ${antialias}: across ${reference.across.toFixed(2)} → ${full.across.toFixed(2)}, down ${reference.down.toFixed(2)} → ${full.down.toFixed(2)}`,
      );
      // An east pan smears across: the detail across drops far more than the detail down.
      expect(full.across, `${antialias}: detail across`).toBeLessThan(reference.across * 0.7);
      expect(full.down / reference.down, `${antialias}: detail down`).toBeGreaterThan(
        full.across / reference.across + 0.15,
      );
    }
    await setBlur(page, { antialias: 'msaa4', motionBlur: 0.25 });
    const quarter = detail(await panFrame(page, 3));
    await setBlur(page, { motionBlur: 1 });
    const full = detail(await panFrame(page, 3));
    expect(quarter.across, 'a lower level smears less').toBeGreaterThan(full.across * 1.1);
    expect(quarter.across).toBeLessThan(sharp.across * 0.95);
    // A jump (the first frame after a still one) stays sharp.
    expect(detail(await panFrame(page, 1)).across, 'a jump').toBeGreaterThan(sharpJump.across * 0.97);
    // At rest, and after the camera stops, the frame is the one without motion blur.
    expect(difference(await canvasImage(page), still), 'frame at rest').toBeLessThan(0.5);
  });
