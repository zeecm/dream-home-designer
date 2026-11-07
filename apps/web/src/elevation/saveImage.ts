import { type Elevation, type ElevationChanges, elevationLabels, faceTitle } from '@dhd/core';
import { createElement } from 'react';
import { download } from '../exports';
import { ElevationSvg, PAPER, chainsShown, drawingBox } from './ElevationSvg';
import { imageName } from './nav';

/**
 * The wall view saved as a picture: the drawing as shown (white, its dimensions), its title,
 * and the list of points and what to check, drawn in. A PNG named after the room and the face;
 * on a phone it goes to the share sheet where the browser has one, else it downloads.
 */

/** A wallpaper's tile as a data URL, once `loadWallpapers` has drawn it; else null. */
export const wallpaperUrl = (id: string): string | null => tiles.get(id) ?? null;

/** Tiles drawn by `@dhd/render`'s wallpaperCanvas, filled in once it has loaded. */
const tiles = new Map<string, string>();
let loading: Promise<void> | null = null;

/** Draws the wallpaper tiles (once), so the drawing can use them; resolves when ready. */
export function loadWallpapers(ids: readonly string[]): Promise<void> {
  const want = ids.filter((id) => id.startsWith('wallpaper-') && !tiles.has(id));
  if (want.length === 0) return Promise.resolve();
  loading = (loading ?? Promise.resolve())
    .then(async () => {
      const { wallpaperCanvas } = await import('@dhd/render');
      for (const id of want) {
        const c = wallpaperCanvas(id, 256);
        if (c) tiles.set(id, c.toDataURL('image/png'));
      }
    })
    // A failed load (offline, say) leaves the papers in their colour; the next call tries again.
    .catch(() => {});
  return loading;
}

export interface SaveArgs {
  elev: Elevation;
  roomName: string;
  changes: ElevationChanges | null;
  dims: boolean;
  openTo: string | null;
  pointNames: Record<string, string>;
}

/** The picture's SVG markup (white, dark ink), with its title and list. */
export async function elevationImageSvg(
  a: SaveArgs,
): Promise<{ svg: string; w: number; h: number }> {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { elev } = a;
  // About 1:25 on a 96 dpi screen, and never wider than 2600 px.
  const pxPerM = Math.max(80, Math.min(160, 2400 / (elev.width + 1.5)));
  const labels = elevationLabels(elev, pxPerM, 13);
  const box = drawingBox(elev, pxPerM, chainsShown(labels, a.dims));
  const pad = 32;
  const titleH = 64;
  const lines: { text: string; colour: string; size: number; weight?: number }[] = [];
  for (const n of elev.notes)
    lines.push({ text: `!${n.n}  ${n.text}`, colour: PAPER.note, size: 14 });
  if (elev.notes.length) lines.push({ text: '', colour: PAPER.ink, size: 8 });
  for (const p of elev.points) {
    lines.push({
      text: `${p.n} · ${a.pointNames[p.id] ?? p.kind} · ${Math.round(p.tagHeight * 1000)} from floor · ${Math.round(p.fromLeft * 1000)} from left corner`,
      colour: PAPER.ink,
      size: 14,
    });
  }
  lines.push({ text: '', colour: PAPER.ink, size: 8 });
  lines.push({
    text: 'Heights from the finished floor, to the centre of each plate (aircon: to the top of the unit). Check the floor finish on site.',
    colour: PAPER.muted,
    size: 13,
  });
  const listH = lines.reduce((s, l) => s + l.size * 1.6, 0);
  const w = Math.max(720, Math.round(box.w * pxPerM + 2 * pad));
  const drawH = Math.round(box.h * pxPerM);
  const h = Math.round(pad + titleH + drawH + 24 + listH + pad);
  const title = `${a.roomName} · ${faceTitle(elev.face)}`;
  const sub = [
    `${Math.round(elev.width * 1000)} × ${Math.round(elev.ceiling * 1000)} mm`,
    elev.finishName,
  ]
    .filter(Boolean)
    .join(' · ');
  const font = 'IBM Plex Sans, Helvetica, Arial, sans-serif';
  let y = pad + titleH + drawH + 24;
  const list = lines.map((l, i) => {
    y += l.size * 1.6;
    return createElement(
      'text',
      { key: i, x: pad, y, fontSize: l.size, fill: l.colour, fontFamily: font },
      l.text,
    );
  });
  const drawing = createElement(
    'g',
    {
      transform: `translate(${(w - box.w * pxPerM) / 2} ${pad + titleH}) scale(${pxPerM}) translate(${-box.x} ${-box.y})`,
    },
    createElement(ElevationSvg, {
      elev,
      labels,
      pxPerM,
      changes: a.changes,
      wallpaper: wallpaperUrl,
      dims: a.dims,
      openTo: a.openTo,
      idPrefix: 'png',
    }),
  );
  const svg = renderToStaticMarkup(
    createElement(
      'svg',
      { xmlns: 'http://www.w3.org/2000/svg', width: w, height: h, viewBox: `0 0 ${w} ${h}` },
      createElement('rect', { width: w, height: h, fill: '#ffffff' }),
      createElement(
        'text',
        { x: pad, y: pad + 22, fontSize: 22, fontWeight: 600, fill: PAPER.ink, fontFamily: font },
        title,
      ),
      createElement(
        'text',
        { x: pad, y: pad + 48, fontSize: 15, fill: PAPER.muted, fontFamily: font },
        sub,
      ),
      drawing,
      ...list,
    ),
  );
  return { svg, w, h };
}

async function toPng(svg: string, w: number, h: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser can’t draw the picture.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No picture'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Saves the face as a PNG: shared on a phone that can, else downloaded. */
export async function saveElevationImage(a: SaveArgs): Promise<void> {
  await loadWallpapers(a.elev.walls.map((w) => w.material ?? ''));
  const { svg, w, h } = await elevationImageSvg(a);
  const png = await toPng(svg, w, h);
  const name = imageName(a.roomName, a.elev.face);
  const file = new File([png], name, { type: 'image/png' });
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  if (coarse && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name.replace(/\.png$/, '') });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  download(png, name);
}
