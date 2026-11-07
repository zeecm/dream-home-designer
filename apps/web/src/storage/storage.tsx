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
  roomKind,
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
import { type Size, type View, fitBounds } from '../plan/view';
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
  chipText,
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

/**
 * Arms the Furniture tool with a piece to place on the plan (where pieces can be added); the
 * panel stays, says what to do, and comes back once it's placed.
 */
function addPiece(m: StorageMeasure) {
  const ed = useEditor.getState();
  if (!canEdit(useStore.getState()) || ed.preview) return;
  const { kindId, what } = ADD_PIECE[m];
  ed.select(null);
  ed.setFurnitureKind(kindId);
  ed.setTool('furniture');
  useStorage.getState().setAdding({ kindId, what });
}

/** The words for a piece armed from an Add link, in the tool's hint (null: none armed). */
export function useAddingHint(): string | null {
  const adding = useStorage((s) => s.adding);
  const tool = useEditor((s) => s.tool);
  const kind = useEditor((s) => s.furnitureKind);
  if (!adding || tool !== 'furniture' || kind !== adding.kindId) return null;
  const name = `${adding.what.slice(0, 1).toUpperCase()}${adding.what.slice(1)}`;
  return `${name} chosen. Click the plan where it goes; Esc to cancel.`;
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
        <span className="num">{value}</span>
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
  const set = useStorage((s) => s.set);
  // One line read per change: "Bedroom: 1 adult and 1 child".
  const [said, setSaid] = useState('');
  const setPeople = (roomId: string, name: string, people: People) => {
    useStorage.getState().setPeople(roomId, people, view.alias, view.known);
    setSaid(`${name}: ${peopleText(people)}`);
  };
  const setOthers = (people: People) => {
    set({ others: people });
    setSaid(`Without a bed: ${peopleText(people)}`);
  };
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
            onChange={(adults) => setPeople(r.roomId, r.name, { ...r.people, adults })}
          />
          <Stepper
            label="Children"
            where={`in ${r.name}`}
            value={r.people.children}
            onChange={(children) => setPeople(r.roomId, r.name, { ...r.people, children })}
          />
        </div>
      ))}
      <div className="storage-people">
        <p className="storage-people-room">Also living here, without a bed drawn</p>
        <Stepper
          label="Adults"
          where="without a bed"
          value={setting.others.adults}
          onChange={(adults) => setOthers({ ...setting.others, adults })}
        />
        <Stepper
          label="Children"
          where="without a bed"
          value={setting.others.children}
          onChange={(children) => setOthers({ ...setting.others, children })}
        />
      </div>
      {edited && (
        <button
          type="button"
          className="link-btn storage-reset"
          onClick={() => {
            useStorage.getState().resetPeople();
            setSaid('Back to the beds');
          }}
        >
          Reset to the beds
        </button>
      )}
      <p className="visually-hidden" aria-live="polite">
        {said}
      </p>
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
  // Nothing drawn (with or without people to compare with): the empty state, never a shortfall.
  const empty = meter.have <= 0;
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
          <span className={`storage-status${status.warn ? ' storage-status-warn' : ''}`}>
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
              <button type="button" className="link-btn" onClick={() => addPiece(m)}>
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
      {room.pieces.length > 0 && <Pieces level={level} pieces={room.pieces} roomId={room.roomId} />}
      {gains.length > 0 && (
        <p className="storage-note storage-gain">{gains.join(', ')} in the renovation</p>
      )}
    </li>
  );
}

