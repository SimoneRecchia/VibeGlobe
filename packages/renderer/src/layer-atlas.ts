import { LinearFilter, SRGBColorSpace, Texture } from 'three/webgpu';

/** A drawn region of the atlas: texture coordinates and its size in CSS pixels. */
export interface AtlasEntry {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** An image the application registers for markers (ADR 0037). */
export type AtlasImage = CanvasImageSource & { readonly width: number; readonly height: number };

const SIZE = 2048;
/** Pixels between entries, so linear filtering never reads a neighbor. */
const GAP = 2;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif';

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function createCanvas(): { canvas: OffscreenCanvas | HTMLCanvasElement; context: Canvas2D } {
  const canvas =
    typeof OffscreenCanvas === 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(SIZE, SIZE);
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext('2d') as Canvas2D | null;
  if (!context) throw new Error('No 2D canvas for the layer atlas');
  return { canvas, context };
}

/**
 * The texture atlas of labels and marker images (ADR 0037): text rasterized with the browser's fonts at the screen's
 * pixel ratio, white with a dark halo so a shader tints it, and the images applications register, packed in rows.
 * When full it starts over and the batches using it rebuild.
 */
export class LayerAtlas {
  readonly texture: Texture;
  private readonly context: Canvas2D;
  private readonly entries = new Map<string, AtlasEntry>();
  private readonly images = new Map<string, AtlasImage>();
  private x = GAP;
  private y = GAP;
  private rowHeight = 0;
  /** Increased when the atlas starts over: entries handed out before are stale. */
  generation = 0;

  constructor(private pixelRatio = 1) {
    const { canvas, context } = createCanvas();
    this.context = context;
    this.texture = new Texture(canvas as unknown as HTMLCanvasElement);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
  }

  /** Registers or replaces a marker image by name. */
  addImage(name: string, image: AtlasImage): void {
    this.images.set(name, image);
    this.entries.delete(`i:${name}`);
  }

  /** Whether an image of this name is registered. */
  hasImage(name: string): boolean {
    return this.images.has(name);
  }

  /** Sets the pixel ratio text is rasterized at; a change starts the atlas over. */
  setPixelRatio(pixelRatio: number): void {
    if (pixelRatio === this.pixelRatio) return;
    this.pixelRatio = pixelRatio;
    this.reset();
  }

  /** The entry of a text at a size (CSS pixels), drawn on first use. */
  text(text: string, sizePx: number): AtlasEntry {
    const key = `t:${String(sizePx)}:${text}`;
    const cached = this.entries.get(key);
    if (cached) return cached;
    const context = this.context;
    const scale = this.pixelRatio;
    const font = `${String(sizePx * scale)}px ${FONT}`;
    context.font = font;
    const halo = Math.max(1, Math.round(sizePx * 0.12)) * scale;
    const width = Math.ceil(context.measureText(text).width + 2 * halo);
    const height = Math.ceil(sizePx * 1.3 * scale + 2 * halo);
    const at = this.allocate(width, height);
    context.font = font;
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    context.lineWidth = 2 * halo;
    context.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    context.fillStyle = '#ffffff';
    context.strokeText(text, at.x + halo, at.y + height / 2);
    context.fillText(text, at.x + halo, at.y + height / 2);
    return this.remember(key, at.x, at.y, width, height, scale);
  }

  /** The entry of a registered image at its natural size, or undefined when none has that name. */
  image(name: string): AtlasEntry | undefined {
    const key = `i:${name}`;
    const cached = this.entries.get(key);
    if (cached) return cached;
    const image = this.images.get(name);
    if (!image) return undefined;
    const at = this.allocate(image.width, image.height);
    this.context.drawImage(image, at.x, at.y);
    return this.remember(key, at.x, at.y, image.width, image.height, 1);
  }

  private remember(key: string, x: number, y: number, width: number, height: number, scale: number): AtlasEntry {
    const entry = {
      u0: x / SIZE,
      v0: y / SIZE,
      u1: (x + width) / SIZE,
      v1: (y + height) / SIZE,
      widthPx: width / scale,
      heightPx: height / scale,
    };
    this.entries.set(key, entry);
    this.texture.needsUpdate = true;
    return entry;
  }

  private allocate(width: number, height: number): { x: number; y: number } {
    if (this.x + width + GAP > SIZE) {
      this.x = GAP;
      this.y += this.rowHeight + GAP;
      this.rowHeight = 0;
    }
    if (this.y + height + GAP > SIZE) this.reset();
    const at = { x: this.x, y: this.y };
    this.x += width + GAP;
    this.rowHeight = Math.max(this.rowHeight, height);
    return at;
  }

  private reset(): void {
    this.context.clearRect(0, 0, SIZE, SIZE);
    this.entries.clear();
    this.x = GAP;
    this.y = GAP;
    this.rowHeight = 0;
    this.generation++;
    this.texture.needsUpdate = true;
  }

  /** Releases the atlas texture. */
  dispose(): void {
    this.texture.dispose();
  }
}
