// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** A few lines of TypeScript or HTML colored by token kind: comments, strings, numbers and keywords. */

const TOKENS =
  /(\/\/.*$|<!--.*?-->)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(\d[\d_.]*)\b|\b(import|from|const|let|await|async|new|return|if|else|for|of|export|true|false|type|declare|function)\b/gm;
const KINDS = ['comment', 'string', 'number', 'keyword'] as const;

/** The code as text nodes and spans of class `tour-tok--<kind>`. */
export function highlight(code: string): Node[] {
  const nodes: Node[] = [];
  let last = 0;
  for (const match of code.matchAll(TOKENS)) {
    const at = match.index;
    if (at > last) nodes.push(document.createTextNode(code.slice(last, at)));
    const kind = KINDS[match.slice(1).findIndex((group) => group !== undefined)] ?? 'keyword';
    const span = document.createElement('span');
    span.className = `tour-tok--${kind}`;
    span.textContent = match[0];
    nodes.push(span);
    last = at + match[0].length;
  }
  if (last < code.length) nodes.push(document.createTextNode(code.slice(last)));
  return nodes;
}
