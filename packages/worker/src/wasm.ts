/** Fetches and compiles a WebAssembly module shipped next to the worker program; streaming where the server sends `application/wasm`. */
export async function compileWasm(url: URL): Promise<WebAssembly.Module> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.href} answered ${response.status}`);
  if (response.headers.get('Content-Type')?.startsWith('application/wasm'))
    return WebAssembly.compileStreaming(response);
  return WebAssembly.compile(await response.arrayBuffer());
}
