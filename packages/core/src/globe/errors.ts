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
