// Chromium flags for the browser tests and benchmarks. By default (ADR 0012), GPU-less machines render WebGL2 through
// SwiftShader (ANGLE) and WebGPU through its SwiftShader adapter, so every test can choose a backend with
// ?backend=webgpu or ?backend=webgl2. With VIBEGLOBE_HARDWARE_GPU=1 the machine's own GPU is used instead
// (docs/guides/hardware-testing.md).
const SOFTWARE_GPU_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader',
];

const HARDWARE_GPU_ARGS = ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'];

const BACKGROUND_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

/** True when the tests and benchmarks should use the machine's GPU. */
export function hardwareGpu(): boolean {
  return process.env['VIBEGLOBE_HARDWARE_GPU'] === '1';
}

/** The Chromium flags for the selected GPU, software or hardware. */
export function gpuArgs(hardware = hardwareGpu()): string[] {
  return [...(hardware ? HARDWARE_GPU_ARGS : SOFTWARE_GPU_ARGS), ...BACKGROUND_ARGS];
}
