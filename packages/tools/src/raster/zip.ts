// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Extracts one member of a zip archive (stored or DEFLATE), as Natural Earth distributes its rasters. */
import { inflateRawSync } from 'node:zlib';

/** The names of every member of a zip archive. */
function zipMembers(zip: Uint8Array): { name: string; method: number; size: number; offset: number }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('zip: end of central directory not found');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const members = [];
  for (let i = 0; i < count; i++) {
    const nameLength = view.getUint16(at + 28, true);
    members.push({
      name: new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength)),
      method: view.getUint16(at + 10, true),
      size: view.getUint32(at + 20, true),
      offset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return members;
}

/** The bytes of the member whose name ends with `name`. */
export function extractZipMember(zip: Uint8Array, name: string): Uint8Array {
  const member = zipMembers(zip).find((m) => m.name === name || m.name.endsWith(`/${name}`));
  if (!member) throw new Error(`zip: no member named ${name}`);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const start =
    member.offset + 30 + view.getUint16(member.offset + 26, true) + view.getUint16(member.offset + 28, true);
  const data = zip.subarray(start, start + member.size);
  if (member.method === 0) return data;
  if (member.method === 8) return new Uint8Array(inflateRawSync(data));
  throw new Error(`zip: unsupported compression method ${member.method}`);
}
