/** Locale details the coordinate controls need. */

/** The decimal separator of a language's number format. */
export function decimalSeparator(language: string): '.' | ',' {
  const part = new Intl.NumberFormat(language).formatToParts(1.5).find(({ type }) => type === 'decimal');
  return part?.value === ',' ? ',' : '.';
}