function Pieces({
  level,
  pieces,
  roomId,
}: {
  level: Level;
  pieces: StorageRoom['pieces'];
  roomId: string | null;
}) {
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
              onClick={(e) => {
                // Back to storage comes back here: this card, scrolled as it was.
                const scroll = e.currentTarget.closest('.inspector')?.scrollTop ?? 0;
                useStorage.getState().setReturnTo({ scroll, roomId });
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

/** The panel: the finding, who lives here, four meters, how much you own, room by room, notes. */
export function StoragePanel() {
  const view = useStorageReport();
  const setting = useStorage((s) => s.setting);
  const set = useStorage((s) => s.set);
  const intro = useStorage((s) => s.intro);
  const rates = useRates((s) => s.rates);
  const heading = useRef<HTMLHeadingElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const nobody = !!view && count(view.report.people) === 0;
  const [change, setChange] = useState<boolean | null>(null);
  const [copied, setCopied] = useState<'' | 'done' | 'failed'>('');
  // A fresh open starts at the top, focus on its heading; back from a piece, where it was, focus
  // on that piece's card.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on mounting only
  useEffect(() => {
    const sheet = heading.current?.closest('.inspector');
    const back = useStorage.getState().returnTo;
    useStorage.getState().setReturnTo(null);
    if (back) {
      if (sheet) sheet.scrollTop = back.scroll;
      const name = back.roomId
        ? document.querySelector<HTMLButtonElement>(
            `.storage-card[data-room="${CSS.escape(
              view?.report.rooms.find((r) => r.roomId === back.roomId)?.name ?? '',
            )}"] .storage-card-name`,
          )
        : null;
      (name ?? heading.current)?.focus({ preventScroll: true });
      return;
    }
    sheet?.scrollTo?.({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, []);
  // A rule under the sheet's header once its body scrolls under it.
  useEffect(() => {
    const sheet = heading.current?.closest('.inspector');
    if (!sheet) return;
    const on = () => head.current?.toggleAttribute('data-scrolled', sheet.scrollTop > 4);
    on();
    sheet.addEventListener('scroll', on, { passive: true });
    return () => sheet.removeEventListener('scroll', on);
  }, []);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(''), 2000);
    return () => clearTimeout(t);
  }, [copied]);
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
  // Folded to one line, with Change; open while nobody is counted (it's what to do first).
  const open = change ?? nobody;
  const shelter = report.rooms.find((r) => r.store?.kind === 'shelter');
  const copy = async () => {
    const name = AMOUNTS.find((a) => a.value === setting.amount)?.label ?? '';
    try {
      await navigator.clipboard.writeText(copyText(level, report, rates, name));
      setCopied('done');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <section className="storage" aria-labelledby="storage-h">
      <div className="inspector-head storage-head" ref={head}>
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
        {open && <Household view={view} />}
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

      <div className="storage-own">
        <span className="field-label" aria-hidden="true">
          How much you own
        </span>
        <Segmented
          label="How much you own"
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
              <Pieces level={level} pieces={report.outside} roomId={null} />
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
        {copied === 'failed' && (
          <output className="storage-copy-failed">Couldn’t copy here.</output>
        )}
        <button type="button" className="btn btn-primary btn-block" onClick={copy}>
          {copied === 'done' ? (
            'Copied'
          ) : (
            <>
              <span className="label-long">Copy summary</span>
              <span className="label-short" aria-hidden="true">
                Copy
              </span>
            </>
          )}
        </button>
        <button type="button" className="btn btn-block" onClick={close}>
          Close
        </button>
        <p className="visually-hidden" aria-live="polite">
          {copied === 'done' ? 'Copied: paste it into a chat.' : ''}
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

// --- adding a piece from an Add link ----------------------------------------------------------

/**
 * Over the plan while a piece armed from an Add link waits to be placed: what to do, and Cancel.
 * Once it's placed, the panel comes back (the piece let go) so the meter shows it counted.
 */
export function StorageAddBar() {
  const adding = useStorage((s) => s.adding);
  const tool = useEditor((s) => s.tool);
  const kind = useEditor((s) => s.furnitureKind);
  const selection = useEditor((s) => s.selection);
  const level = useLevel();
  const armed = !!adding && tool === 'furniture' && kind === adding.kindId;
  // Another tool or piece picked: no longer adding.
  useEffect(() => {
    if (adding && !armed) useStorage.getState().setAdding(null);
  }, [adding, armed]);
  // Placed: back to Select and the panel.
  useEffect(() => {
    if (!armed || selection?.kind !== 'item') return;
    if (level?.items[selection.id]?.assetId !== adding?.kindId) return;
    useStorage.getState().setAdding(null);
    const ed = useEditor.getState();
    ed.select(null);
    ed.setTool('select');
  }, [armed, selection, level, adding]);
  if (!armed || !adding) return null;
  const touch = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
  return (
    <output className="storage-add-bar">
      <span>
        {touch ? 'Tap' : 'Click'} where the {adding.what} goes
      </span>
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          useStorage.getState().setAdding(null);
          useEditor.getState().setTool('select');
        }}
      >
        Cancel
      </button>
    </output>
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

/** A chip under a room's label, in plan metres: its box and words. */
interface PlacedChip {
  roomId: string;
  text: string;
  warn: boolean;
  empty: boolean;
  /** The box's top-left and size, in metres; the font in metres. */
  x: number;
  y: number;
  w: number;
  h: number;
  font: number;
}

/** A plan narrower than this gets the short chips, at 11 px. */
const SMALL_PLAN = 560;

/**
 * The chips for the panel's report at this zoom: each bedroom's clothes under its label, the
 * kitchen's shelves under the kitchen's (a kitchen room with nothing drawn: "No kitchen
 * cabinets"). Placed in plan metres, so clearance labels can keep off them.
 */
function placeChips(
  level: Level,
  geom: PlanGeometry,
  zoom: number,
  report: StorageReport,
  small: boolean,
): PlacedChip[] {
  const wanted: { roomId: string; text: string; warn: boolean; empty: boolean }[] = [];
  for (const r of report.rooms) {
    if (!r.clothes || r.clothes.target === undefined) continue;
    wanted.push({ roomId: r.roomId, ...chipText('clothes', r.clothes, small) });
  }
  const kitchenRoom =
    report.kitchenRoomId ??
    Object.values(level.rooms)
      .filter((r) => roomKind(r.name) === 'kitchen')
      .sort((a, b) => a.name.localeCompare(b.name))[0]?.id;
  const k = report.home.kitchen;
  if (kitchenRoom && (k.have > 0 || k.target !== undefined)) {
    if (!wanted.some((c) => c.roomId === kitchenRoom)) {
      wanted.push({ roomId: kitchenRoom, ...chipText('kitchen', k, small) });
    }
  }
  const labels = new Map(roomLabelBoxes(level, geom, zoom).map((l) => [l.id, l]));
  const px = 1 / zoom;
  const font = (small ? 11 : 12) * px;
  const out: PlacedChip[] = [];
  for (const c of wanted) {
    const l = labels.get(c.roomId);
    if (!l) continue;
    const w = (c.text.length * (small ? 11 : 12) * 0.56 + 12) * px;
    const h = font + 8 * px;
    out.push({ ...c, x: l.at.x - w / 2, y: l.at.y + (l.area ? 22 : 12) * px, w, h, font });
  }
  return out;
}

/** The chips' boxes while the panel is open, for other labels to keep off (none when shut). */
export function useStorageChipBoxes(
  level: Level,
  geom: PlanGeometry,
  zoom: number,
  width: number,
): { at: Vec2; half: Vec2 }[] {
  const open = useStorage((s) => s.open);
  const sv = useStorageReport();
  return useMemo(() => {
    if (!open || !sv || sv.level !== level) return [];
    return placeChips(level, geom, zoom, sv.report, width < SMALL_PLAN).map((c) => ({
      at: { x: c.x + c.w / 2, y: c.y + c.h / 2 },
      half: { x: c.w / 2, y: c.h / 2 },
    }));
  }, [open, sv, level, geom, zoom, width]);
}

/**
 * "Wardrobe 1.20 of 2.00 m" under each bedroom's label, "Shelves 4.8 of 12 m" at the kitchen:
 * neutral, amber when something drawn needs more, dashed when nothing is drawn. In plan metres,
 * drawn under the clearance marks (a safety label wins). Left out of pictures.
 */
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
  const chips = useMemo(
    () =>
      open && sv && sv.level === level
        ? placeChips(level, geom, view.zoom, sv.report, size.width < SMALL_PLAN)
        : [],
    [open, sv, level, geom, view.zoom, size.width],
  );
  if (!chips.length) return null;
  const px = 1 / view.zoom;
  return (
    <g
      className="storage-chips"
      pointerEvents="none"
      data-export="skip"
      data-testid="storage-chips"
    >
      {chips.map((c) => (
        <g
          key={c.roomId}
          className={`storage-chip${c.warn ? ' storage-chip-warn' : ''}${c.empty ? ' storage-chip-empty' : ''}`}
          data-testid="storage-chip"
        >
          <rect x={c.x} y={c.y} width={c.w} height={c.h} rx={c.h / 2} strokeWidth={px} />
          <text
            className="num"
            x={c.x + c.w / 2}
            y={c.y + c.h / 2 + c.font * 0.35}
            textAnchor="middle"
            fontSize={c.font}
          >
            {c.text}
          </text>
        </g>
      ))}
    </g>
  );
});
