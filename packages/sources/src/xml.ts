// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { parse, type TNode } from 'txml/txml';

/**
 * A small XML element tree for capabilities documents, KML and GPX, on top of `txml` (which runs in workers, where no
 * DOMParser exists). Names are matched by local name, so namespace prefixes do not matter.
 */
export type XmlElement = TNode;

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes the predefined and numeric character references. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return safeChar(parseInt(name.slice(2), 16), whole);
    if (name.startsWith('#')) return safeChar(parseInt(name.slice(1), 10), whole);
    return ENTITIES[name] ?? whole;
  });
}

function safeChar(code: number, fallback: string): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

/** The local part of a qualified name. */
function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

/** Parses a document and returns its root element; throws a descriptive error when there is none. */
export function parseXml(text: string): XmlElement {
  const nodes = parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, {
    selfClosingTags: [],
    keepComments: false,
  });
  const root = nodes.find(
    (n): n is TNode => typeof n !== 'string' && !n.tagName.startsWith('?') && !n.tagName.startsWith('!'),
  );
  if (!root) throw new Error('no XML root element');
  return root;
}

/** The element children of `element`, optionally only those with local name `name`. */
export function elements(element: XmlElement | undefined, name?: string): XmlElement[] {
  if (!element) return [];
  const out: XmlElement[] = [];
  for (const child of element.children)
    if (typeof child !== 'string' && (name === undefined || localName(child.tagName) === name)) out.push(child);
  return out;
}

/** The first element child with local name `name`. */
export function element(parent: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!parent) return undefined;
  for (const child of parent.children) if (typeof child !== 'string' && localName(child.tagName) === name) return child;
  return undefined;
}

/** Follows a path of local names from `parent`. */
export function path(parent: XmlElement | undefined, ...names: string[]): XmlElement | undefined {
  let current = parent;
  for (const name of names) current = element(current, name);
  return current;
}

/** The trimmed text content of an element (txml returns CDATA sections as text), with entities decoded. */
export function text(node: XmlElement | undefined): string {
  if (!node) return '';
  let out = '';
  for (const child of node.children) if (typeof child === 'string') out += child;
  return decodeEntities(out).trim();
}

/** The text of the child with local name `name`. */
export function childText(parent: XmlElement | undefined, name: string): string {
  return text(element(parent, name));
}

/** An attribute by local name, with entities decoded. */
export function attribute(node: XmlElement | undefined, name: string): string | undefined {
  if (!node) return undefined;
  for (const [key, value] of Object.entries(node.attributes))
    if (localName(key) === name && typeof value === 'string') return decodeEntities(value);
  return undefined;
}
