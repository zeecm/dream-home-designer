import {
  type Level,
  MAX_PEOPLE,
  type Meter,
  type People,
  type PlanGeometry,
  type Project,
  STORAGE_MEASURES,
  type StorageAmount,
  type StorageMeasure,
  type StorageReport,
  type StorageRoom,
  type StorageSetting,
  type Vec2,
  furnitureKind,
  isUploadedModel,
  levelBounds,
  matchRooms,
  pieceIn,
  roomShapes,
  storageGain,
  storageReport,
} from '@dhd/core';
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAgeing } from '../ageing/store';
import { pointerHeld, useWalkways } from '../clearance/walkways';
import { useRates } from '../cost/estimate';
import { type Selection, useEditor } from '../editor';
import { beforeOf } from '../electrical/electrical';
import { useSuggest } from '../electrical/suggest';
import { roomLabelBoxes } from '../plan/layers';
import { type Size, type View, fitBounds, worldToScreen } from '../plan/view';
import { canEdit, useLevel, useProject, useStore } from '../store';
import { Segmented } from '../ui/fields';
import { icons } from '../ui/icons';
import { useStorage } from './store';
import {
  ADD_PIECE,
  AMOUNT_HINT,
  DISCLAIMER,
  HDB_NOTE,
  INTRO,
  KITCHEN_NOTE,
  MEASURE_LABEL,
  NOT_COUNTED,
  SHELTER_NOTE,
  amount,
  aside,
  cabinetsText,
  clothesLines,
  copyText,
  cupboardText,
  emptyText,
  figures,
  householdLine,
  meterValueText,
  peopleText,
  pieceLine,
  pieceShare,
  statusWord,
  summaryLine,
} from './text';

/**
 * The storage meter in the editor: its row under Checks in the plan details, the panel
 * (replacing the plan details; a half-height sheet on a phone), the chips on the plan, a
 * piece's line in its details and the live region's line after a drop. Spec:
 * docs/specs/storage-meter.md, slice 1, with the UX design's wording.
 */

const AMOUNTS: { value: StorageAmount; label: string }[] = [
  { value: 'few', label: 'Few things' },
  { value: 'typical', label: 'Typical' },
  { value: 'lots', label: 'Lots' },
];

// --- the report, worked out once per level and household ----------------------------------

/** The last few reports by level, household and room match (Before and After both stay). */
const cache: {
  level: Level;
  setting: StorageSetting;
  alias?: Map<string, string>;
  r: StorageReport;
}[] = [];
function reportFor(level: Level, setting: StorageSetting, alias?: Map<string, string>) {
  const hit = cache.find((c) => c.level === level && c.setting === setting && c.alias === alias);
  if (hit) return hit.r;
  const r = storageReport(level, setting, alias);
  cache.unshift({ level, setting, ...(alias ? { alias } : {}), r });
  cache.length = Math.min(cache.length, 4);
  return r;
}

/** After's rooms matched to Before's, kept while neither version's walls or rooms change. */
let matched: { keys: unknown[]; map: Map<string, string> } | null = null;
function matchFor(before: Level, after: Level): Map<string, string> {
  const keys = [
    before.rooms,
    before.walls,
    before.vertices,
    after.rooms,
    after.walls,
    after.vertices,
  ];
  if (matched?.keys.every((k, i) => k === keys[i])) return matched.map;
  matched = { keys, map: matchRooms(before, after) };
  return matched.map;
}

/** Keeps the household in step with the project open. */
export function useStorageSync() {
  const projectId = useProject().id;
  const load = useStorage((s) => s.load);
  useEffect(() => load(projectId), [projectId, load]);
}

export interface StorageView {
  level: Level;
  report: StorageReport;
  /** In the renovation: the flat as it is, and what each room gains. */
  before?: StorageReport;
  gain?: Map<string, Record<StorageMeasure, number>>;
  /** In the renovation: each room's room in the flat as it is (people are kept under that). */
  alias?: Map<string, string>;
  /** Every room id in the project, both versions: people for rooms not here are dropped. */
  known: Set<string>;
}

/** Every room in the project, in the flat as it is and the renovation. */
function roomIds(project: Project): Set<string> {
  const out = new Set<string>();
  for (const l of [...project.levels, ...(project.renovation?.levels ?? [])]) {
    for (const id of Object.keys(l.rooms)) out.add(id);
  }
  return out;
}

