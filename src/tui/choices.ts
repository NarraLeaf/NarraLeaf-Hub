/**
 * The lists an operator picks from.
 *
 * Choosing rather than typing is the point: the name is already on the screen
 * the picker opens over, and asking somebody to type one is asking them to
 * misspell it.
 */

/** One row of a picker: what it is, and what is true of it now. */
export interface Choice {
  readonly name: string;
  /** The state a reader needs in order to choose, never a restatement of the name. */
  readonly note: string;
}

export function clamp(choice: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.min(Math.max(choice, 0), length - 1);
}
