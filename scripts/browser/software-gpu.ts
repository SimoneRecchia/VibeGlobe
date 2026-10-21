// ADR 0012: GPU-less machines render WebGL2 through SwiftShader (ANGLE) and WebGPU through its SwiftShader adapter, so
// every test and benchmark can choose a backend with ?backend=webgpu or ?backend=webgl2.
export const SOFTWARE_GPU_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];