/** The report for the level and version shown (the same object for every caller). */
export function useStorageReport(): StorageView | null {
  useStorageSync();
  const level = useLevel();
  const project = useProject();
  const setting = useStorage((s) => s.setting);
  const ready = useStorage((s) => s.projectId === project.id);
  return useMemo(() => {
    if (!level || !ready) return null;
    const known = roomIds(project);
    const flat = beforeOf(project, level);
    if (flat === level) return { level, report: reportFor(level, setting), known };
    const alias = matchFor(flat, level);
    const report = reportFor(level, setting, alias);
    const before = reportFor(flat, setting);
    return { level, report, before, gain: storageGain(before, report, alias), alias, known };
  }, [level, project, setting, ready]);
}

// --- small pieces ---------------------------------------------------------------------------

const count = (p: People) => p.adults + p.children;

function centreOf(level: Level, roomId: string): Vec2 | null {
  const s = roomShapes(level).get(roomId);
  if (!s?.outer.length) return null;
  return {
    x: s.outer.reduce((t, p) => t + p.x, 0) / s.outer.length,
    y: s.outer.reduce((t, p) => t + p.y, 0) / s.outer.length,
  };
}

function panTo(c: Vec2 | null) {
  const ed = useEditor.getState();
  if (c && ed.view) ed.setView({ ...ed.view, cx: c.x, cy: c.y }, true);
}

const narrow = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 720px)').matches;

const returnFocus = () =>
  requestAnimationFrame(() =>
    document.querySelector<HTMLButtonElement>('[data-storage-open]')?.focus(),
  );

/** Opens the panel: one list in the details at a time. */
export function openStorage() {
  useSuggest.getState().close();
  useAgeing.getState().closeList();
  useEditor.getState().select(null);
  useStorage.getState().openPanel();
}

/** Whether pieces can be added here: not on a view link, nor over a designer's preview. */
function useCanAdd() {
  const editable = useStore(canEdit);
  const preview = useEditor((s) => !!s.preview);
  return editable && !preview;
}

/** Arms the Furniture tool with a piece, to place on the plan (where pieces can be added). */
function addPiece(kindId: string) {
  const ed = useEditor.getState();
  if (!canEdit(useStore.getState()) || ed.preview) return;
  ed.setFurnitureKind(kindId);
  ed.setTool('furniture');
}

// --- the plan details' row ------------------------------------------------------------------

/** Under Checks: "Storage", the one line, and the way to the panel. */
export function StorageRow() {
  const view = useStorageReport();
  const level = useLevel();
  const rooms = level ? roomShapes(level).size : 0;
  const line = summaryLine(view?.report ?? null, rooms);
  return (
    <div className="field check-item storage-entry">
      <span className="check-label">Storage</span>
      <p className="field-hint check-line" data-testid="storage-summary">
        {line}
      </p>
      {rooms > 0 && (
        <button type="button" className="btn btn-small" data-storage-open="" onClick={openStorage}>
          See storage
        </button>
      )}
    </div>
  );
}

// --- the panel ------------------------------------------------------------------------------

