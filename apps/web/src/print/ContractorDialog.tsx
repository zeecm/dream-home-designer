import { type Paper, type Variant, sheetScale } from '@dhd/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../editor';
import { useProject, useStore } from '../store';
import { Segmented } from '../ui/fields';
import { icons } from '../ui/icons';
import { sheetExtent } from './extent';
import { focusApp } from './frame';

const scaleText = (s: { scale: number; fits: boolean }) =>
  s.fits ? `1:${s.scale}` : 'not to scale';

/**
 * Plan for contractors: pick the paper, the version and whether to show the furniture, then
 * print the measured sheet (the print dialog saves it as a PDF).
 */
export function ContractorDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const project = useProject();
  const shown = useEditor((s) => s.variant);
  // Until one is picked: A4, unless only A3 has the plan to scale.
  const [picked, setPicked] = useState<Paper | null>(null);
  const [variant, setVariant] = useState<Variant>(project.renovation ? shown : 'before');
  const [furniture, setFurniture] = useState(false);
  // On when the plan has electrical points (in either version).
  const hasPoints = [...project.levels, ...(project.renovation?.levels ?? [])].some(
    (l) => Object.keys(l.points ?? {}).length > 0,
  );
  const [electrical, setElectrical] = useState(hasPoints);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const close = () => ref.current?.close();

  // The scale on each paper, for the version picked (a renovation can change the outline,
  // and its hacked walls are drawn too).
  const scales = useMemo(() => {
    const b = sheetExtent(project, variant);
    return b ? { A4: sheetScale(b, 'A4'), A3: sheetScale(b, 'A3') } : null;
  }, [project, variant]);
  const paper: Paper = picked ?? (scales && !scales.A4.fits && scales.A3.fits ? 'A3' : 'A4');

  const print = async () => {
    setBusy(true);
    setError('');
    try {
      const { printContractorSheet } = await import('./contractorSheet');
      await printContractorSheet(useStore.getState().editor.doc, {
        paper,
        variant,
        furniture,
        electrical,
      });
      close();
    } catch (e) {
      setError(`Couldn’t make the sheet: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className="dialog contractor-dialog"
      aria-labelledby="contractor-h"
      tabIndex={-1}
      onClose={(e) => {
        if (e.target !== e.currentTarget) return;
        onClose();
        // Back to where it was opened from (the menu item is gone with the menu).
        focusApp();
      }}
    >
      <header className="dialog-head">
        <h2 id="contractor-h">Plan for contractors</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
          {icons.close}
        </button>
      </header>
      <div className="dialog-body">
        <p className="dialog-note">
          A measured plan to quote from: every wall, door and window dimensioned in millimetres,
          with room sizes and a scale bar.
        </p>
        <div className="ai-form">
          <div className="field">
            <span className="field-label">Paper</span>
            <Segmented<Paper>
              label="Paper"
              fill
              value={paper}
              onChange={setPicked}
              options={(['A4', 'A3'] as const).map((p) => ({
                value: p,
                label: scales ? `${p}, ${scaleText(scales[p])}` : p,
              }))}
            />
          </div>
          {project.renovation && (
            <div className="field">
              <span className="field-label">Version</span>
              <Segmented<Variant>
                label="Version"
                fill
                value={variant}
                onChange={setVariant}
                options={[
                  { value: 'after', label: 'After' },
                  { value: 'before', label: 'As it is now' },
                ]}
              />
            </div>
          )}
          <label className="check-row">
            <input
              type="checkbox"
              checked={furniture}
              onChange={(e) => setFurniture(e.target.checked)}
            />
            <span>Include furniture</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={electrical}
              onChange={(e) => setElectrical(e.target.checked)}
            />
            <span>Electrical plan</span>
          </label>
          <p className="field-hint">
            Built-ins are always shown. In the print dialog, choose Save as PDF, at scale 100%.
          </p>
        </div>
      </div>
      <footer className="dialog-foot">
        {error && (
          <p className="field-hint warning-text" role="alert">
            {error}
          </p>
        )}
        <div className="button-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !scales}
            onClick={() => void print()}
          >
            {busy ? 'Making the sheet…' : 'Print or save as PDF'}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
