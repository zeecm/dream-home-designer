import {
  newId,
  placeUnderlay,
  rotateUnderlay,
  setUnderlay,
  setUnderlayOpacity,
  underlayToWorld,
} from '@dhd/core';
import { useRef, useState } from 'react';
import { prepareUpload, putAsset, useAsset } from '../assets';
import { useEditor } from '../editor';
import { useProject, useStore } from '../store';
import { icons } from './icons';

/** Stores an uploaded plan locally and puts it under the plan, centred in view. */
export async function uploadPlanImage(file: File): Promise<void> {
  const projectId = useStore.getState().editor.doc.id;
  const { width, height, blob } = await prepareUpload(file);
  // A PDF can take a moment to render; don't put it on a different plan opened meanwhile.
  if (useStore.getState().editor.doc.id !== projectId) return;
  const key = `img_${newId('it').slice(3)}`;
  await putAsset(key, blob);
  const view = useEditor.getState().view;
  const centre = view ? { x: view.cx, y: view.cy } : { x: 0, y: 0 };
  useStore.getState().dispatch(setUnderlay(placeUnderlay(key, { width, height }, centre)));
  // Straight into calibration: the image's scale is only a guess until then.
  useEditor.getState().setTool('calibrate');
}

/** Bundled plans for trying the tracing flow without a plan of your own. */
const SAMPLES = {
  drawn: { path: '/samples/sample-4room-plan.png', type: 'image/png' },
  hdb: { path: '/samples/hdb-3room-type4.pdf', type: 'application/pdf' },
} as const;

export async function loadSamplePlanImage(which: keyof typeof SAMPLES = 'drawn'): Promise<void> {
  const { path, type } = SAMPLES[which];
  const res = await fetch(path);
  if (!res.ok) throw new Error('The sample plan could not be loaded.');
  const blob = await res.blob();
  await uploadPlanImage(new File([blob], path.split('/').pop() ?? 'sample', { type }));
}

export function useUploadPicker() {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = (
    <input
      ref={input}
      type="file"
      accept="image/*,application/pdf,.pdf"
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        setBusy(true);
        setError(null);
        uploadPlanImage(f)
          .catch((err: Error) => setError(err.message))
          .finally(() => setBusy(false));
      }}
    />
  );
  const sample = (which: keyof typeof SAMPLES = 'drawn') => {
    setBusy(true);
    setError(null);
    loadSamplePlanImage(which)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  return { picker, open: () => input.current?.click(), sample, error, busy };
}

/** Whole degrees, or two decimals once quarter-degree nudges are in play. */
const deg = (r: number) => {
  const d = Math.round(((r * 180) / Math.PI) * 100) / 100;
  return Number.isInteger(d) ? d.toFixed(0) : d.toFixed(2);
};

export function PlanImagePanel() {
  const underlay = useProject().underlay;
  const asset = useAsset(underlay?.assetKey);
  const dispatch = useStore((s) => s.dispatch);
  const setTool = useEditor((s) => s.setTool);
  const { picker, open, sample, error, busy } = useUploadPicker();

  if (!underlay) {
    return (
      <section className="tool-options" aria-labelledby="img-h">
        <h3 id="img-h" className="panel-heading">
          Plan image
        </h3>
        <button type="button" className="btn btn-block" onClick={open} disabled={busy}>
          {icons.image}
          {busy ? 'Reading…' : 'Upload floor plan'}
        </button>
        <p className="field-hint">JPG, PNG or the first page of a PDF, up to 25 MB.</p>
        <p className="field-hint">
          No plan to hand? Try{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => sample('drawn')}
            disabled={busy}
          >
            a simple sample
          </button>{' '}
          or{' '}
          <button type="button" className="link-btn" onClick={() => sample('hdb')} disabled={busy}>
            a real HDB 3-room plan (PDF)
          </button>
          .
        </p>
        {error && <p className="field-hint error-text">{error}</p>}
        {picker}
      </section>
    );
  }

  const pivot = () => {
    if (asset.status !== 'ready') return underlay.origin;
    return underlayToWorld(underlay, { x: asset.width / 2, y: asset.height / 2 });
  };
  const rotate = (by: number) => dispatch(rotateUnderlay(underlay.rotation + by, pivot()));
  const mPerPx = underlay.scale;

  return (
    <section className="tool-options" aria-labelledby="img-h">
      <h3 id="img-h" className="panel-heading">
        Plan image
      </h3>
      {asset.status === 'missing' && (
        <p className="field-hint error-text">
          This image is stored in another browser. Upload it again to trace here.
        </p>
      )}
      <label className="slider">
        <span>Opacity</span>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={underlay.opacity}
          onChange={(e) =>
            dispatch(setUnderlayOpacity(Number(e.target.value)), {
              coalesceKey: 'underlay-opacity',
            })
          }
        />
      </label>
      <div className="slider">
        <span>Rotation</span>
        <div className="rotation-row">
          <button
            type="button"
            className="icon-btn"
            onClick={() => rotate(-Math.PI / 2)}
            aria-label="Rotate 90° anticlockwise"
            title="Rotate 90° anticlockwise"
          >
            ⟲
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => rotate(-Math.PI / 720)}
            aria-label="Nudge anticlockwise"
            title="Nudge ¼° anticlockwise"
          >
            {icons.minus}
          </button>
          <span className="num rotation-value">{deg(underlay.rotation)}°</span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => rotate(Math.PI / 720)}
            aria-label="Nudge clockwise"
            title="Nudge ¼° clockwise"
          >
            {icons.plus}
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => rotate(Math.PI / 2)}
            aria-label="Rotate 90° clockwise"
            title="Rotate 90° clockwise"
          >
            ⟳
          </button>
        </div>
      </div>
      <button type="button" className="btn btn-block" onClick={() => setTool('calibrate')}>
        {icons.calibrate}
        Set scale
      </button>
      <p className="field-hint num">1 m on the plan = {Math.round(1 / mPerPx)} image px</p>
      <div className="button-row">
        <button type="button" className="btn btn-small" onClick={open} disabled={busy}>
          Replace
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger"
          onClick={() => dispatch(setUnderlay(null))}
        >
          Remove
        </button>
      </div>
      {error && <p className="field-hint error-text">{error}</p>}
      {picker}
    </section>
  );
}
