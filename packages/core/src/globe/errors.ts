// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Error codes the engine reports. */
export type GlobeErrorCode =
  | 'invalid-option'
  | 'invalid-coordinate'
  | 'unsupported-device'
  | 'renderer-failed'
  | 'resource-failed'
  | 'destroyed'
  | 'display-only'
  | 'aborted';

/** The engine's typed error: every failure the engine reports carries a stable code. */
export class GlobeError extends Error {
  readonly code: GlobeErrorCode;

  constructor(code: GlobeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GlobeError';
    this.code = code;
  }
}

/** The message of anything thrown: an error's own, or the value as a string. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
