// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Fetches and compiles a WebAssembly module shipped next to the worker program; streaming where the server sends `application/wasm`. */
export async function compileWasm(url: URL): Promise<WebAssembly.Module> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.href} answered ${response.status}`);
  if (response.headers.get('Content-Type')?.startsWith('application/wasm'))
    return WebAssembly.compileStreaming(response);
  return WebAssembly.compile(await response.arrayBuffer());
}
