import {
  type Design,
  type DesignResult,
  WRONG,
  WRONG_TEXT,
  type Wrong,
  caseText,
  designerCase,
  furnitureKind,
} from '@dhd/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { icons } from '../../ui/icons';

/**
 * "This is wrong" on a version (spec docs/specs/ai-designer-v2.md, "New failures become
 * regression cases"): what's wrong in a tap and a line, what it's about, then a small case file
 * to copy or download and paste into an issue. Free; nothing is sent anywhere by the app. The
 * case holds the plan before and as proposed, the brief and the checks' lines; never the key,
 * prices, the plan image or who wrote a comment.
 */
export function CaseDialog({
  d,
  r,
  model,
  onClose,
}: {
  d: Design;
  r: DesignResult;
  model: string | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);
  const close = () => ref.current?.close();
  const [what, setWhat] = useState<Wrong | null>(null);
  const [words, setWords] = useState('');
  const [about, setAbout] = useState('');
  const [copied, setCopied] = useState(false);
  // What it can be about: a room of the version, or a piece in it.
  const targets = useMemo(() => {
    const rooms = r.spaces.map((s) => ({ value: `room:${s.main}`, label: s.name }));
    // One entry per kind of piece in a room ("Dining chair · Living and dining", not four).
    const seen = new Set<string>();
    const pieces = r.spaces.flatMap((s) =>
      s.items.flatMap((id) => {
        const it = r.level.items[id];
        const kind = it && furnitureKind(it.assetId);
        if (!kind || kind.ceiling) return [];
        const label = `${kind.name} · ${s.name}`;
        if (seen.has(label)) return [];
        seen.add(label);
        return [{ value: `item:${id}`, label }];
      }),
    );
    return { rooms, pieces };
  }, [r]);
  const file = useMemo(() => {
    if (!what) return null;
    const [kind, id] = about.split(':');
    return designerCase({
      title: `${WRONG_TEXT[what]}${words.trim() ? `: ${words.trim().slice(0, 80)}` : ''}`,
      what,
      words: words.trim(),
      pointer: id ? (kind === 'item' ? { itemId: id } : { roomId: id }) : null,
      brief: d.brief,
      before: d.baseLevel,
      proposal: r.level,
      checks: r.checks,
      model,
    });
  }, [what, words, about, d, r, model]);
  const text = file ? caseText(file) : '';
  const name = `designer-case-v${d.n}.json`;
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <dialog
      ref={ref}
      className="dialog case-dialog"
      aria-labelledby="case-h"
      onClose={(e) => e.target === e.currentTarget && onClose()}
    >
      <header className="dialog-head">
        <h2 id="case-h">What’s wrong with V{d.n}?</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
          {icons.close}
        </button>
      </header>
      <div className="dialog-body case-body">
        <fieldset className="chip-row" aria-label="What’s wrong">
          {WRONG.map((w) => (
            <button
              key={w}
              type="button"
              className="chip"
              aria-pressed={what === w}
              onClick={() => {
                setWhat(w);
                setCopied(false);
              }}
            >
              {WRONG_TEXT[w]}
            </button>
          ))}
        </fieldset>
        <label className="field">
          <span className="field-label">What it’s about</span>
          <select className="input" value={about} onChange={(e) => setAbout(e.target.value)}>
            <option value="">The whole version</option>
            <optgroup label="Rooms">
              {targets.rooms.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Pieces">
              {targets.pieces.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="field">
          <span className="field-label">In a line (optional)</span>
          <input
            className="input"
            value={words}
            maxLength={1000}
            placeholder="The sofa faces the wall"
            onChange={(e) => setWords(e.target.value)}
          />
        </label>
        <p className="field-hint">
          {file
            ? `A case file of ${Math.ceil(new TextEncoder().encode(text).length / 1024)} KB: the plan before and as V${d.n} has it, your brief (with names) and the checks. No key, prices or plan image. `
            : 'Pick what’s wrong to make a case file. '}
          Nothing is sent: you copy or download it, then{' '}
          <a
            href="https://github.com/zeecm/dream-home-designer/issues/new"
            target="_blank"
            rel="noreferrer"
          >
            paste it into a new GitHub issue
          </a>{' '}
          to help fix this.
        </p>
      </div>
      <footer className="dialog-foot">
        <div className="button-row">
          <button type="button" className="btn" disabled={!file} onClick={download}>
            Download case
          </button>
          <button type="button" className="btn btn-primary" disabled={!file} onClick={copy}>
            {copied ? 'Copied' : 'Copy case'}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
