/**
 * Wallpaper patterns, drawn on a canvas: one tile `TILE` metres square. The 3D view repeats
 * it along each wall face (whose UVs run in metres); the details panel shows it as a swatch.
 * Drawn by hand rather than downloaded, so they cost nothing to load and look the same
 * everywhere.
 */
export const TILE = 0.6;

type Ctx = CanvasRenderingContext2D;

const PATTERNS: Record<string, (c: Ctx, s: number) => void> = {
  'wallpaper-pinstripe': (c, s) => {
    c.fillStyle = '#e9e3d6';
    c.fillRect(0, 0, s, s);
    c.fillStyle = '#b9ae9a';
    for (let x = 0; x < s; x += s / 12) c.fillRect(x, 0, Math.max(1, s / 256), s);
  },
  'wallpaper-linen': (c, s) => {
    c.fillStyle = '#e2dacb';
    c.fillRect(0, 0, s, s);
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    c.globalAlpha = 0.18;
    for (let i = 0; i < s; i += 2) {
      c.fillStyle = rnd() > 0.5 ? '#b8ad98' : '#f4efe6';
      c.fillRect(0, i, s, 1);
      c.fillStyle = rnd() > 0.5 ? '#b8ad98' : '#f4efe6';
      c.fillRect(i, 0, 1, s);
    }
    c.globalAlpha = 1;
  },
  'wallpaper-grid': (c, s) => {
    c.fillStyle = '#eef0ef';
    c.fillRect(0, 0, s, s);
    c.strokeStyle = '#a9b3b1';
    c.lineWidth = Math.max(1, s / 300);
    for (let x = 0; x <= s; x += s / 6) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, s);
      c.moveTo(0, x);
      c.lineTo(s, x);
      c.stroke();
    }
  },
  'wallpaper-herringbone': (c, s) => {
    c.fillStyle = '#d9cfbf';
    c.fillRect(0, 0, s, s);
    c.strokeStyle = '#a89a83';
    c.lineWidth = Math.max(1, s / 200);
    const n = 6;
    const w = s / n;
    for (let col = 0; col < n; col++) {
      for (let row = -1; row <= n; row++) {
        const x = col * w;
        const y = row * w;
        c.beginPath();
        if (col % 2 === 0) {
          c.moveTo(x, y);
          c.lineTo(x + w, y + w);
        } else {
          c.moveTo(x, y + w);
          c.lineTo(x + w, y);
        }
        c.stroke();
      }
    }
  },
  'wallpaper-botanical': (c, s) => {
    c.fillStyle = '#dfe6da';
    c.fillRect(0, 0, s, s);
    const leaf = (x: number, y: number, r: number, a: number) => {
      c.save();
      c.translate(x, y);
      c.rotate(a);
      c.beginPath();
      c.ellipse(0, 0, r, r * 0.38, 0, 0, Math.PI * 2);
      c.fill();
      c.restore();
    };
    c.fillStyle = '#7f9a76';
    const r = s / 9;
    for (const [x, y, a] of [
      [0.2, 0.2, 0.6],
      [0.7, 0.3, -0.5],
      [0.35, 0.7, -0.9],
      [0.85, 0.85, 0.4],
      [0.55, 0.05, 1.2],
      [0.05, 0.55, 1.6],
    ] as const) {
      // Wrapped at the edges so the tile repeats without a seam.
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 0, 1]) leaf((x + dx) * s, (y + dy) * s, r, a);
      }
    }
  },
  'wallpaper-brick': (c, s) => {
    c.fillStyle = '#cfc8bc';
    c.fillRect(0, 0, s, s);
    const rows = 8;
    const h = s / rows;
    const w = s / 2;
    const gap = Math.max(1, s / 120);
    c.fillStyle = '#ece8e1';
    for (let r = 0; r < rows; r++) {
      const off = r % 2 === 0 ? 0 : w / 2;
      for (let x = -w; x < s + w; x += w) {
        c.fillRect(x + off + gap / 2, r * h + gap / 2, w - gap, h - gap);
      }
    }
  },
  'wallpaper-fluted': (c, s) => {
    const n = 20;
    const w = s / n;
    for (let i = 0; i < n; i++) {
      const g = c.createLinearGradient(i * w, 0, (i + 1) * w, 0);
      g.addColorStop(0, '#8f6943');
      g.addColorStop(0.45, '#c39a6c');
      g.addColorStop(1, '#8f6943');
      c.fillStyle = g;
      c.fillRect(i * w, 0, w, s);
    }
  },
  'wallpaper-terrazzo': (c, s) => {
    c.fillStyle = '#e8e4dc';
    c.fillRect(0, 0, s, s);
    let seed = 11;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const colours = ['#b7a99a', '#8d9a95', '#c9a58b', '#9b9b9b', '#d8cfc3'];
    for (let i = 0; i < 140; i++) {
      c.fillStyle = colours[i % colours.length] as string;
      const x = rnd() * s;
      const y = rnd() * s;
      const r = (0.004 + rnd() * 0.012) * s;
      c.beginPath();
      c.ellipse(x, y, r, r * (0.5 + rnd() * 0.5), rnd() * Math.PI, 0, Math.PI * 2);
      c.fill();
    }
  },
};

export const isWallpaper = (id: string): boolean => id in PATTERNS;

/** A wallpaper's tile on a new canvas `px` square, or null outside a browser. */
export function wallpaperCanvas(id: string, px = 512): HTMLCanvasElement | null {
  const draw = PATTERNS[id];
  if (!draw || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const c = canvas.getContext('2d');
  if (!c) return null;
  draw(c, px);
  return canvas;
}
