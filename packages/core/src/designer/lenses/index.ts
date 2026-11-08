import type { Level } from '../../schema';
import type { DesignOptions, DesignResult } from '../result';
import type { DesignBrief } from '../schema';
import { type Lens, type LensReport, type SteerInput, lensOn, mergeSteers } from './lens';
import { storageLens } from './storage';

export * from './lens';
export {
  type StorageHousehold,
  householdEdited,
  peopleWords,
  storageBlock,
  storageLens,
  storageLine,
  storageSettingFor,
} from './storage';

/** Every lens there is, in the order a card shows them. */
export const LENSES: readonly Lens[] = [storageLens];

/** The reports of the lenses switched on, for a version as placed on `start`. */
export function lensReports(
  result: DesignResult,
  start: Level,
  brief: DesignBrief,
  opts: DesignOptions = {},
): LensReport[] {
  return LENSES.filter((l) => lensOn(opts, l.id)).map((l) =>
    l.report({ result, start, brief, opts }),
  );
}

/** What the lenses switched on ask of the solver for one space (null: nothing). */
export function steerFor(i: SteerInput) {
  return mergeSteers(LENSES.filter((l) => lensOn(i.opts, l.id)).map((l) => l.steer?.(i)));
}
