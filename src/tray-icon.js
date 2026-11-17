const { nativeImage } = require('electron');

// The buddy as a tray icon, drawn by hand (no image asset to ship) and
// coloured by what the agents are up to.
const TONES = {
  rest: [163, 163, 173],
  working: [236, 238, 78],
  needs: [255, 162, 63],
  paused: [110, 110, 120],
  limit: [255, 107, 107], // near a quota limit

};
const icons = new Map();

function trayIcon(tone) {
  if (icons.has(tone)) return icons.get(tone);
  const n = 32;
  const SS = 4; // sub-samples per pixel edge, for smooth edges
  const [r, g, b] = TONES[tone] || TONES.rest;
  const roundRect = (x, y, x0, y0, x1, y1, rad) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.max(x0 + rad, Math.min(x, x1 - rad));
    const cy = Math.max(y0 + rad, Math.min(y, y1 - rad));
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
  };
  const body = (x, y) =>
    roundRect(x, y, 3, 2, 29, 25, 5) || roundRect(x, y, 8, 22, 12, 31, 1.5) || roundRect(x, y, 20, 22, 24, 31, 1.5);
  const face = (x, y) =>
    roundRect(x, y, 9.5, 9, 13, 14.5, 1) || roundRect(x, y, 19, 9, 22.5, 14.5, 1) || roundRect(x, y, 12, 18, 20, 20, 1);

  const buf = Buffer.alloc(n * n * 4);
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      let cover = 0;
      let dark = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          if (!body(x, y)) continue;
          cover++;
          if (face(x, y)) dark++;
        }
      }
      if (!cover) continue;
      const a = cover / (SS * SS);
      const d = dark / cover; // share of the covered area that is face
      const mix = (c) => Math.round(c * (1 - d) + 26 * d);
      const i = (py * n + px) * 4;
      // BGRA, premultiplied alpha
      buf[i] = Math.round(mix(b) * a);
      buf[i + 1] = Math.round(mix(g) * a);
      buf[i + 2] = Math.round(mix(r) * a);
      buf[i + 3] = Math.round(a * 255);
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: n, height: n });
  icons.set(tone, img);
  return img;
}

module.exports = { trayIcon };
