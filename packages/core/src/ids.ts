import { customAlphabet } from 'nanoid';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const make = customAlphabet(alphabet, 10);

export type IdPrefix = 'prj' | 'lvl' | 'v' | 'w' | 'op' | 'rm' | 'it' | 'lt' | 'mdl';

/** Prefixed ids make documents readable when debugging, e.g. `w_k3j9a0b2cd`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${make()}`;
}
