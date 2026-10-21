// The recovery's asynchronous steps, slowed once `slowRecovery` is set: the device request (initRenderer) and pipeline
// compilation (the warm-up). Each records its name in `recoveryStep` while it waits, so a test can destroy the globe
// inside it. destroy() there must leave nothing behind (KB-035).
export function slowRecoverySteps(): void {
  const state = window as unknown as { slowRecovery?: boolean; recoveryStep?: string };
  const slowed = async <T>(step: string, value: Promise<T>): Promise<T> => {
    const result = await value;
    if (state.slowRecovery) {
      state.recoveryStep = step;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return result;
  };
  const adapter = globalThis.GPUAdapter?.prototype;
  if (!adapter) return;
  const requestDevice = adapter.requestDevice;
  adapter.requestDevice = function (this: GPUAdapter, ...args: Parameters<GPUAdapter['requestDevice']>) {
    return slowed('device request', requestDevice.apply(this, args));
  };
  const createPipeline = GPUDevice.prototype.createRenderPipelineAsync;
  GPUDevice.prototype.createRenderPipelineAsync = function (
    this: GPUDevice,
    ...args: Parameters<GPUDevice['createRenderPipelineAsync']>
  ) {
    return slowed('pipeline warm-up', createPipeline.apply(this, args));
  };
}
