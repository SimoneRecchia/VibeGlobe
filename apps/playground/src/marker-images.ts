/** The marker images of `data-markers` and `data-styled`: a red pin and a blue square, drawn on canvases. */
export function markerImages(): Record<string, HTMLCanvasElement> {
  const pin = document.createElement('canvas');
  pin.width = 24;
  pin.height = 32;
  const p = pin.getContext('2d');
  if (p) {
    p.fillStyle = '#e02020';
    p.beginPath();
    p.arc(12, 11, 10, 0, 2 * Math.PI);
    p.fill();
    p.beginPath();
    p.moveTo(4, 16);
    p.lineTo(12, 32);
    p.lineTo(20, 16);
    p.fill();
  }
  const square = document.createElement('canvas');
  square.width = 32;
  square.height = 32;
  const q = square.getContext('2d');
  if (q) {
    q.fillStyle = '#2040e0';
    q.fillRect(0, 0, 32, 32);
  }
  return { pin, square };
}
