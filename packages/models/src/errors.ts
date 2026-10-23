/**
 * Why a model could not be read (F361):
 * - 'invalid-glb': the GLB container is truncated or malformed;
 * - 'invalid-json': the glTF JSON does not parse;
 * - 'invalid-gltf': the document breaks the glTF 2.0 schema or its references point nowhere;
 * - 'unsupported': the document requires an extension or feature this package does not read;
 * - 'missing-resource': an external buffer or image was not supplied or could not be fetched;
 * - 'decode-failed': a Draco or meshopt stream did not decode to the declared data;
 * - 'too-large': the model exceeds a size limit of {@link ModelLimits}.
 */
export type ModelErrorCode =
  'invalid-glb' | 'invalid-json' | 'invalid-gltf' | 'unsupported' | 'missing-resource' | 'decode-failed' | 'too-large';

/** The error every model reader throws; `code` survives the worker boundary as the task's error code. */
export class ModelError extends Error {
  readonly code: ModelErrorCode;

  constructor(code: ModelErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'ModelError';
    this.code = code;
  }
}

/** Throws a ModelError with the code unless the condition holds. */
export function check(condition: boolean, code: ModelErrorCode, message: string): asserts condition {
  if (!condition) throw new ModelError(code, message);
}
