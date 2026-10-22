import { SourceConfigError } from '../metadata.js';

/** Bytes a capabilities document may have; larger answers are refused. */
const MAX_CAPABILITIES_BYTES = 16 * 1024 * 1024;

/**
 * Loads and parses a capabilities document given as XML text (starting with `<`) or as a URL; every failure becomes a
 * {@link SourceConfigError} that names the source, never an exception from the parser.
 */
export async function loadCapabilities<T>(
  capabilities: string,
  fetchImpl: typeof fetch | undefined,
  id: string,
  service: string,
  parse: (xml: string) => T,
): Promise<T> {
  let xml = capabilities;
  if (!capabilities.trimStart().startsWith('<')) {
    try {
      const response = await (fetchImpl ?? ((input, init) => fetch(input, init)))(capabilities, {
        mode: 'cors',
        credentials: 'omit',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      xml = await response.text();
    } catch (error) {
      throw new SourceConfigError(
        'unreachable-capabilities',
        `${service} source '${id}': cannot load the capabilities (${String(error)})`,
      );
    }
  }
  if (xml.length > MAX_CAPABILITIES_BYTES)
    throw new SourceConfigError(
      'invalid-capabilities',
      `${service} source '${id}': the capabilities document is too large`,
    );
  try {
    return parse(xml);
  } catch (error) {
    throw new SourceConfigError(
      'invalid-capabilities',
      `${service} source '${id}': invalid capabilities document (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
