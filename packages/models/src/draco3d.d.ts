/** Types of the parts of Google's `draco3d` package (Apache-2.0) this package calls; the package ships none. */
declare module 'draco3d' {
  /** Emscripten module options: where the decoder's `.wasm` file is (a browser serves it from the consumer's host). */
  interface DracoModuleOptions {
    readonly locateFile?: (file: string) => string;
  }
  export function createDecoderModule(options?: DracoModuleOptions): Promise<unknown>;
  export function createEncoderModule(options?: DracoModuleOptions): Promise<unknown>;
}