function Stepper({
  label,
  where,
  value,
  onChange,
}: {
  label: 'Adults' | 'Children';
  where: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const id = useId();
  const what = label.toLowerCase();
  return (
    <div className="storage-step">
      <span className="storage-step-label" id={id}>
        {label}
      </span>
      <fieldset className="stepper" aria-labelledby={id}>
        <button
          type="button"
          className="btn"
          aria-label={`Fewer ${what} ${where}`}
          disabled={value <= 0}
          onClick={() => onChange(Math.max(0, value - 1))}
        >
          −
        </button>
        <span className="num" aria-live="polite">
          {value}
        </span>
        <button
          type="button"
          className="btn"
          aria-label={`More ${what} ${where}`}
          disabled={value >= MAX_PEOPLE}
          onClick={() => onChange(Math.min(MAX_PEOPLE, value + 1))}
        >
          +
        </button>
      </fieldset>
    </div>
  );
}

function Household({ view }: { view: StorageView }) {
  const { report } = view;
  const setting = useStorage((s) => s.setting);
  const setPeople = (roomId: string, people: People) =>
    useStorage.getState().setPeople(roomId, people, view.alias, view.known);
  const set = useStorage((s) => s.set);
  const edited = Object.keys(setting.people).length > 0 || count(setting.others) > 0;
  const rooms = report.rooms.filter((r) => r.sleeps);
  return (
    <div className="storage-household">
      {rooms.map((r) => (
        <div key={r.roomId} className="storage-people" data-room={r.name}>
          <p className="storage-people-room">
            <span>{r.name}</span>
            {r.fromBeds && count(r.people) > 0 && (
              <span className="storage-tag">Guessed from the beds</span>
            )}
          </p>
          <Stepper
            label="Adults"
            where={`in ${r.name}`}
            value={r.people.adults}
            onChange={(adults) => setPeople(r.roomId, { ...r.people, adults })}
          />
          <Stepper
            label="Children"
            where={`in ${r.name}`}
            value={r.people.children}
            onChange={(children) => setPeople(r.roomId, { ...r.people, children })}
          />
        </div>
      ))}
      <div className="storage-people">
        <p className="storage-people-room">Also living here, without a bed drawn</p>
        <Stepper
          label="Adults"
          where="without a bed"
          value={setting.others.adults}
          onChange={(adults) => set({ others: { ...setting.others, adults } })}
        />
        <Stepper
          label="Children"
          where="without a bed"
          value={setting.others.children}
          onChange={(children) => set({ others: { ...setting.others, children } })}
        />
      </div>
      {edited && (
        <button
          type="button"
          className="link-btn storage-reset"
          onClick={() => useStorage.getState().resetPeople()}
        >
          Reset to the beds
        </button>
      )}
    </div>
  );
}

/** A measure's meter: label and status, a bar with a tick at the target, the figures. */
function MeterRow({
  m,
  meter,
  report,
  before,
}: {
  m: StorageMeasure;
  meter: Meter;
  report: StorageReport;
  before?: Meter;
}) {
  const id = useId();
  const canAdd = useCanAdd();
  const status = statusWord(m, meter);
  const empty = meter.status === 'none';
  const t = meter.target;
  const top = Math.max(meter.have, t ?? 0) || 1;
  const pct = (v: number) => `${Math.min(100, (v / top) * 100)}%`;
  const more = aside(m, meter);
  const cupboard = m === 'other' ? cupboardText(meter) : null;
  return (
    <div className="storage-meter" data-measure={m} data-status={meter.status ?? 'none-target'}>
      <div className="storage-meter-head">
        <span className="storage-meter-label" id={id}>
          {MEASURE_LABEL[m]}
        </span>
        {status && (
          <span className={`storage-status${status.warn ? ' warning-text' : ''}`}>
            {status.text}
          </span>
        )}
      </div>
      {t !== undefined && (
        <div
          role="meter"
          aria-labelledby={id}
          aria-valuemin={0}
          aria-valuemax={Math.round(t * 100) / 100}
          aria-valuenow={Math.round(Math.min(meter.have, t) * 100) / 100}
          aria-valuetext={meterValueText(m, meter)}
          className={`storage-bar${empty ? ' storage-bar-empty' : ''}${meter.status === 'short' ? ' storage-bar-short' : ''}`}
        >
          {!empty && <span className="storage-fill" style={{ width: pct(meter.have) }} />}
          <span className="storage-tick" style={{ left: pct(t) }} />
        </div>
      )}
      {empty ? (
        <p className="storage-figures storage-muted">
          {emptyText(m, meter)}
          {canAdd && (
            <>
              {' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => addPiece(ADD_PIECE[m].kindId)}
              >
                Add a {ADD_PIECE[m].what}
              </button>
            </>
          )}
        </p>
      ) : (
        <p className="storage-figures num">
          {m === 'kitchen' && t === undefined ? cabinetsText(report) : figures(m, meter)}
          {m === 'kitchen' && t !== undefined && ' of shelves and drawers'}
          {more && <span className="storage-aside"> · {more}</span>}
        </p>
      )}
      {m === 'kitchen' && t !== undefined && !empty && (
        <p className="storage-note">From {amount('kitchen', report.cabinets)} of cabinets.</p>
      )}
      {cupboard && meter.status === 'short' && <p className="storage-note">{cupboard}</p>}
      {m === 'other' && t !== undefined && meter.status !== 'enough' && (
        <p className="storage-note">{HDB_NOTE}</p>
      )}
      {before && <p className="storage-note storage-before">Before: {amount(m, before.have)}</p>}
    </div>
  );
}

function RoomCard({
  view,
  room,
  gain,
}: {
  view: StorageView;
  room: StorageRoom;
  gain?: Record<StorageMeasure, number>;
}) {
  const rates = useRates((s) => s.rates);
  const highlight = useStorage((s) => s.highlight);
  const { level, report } = view;
  const lines = clothesLines(report, room, rates, false);
  const gains = gain
    ? STORAGE_MEASURES.filter((m) => gain[m] > (m === 'shoes' ? 0.5 : 0.005)).map(
        (m) => `+${amount(m, gain[m])}`,
      )
    : [];
  return (
    <li
      className={`storage-card${highlight === room.roomId ? ' storage-card-shown' : ''}`}
      data-testid="storage-room"
      data-room={room.name}
    >
      <button
        type="button"
        className="storage-card-name"
        aria-label={`${room.name}: show on the plan`}
        onClick={() => {
          useStorage.getState().setHighlight(room.roomId);
          panTo(centreOf(level, room.roomId));
        }}
      >
        <span>{room.name}</span>
        {count(room.people) > 0 && <span className="storage-muted">{peopleText(room.people)}</span>}
      </button>
      {lines && (
        <p className="storage-card-line" data-testid="storage-room-line">
          {lines.line}
          {lines.more && (
            <>
              {' '}
              <span className={lines.warn ? 'storage-gap' : undefined}>{lines.more}</span>
            </>
          )}
        </p>
      )}
      {room.store && (
        <p className="storage-card-line">
          {room.store.counted
            ? `${amount('other', room.store.volume)} for storage, counted in Everything else.`
            : 'Not counted: “Use the shelter for storage” is off.'}
        </p>
      )}
      {room.pieces.length > 0 && <Pieces level={level} pieces={room.pieces} />}
      {gains.length > 0 && (
        <p className="storage-note storage-gain">{gains.join(', ')} in the renovation</p>
      )}
    </li>
  );
}

function Pieces({ level, pieces }: { level: Level; pieces: StorageRoom['pieces'] }) {
  return (
    <ul className="storage-pieces">
      {pieces.map((p) => {
        const it = level.items[p.itemId];
        const name = (it && furnitureKind(it.assetId)?.name) || 'Piece';
        return (
          <li key={p.itemId}>
            <button
              type="button"
              className="storage-piece"
              onClick={() => {
                if (it) panTo({ x: it.position.x, y: it.position.z });
                useEditor.getState().select({ kind: 'item', id: p.itemId });
              }}
            >
              <span>{name}</span>
              <span className="num">{pieceShare(p)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The panel: who lives here, how much they own, four meters, room by room, notes. */
export function StoragePanel() {
  const view = useStorageReport();
  const setting = useStorage((s) => s.setting);
  const set = useStorage((s) => s.set);
  const intro = useStorage((s) => s.intro);
  const rates = useRates((s) => s.rates);
  const heading = useRef<HTMLHeadingElement>(null);
  const nobody = !!view && count(view.report.people) === 0;
  const [change, setChange] = useState<boolean | null>(null);
  const [copied, setCopied] = useState('');
  // Opened: from its top, focus on its heading.
  useEffect(() => {
    heading.current?.closest('.inspector')?.scrollTo?.({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (useEditor.getState().selection || document.querySelector('dialog[open]')) return;
      if (useEditor.getState().tool !== 'select') return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  if (!view) return null;
  const { level, report } = view;
  // Unfolded the first time, or with nobody to count; on a phone one line with Change.
  const open = change ?? (nobody || (intro && !narrow()));
  const shelter = report.rooms.find((r) => r.store?.kind === 'shelter');
  const copy = async () => {
    const name = AMOUNTS.find((a) => a.value === setting.amount)?.label ?? '';
    try {
      await navigator.clipboard.writeText(copyText(level, report, rates, name));
      setCopied('Copied: paste it into a chat.');
    } catch {
      setCopied('Couldn’t copy here.');
    }
  };
  return (
    <section className="storage" aria-labelledby="storage-h">
      <div className="inspector-head storage-head">
        <h2 id="storage-h" className="panel-title" ref={heading} tabIndex={-1}>
          Storage
        </h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close storage"
          title="Close (Esc)"
          onClick={close}
        >
          {icons.close}
        </button>
      </div>
      <p className="storage-finding" data-testid="storage-finding">
        {summaryLine(report, roomShapes(level).size)}
      </p>
      {intro && <p className="storage-intro">{INTRO}</p>}

      <div className="storage-who">
        <p className="storage-oneline">
          <span data-testid="storage-household">{householdLine(report)}</span>
          <button
            type="button"
            className="link-btn"
            aria-expanded={open}
            onClick={() => setChange(!open)}
          >
            {open ? 'Done' : 'Change'}
          </button>
        </p>
        {nobody && <p className="storage-note">Add who lives here to compare.</p>}
        {open && <Household view={view} />}
      </div>

      <div className="storage-own">
        <span className="field-label" aria-hidden="true">
          How much we own
        </span>
        <Segmented
          label="How much we own"
          fill
          value={setting.amount}
          options={AMOUNTS}
          onChange={(amount) => set({ amount })}
        />
        <p className="storage-note">{AMOUNT_HINT}</p>
        {shelter && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={setting.shelter}
              onChange={(e) => set({ shelter: e.target.checked })}
            />
            <span>Use the shelter for storage</span>
          </label>
        )}
      </div>

      <div className="storage-meters">
        {STORAGE_MEASURES.map((m) => (
          <MeterRow
            key={m}
            m={m}
            meter={report.home[m]}
            report={report}
            {...(view.before ? { before: view.before.home[m] } : {})}
          />
        ))}
      </div>

      <section className="storage-rooms" aria-labelledby="storage-rooms-h">
        <h3 id="storage-rooms-h" className="section-title">
          Room by room
        </h3>
        <ul className="storage-cards">
          {report.rooms.map((r) => (
            <RoomCard
              key={r.roomId}
              view={view}
              room={r}
              {...(view.gain?.get(r.roomId) ? { gain: view.gain.get(r.roomId) } : {})}
            />
          ))}
          {report.outside.length > 0 && (
            <li className="storage-card" data-testid="storage-room" data-room="">
              <p className="storage-card-name storage-card-plain">Not in a room</p>
              <Pieces level={level} pieces={report.outside} />
            </li>
          )}
        </ul>
      </section>

      <div className="storage-notes">
        {report.notCounted.length > 0 && (
          <p className="storage-note">
            Not counted: {report.notCounted.map((n) => `${n.name} (your model)`).join(', ')}.
            Storage can’t be told from a model.
          </p>
        )}
        {shelter?.store?.counted && <p className="storage-note">{SHELTER_NOTE}</p>}
        {report.home.kitchen.have > 0 && <p className="storage-note">{KITCHEN_NOTE}</p>}
        <p className="storage-note">{DISCLAIMER}</p>
      </div>

      <div className="storage-foot">
        <button type="button" className="btn btn-primary btn-block" onClick={copy}>
          Copy summary
        </button>
        <button type="button" className="btn btn-block" onClick={close}>
          Close
        </button>
        <p className="visually-hidden" aria-live="polite">
          {copied}
        </p>
      </div>
    </section>
  );
}

function close() {
  useStorage.getState().closePanel();
  returnFocus();
}

/** Above a piece's details opened from a card: the way back to the panel. */
export function StorageBack() {
  return (
    <button
      type="button"
      className="link-btn storage-back"
      onClick={() => useEditor.getState().select(null)}
    >
      ‹ Back to storage
    </button>
  );
}

// --- a piece ----------------------------------------------------------------------------------

/** The selected piece's storage line (in the report, so a base run's sink rule shows). */
function pieceText(view: StorageView | null, level: Level, id: string): string | null {
  const it = level.items[id];
  const kind = it && furnitureKind(it.assetId);
  if (!it || !kind) return null;
  if (isUploadedModel(kind)) return NOT_COUNTED;
  // Until the report for this level is ready, nothing (no guess at the piece's room).
  if (view?.level !== level) return null;
  const p = pieceIn(view.report, id);
  return p ? pieceLine(p) : null;
}

/** In a piece's details, after its clearances: "Storage: 1.80 m of wardrobe (6 ft)". */
export function ItemStorage({ level, id }: { level: Level; id: string }) {
  const view = useStorageReport();
  const text = pieceText(view, level, id);
  if (!text) return null;
  return (
    <p className="field-hint storage-item" data-testid="item-storage">
      {text}
    </p>
  );
}

/** The line read after a drop or a resize: the room's clothes line, or the piece's own. */
function announcement(view: StorageView | null, id: string | null): string | null {
  if (!view || !id) return null;
  const p = pieceIn(view.report, id);
  if (!p) return null;
  const room = view.report.rooms.find((r) => r.pieces.includes(p));
  if (p.clothes > 0 && room) {
    const c = clothesLines(view.report, room, useRates.getState().rates);
    if (c) return [c.line, c.more].filter(Boolean).join(' ');
  }
  return pieceLine(p);
}

export function StorageAnnouncement({ selection }: { selection: Selection | null }) {
  const view = useStorageReport();
  const released = useWalkways((s) => s.released);
  const id = selection?.kind === 'item' ? selection.id : null;
  const line = announcement(view, id);
  const [text, setText] = useState('');
  const said = useRef<{ id: string | null; released: number; line: string | null }>({
    id: null,
    released,
    line: null,
  });
  useEffect(() => {
    const prev = said.current;
    if (prev.id !== id) {
      said.current = { id, released, line };
      setText(line ? ` ${line}` : '');
      return;
    }
    if (pointerHeld() || released === prev.released) return;
    said.current = { id, released, line };
    if (line && line !== prev.line) setText(` ${line}`);
    else if (!line) setText('');
  }, [id, released, line]);
  return text ? <>{text}</> : null;
}

// --- on the plan --------------------------------------------------------------------------------

/** The room whose card was tapped, outlined (in plan metres). Left out of pictures. */
export function StorageHighlight({ level }: { level: Level }) {
  const open = useStorage((s) => s.open);
  const highlight = useStorage((s) => s.highlight);
  if (!open || !highlight) return null;
  const s = roomShapes(level).get(highlight);
  if (!s) return null;
  return (
    <polygon
      className="storage-highlight"
      points={s.outer.map((p) => `${p.x},${p.y}`).join(' ')}
      pointerEvents="none"
      data-export="skip"
      data-testid="storage-highlight"
    />
  );
}

/** "Wardrobe 1.20 of 2.00 m" at each bedroom's label, "Shelves 4.8 of 12 m" at the kitchen. */
export const StorageChips = memo(function StorageChips({
  level,
  geom,
  view,
  size,
}: {
  level: Level;
  geom: PlanGeometry;
  view: View;
  size: Size;
}) {
  const open = useStorage((s) => s.open);
  const sv = useStorageReport();
  const fitAll = useStorage((s) => s.fitAll);
  // On a phone the plan shrinks above the half-height sheet: show all of it there (on opening,
  // and the resizes just after).
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening, and the resizes after it
  useEffect(() => {
    if (!fitAll || Date.now() - fitAll > 1000 || size.width === 0) return;
    const frame = requestAnimationFrame(() =>
      useEditor.getState().setView(fitBounds(levelBounds(level), size, 12), true),
    );
    return () => cancelAnimationFrame(frame);
  }, [fitAll, size]);
  if (!open || !sv || sv.level !== level) return null;
  const { report } = sv;
  const small = size.width < 560;
  const chips: { roomId: string; text: string; warn: boolean }[] = [];
  for (const r of report.rooms) {
    const c = r.clothes;
    if (!c || c.target === undefined) continue;
    const of = `${amount('clothes', c.have, false)} of ${amount('clothes', c.target)}`;
    const short = `${c.have.toFixed(1)} of ${c.target.toFixed(1)} m`;
    chips.push({
      roomId: r.roomId,
      text: small ? short : `Wardrobe ${of}`,
      warn: c.status === 'short' || c.status === 'none',
    });
  }
  const k = report.home.kitchen;
  if (report.kitchenRoomId && !chips.some((c) => c.roomId === report.kitchenRoomId)) {
    const t = k.target !== undefined ? ` of ${Math.round(k.target * 10) / 10} m` : ' m';
    const text = `${amount('kitchen', k.have, false)}${t}`;
    chips.push({
      roomId: report.kitchenRoomId,
      text: small ? text : `Shelves ${text}`,
      warn: k.status === 'short' || k.status === 'none',
    });
  }
  const labels = new Map(roomLabelBoxes(level, geom, view.zoom).map((l) => [l.id, l]));
  const font = small ? 11 : 12;
  return (
    <g
      className="storage-chips"
      pointerEvents="none"
      data-export="skip"
      data-testid="storage-chips"
    >
      {chips.map((c) => {
        const l = labels.get(c.roomId);
        if (!l) return null;
        const p = worldToScreen(view, size, l.at);
        const w = c.text.length * font * 0.56 + 12;
        const h = font + 8;
        const y = p.y + (l.area ? 22 : 12);
        return (
          <g
            key={c.roomId}
            className={`storage-chip${c.warn ? ' storage-chip-warn' : ''}`}
            data-testid="storage-chip"
            transform={`translate(${p.x} ${y})`}
          >
            <rect x={-w / 2} y={0} width={w} height={h} rx={h / 2} />
            <text className="num" x={0} y={h / 2 + font * 0.35} textAnchor="middle" fontSize={font}>
              {c.text}
            </text>
          </g>
        );
      })}
    </g>
  );
});
