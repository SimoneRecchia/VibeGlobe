// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Locale details the coordinate controls need. */

/** The decimal separator of a language's number format. */
export function decimalSeparator(language: string): '.' | ',' {
  const part = new Intl.NumberFormat(language).formatToParts(1.5).find(({ type }) => type === 'decimal');
  return part?.value === ',' ? ',' : '.';
}
