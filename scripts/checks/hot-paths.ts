import type { SourceFile } from '../workspace.ts';

/**
 * Hot-path modules (`*.hot.ts`) may trade readability for speed, so each one opens with a TSDoc header that names
 * why (`@hotpath <reason>`) and the benchmark that justifies it (`@benchmark <path from the repository root>`).
 */
export function findHotPathViolations(sources: SourceFile[], fileExists: (path: string) => boolean): string[] {
  const violations: string[] = [];
  for (const source of sources) {
    const isHot = source.path.endsWith('.hot.ts');
    // The header follows the license notice's line comments.
    const header = /^\s*(?:\/\/[^\n]*\n\s*)*\/\*\*([\s\S]*?)\*\//.exec(source.content)?.[1] ?? '';
    if (!isHot) {
      if (/@hotpath\b/.test(source.content)) violations.push(`${source.path}: @hotpath modules must be named *.hot.ts`);
      continue;
    }
    const reason = /@hotpath[ \t]+(\S.*)/.exec(header)?.[1];
    const benchmark = /@benchmark[ \t]+(\S+)/.exec(header)?.[1];
    if (!reason) violations.push(`${source.path}: header must state "@hotpath <reason>"`);
    if (!benchmark) violations.push(`${source.path}: header must name "@benchmark <path>"`);
    else if (!fileExists(benchmark)) violations.push(`${source.path}: benchmark "${benchmark}" does not exist`);
  }
  return violations;
}
