import { sha256 } from '@driftmark/core';
import { TARGETS, type Target } from './targets.js';

/**
 * The expansion draw (`study/plan.md` §5, "Expansion order"). Every slice is a
 * stratum: one target crossed with one size band, whose pool is the
 * repositories its recorded search pages queued and whose weight is its
 * page-1 `total_count`. Each draw:
 *
 * 1. picks the target with the fewest files collected so far among targets
 *    that still have an undrawn repository, ties in `TARGETS` order, so the
 *    file cap splits roughly evenly across targets and a target that runs out
 *    passes its share on;
 * 2. picks that target's band with the smallest `drawn / weight`, ties in
 *    `SIZE_BANDS` order, so draws within a target follow `total_count`;
 * 3. takes the band's next repository in `sha256(seed:repo)` order, which is
 *    random but reproducible from the seed. A repository drawn from one pool
 *    is gone from every pool.
 *
 * The draw holds no state that is not rebuilt from the seed, the recorded
 * responses and the file counts the caller feeds back, so a resumed run that
 * replays the same counts draws the same sequence.
 */

/** The method name written to `sampling.jsonl`. */
export const SAMPLING_METHOD = 'stratified-v1';

export type TargetPattern = Target['pattern'];

/** One slice as a stratum of the draw. */
export interface Stratum {
  sliceId: string;
  target: TargetPattern;
  /** The slice's page-1 `total_count`. */
  weight: number;
  /** Every repository the slice's recorded pages queued. */
  pool: ReadonlySet<string>;
}

export interface Draw {
  repo: string;
  /** The stratum the repository was drawn for. */
  sliceId: string;
}

interface Band {
  sliceId: string;
  weight: number;
  /** The pool in draw order. */
  order: string[];
  /** Everything before it is drawn. */
  cursor: number;
  drawn: number;
}

interface TargetBands {
  target: TargetPattern;
  /** In `SIZE_BANDS` order, which is the order `buildSlices` emits them in. */
  bands: Band[];
}

export class StratifiedDraw {
  readonly #targets: TargetBands[];
  readonly #taken = new Set<string>();

  /** `strata` in `buildSlices` order: targets in `TARGETS` order, bands in `SIZE_BANDS` order. */
  constructor(strata: readonly Stratum[], seed: string) {
    const keys = new Map<string, string>();
    const key = (repo: string): string => {
      let value = keys.get(repo);
      if (value === undefined) {
        value = sha256(`${seed}:${repo}`);
        keys.set(repo, value);
      }
      return value;
    };
    this.#targets = TARGETS.map((target) => ({
      target: target.pattern,
      bands: strata
        .filter((stratum) => stratum.target === target.pattern)
        .map((stratum) => ({
          sliceId: stratum.sliceId,
          weight: stratum.weight,
          order: [...stratum.pool].sort((a, b) => compare(key(a), key(b)) || compare(a, b)),
          cursor: 0,
          drawn: 0,
        })),
    }));
  }

  /**
   * The next repository, or `null` when every pool is empty. `files` is the
   * number of files collected so far per target; a target missing from it
   * counts as zero.
   */
  next(files: ReadonlyMap<TargetPattern, number>): Draw | null {
    let target: TargetBands | undefined;
    let targetFiles = 0;
    for (const candidate of this.#targets) {
      if (!candidate.bands.some((band) => this.#peek(band) !== undefined)) continue;
      const count = files.get(candidate.target) ?? 0;
      // Strictly fewer, so a tie keeps the earlier target.
      if (target === undefined || count < targetFiles) {
        target = candidate;
        targetFiles = count;
      }
    }
    if (target === undefined) return null;

    let band: Band | undefined;
    let bandShare = 0;
    for (const candidate of target.bands) {
      if (this.#peek(candidate) === undefined) continue;
      // A band whose page 1 reported a total of 0 yet queued repositories
      // has no weight to share by, so it is drawn only after the others.
      const share = candidate.weight > 0 ? candidate.drawn / candidate.weight : Infinity;
      if (band === undefined || share < bandShare) {
        band = candidate;
        bandShare = share;
      }
    }
    const repo = band === undefined ? undefined : this.#peek(band);
    if (band === undefined || repo === undefined) {
      // Unreachable: the target was chosen because one of its bands has a repository.
      throw new Error('stratified draw chose a target with no repository left');
    }

    band.cursor++;
    band.drawn++;
    this.#taken.add(repo);
    return { repo, sliceId: band.sliceId };
  }

  /** The band's next undrawn repository, skipping any drawn from another pool. */
  #peek(band: Band): string | undefined {
    for (; band.cursor < band.order.length; band.cursor++) {
      const repo = band.order[band.cursor];
      if (repo !== undefined && !this.#taken.has(repo)) return repo;
    }
    return undefined;
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
