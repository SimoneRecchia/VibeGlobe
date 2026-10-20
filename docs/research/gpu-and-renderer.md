# GPU resource management and renderer backends

Survey for milestone M1. M2 builds the decision, which is recorded in [ADR 0010](../adr/0010-renderer-base.md). Related decisions: [precision (0004)](../adr/0004-precision-strategy.md), [depth (0005)](../adr/0005-depth-strategy.md), [scheduling and caching (0007)](../adr/0007-scheduling-and-caching.md), [workers (0011)](../adr/0011-workers.md) and [test tooling (0012)](../adr/0012-test-tooling.md).

## Scope and requirements

This survey covers how geometry, textures and shaders reach the GPU and stay valid there:

- buffer and texture creation, uploads and upload budgets;
- pipeline creation and caching (a pipeline is a shader plus its fixed-function state);
- draw-call batching, instancing, texture arrays and state sorting;
- single-source shaders and device or context loss;
- the backend itself: WebGPU with an automatic WebGL2 fallback.

`PLAN.md` requirements it serves:

- **Fixed constraints:**
  - WebGPU is the primary backend, with an automatic WebGL2 fallback. Devices without WebGL2 are out of scope.
  - Only permissively licensed code is shipped.
- **Engineering standards:**
  - minimal draw calls and state changes, through batching, instancing, texture arrays and state sorting;
  - no redundant uploads and no garbage in hot paths;
  - the same picture on both backends;
  - budgets enforced by benchmarks.
- **Tiles:**
  - uploads spread across frames;
  - a GPU memory budget with LRU eviction;
  - GPU texture compression where it helps.
- **Robustness:**
  - recovery from device or context loss without reloading the page;
  - `destroy()` frees GPU memory, and several instances can share a page;
  - a strict Content Security Policy (CSP).
- **Architecture guidance:**
  - three.js `WebGPURenderer` with TSL (three.js Shading Language), behind the engine's own interface;
  - automatic matrix updates and frustum culling turned off;
  - explicit uploads and a pinned three.js version.
- **Testing:**
  - visual regression on both backends;
  - software-rendered WebGL2 in CI (continuous integration);
  - device loss injected in chaos tests.

## Projects studied

| Project    | Version (commit)                     | License           | Read                                                                                                                                     |
| ---------- | ------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| three.js   | r186, which is npm 0.186.1 (9b4a2ac) | MIT               | `src/renderers/{common,webgpu,webgl-fallback}`, `src/nodes/accessors`, `src/textures`, `test/e2e`, `test/unit/addons/tsl`, CI workflow   |
| Babylon.js | 9.30.0 (b248b37)                     | Apache-2.0        | `packages/dev/core/src/Engines` (with `WebGPU/`), `Buffers`, `Materials/Textures`, `Meshes/abstractMesh.pure.ts`, `packages/tools/tests` |
| PlayCanvas | v2.23.3 (b7655d8)                    | MIT               | `src/platform/graphics/{.,webgl,webgpu}`, `src/scene/layer.js`, `src/scene/shader-lib`, `test`, CI workflow                              |
| Filament   | v1.78.0 (c1dc4e4)                    | Apache-2.0        | `filament/backend` (`include`, `src/webgpu`, `src/vulkan`), `filament/src/RenderPass.h`, `test/renderdiff`                               |
| bgfx       | master (d8d6acd)                     | BSD-2-Clause      | `include/bgfx/bgfx.h`, `src/bgfx_p.h`, `src/renderer_*.cpp`                                                                              |
| Bevy       | v0.20.0 (b3bdd75)                    | MIT or Apache-2.0 | `crates/bevy_render` (render assets, slab allocator, render phases, pipeline cache, error handler, settings), CI workflows               |
| Godot      | 4.7.2-stable (ed1daf0)               | MIT               | `servers/rendering/rendering_device.cpp`, `drivers/{vulkan,gles3}`, `platform/web`, CI workflows                                         |
| O3DE       | 2605.0 (3db6943)                     | Apache-2.0 or MIT | `Gems/Atom/RHI` (`Code`, `DX12`, `Vulkan`), `AutomatedTesting/Gem/PythonTests/Atom`                                                      |
| CesiumJS   | 1.146 (b8d3a36)                      | Apache-2.0        | `packages/engine/Source/{Renderer,Scene}`, `Specs`, CI workflows                                                                         |

## How each project solves it

### three.js r186 (`WebGPURenderer`)

**Backend choice.**

- `WebGPURenderer` builds a `WebGPUBackend` and passes it a `getFallback` that constructs a `WebGLBackend` ([`WebGPURenderer.js` L53–75](https://github.com/mrdoob/three.js/blob/r186/src/renderers/webgpu/WebGPURenderer.js#L53-L75)).
- `Renderer.init()` calls the fallback only when the primary backend's `init` throws, for example when there is no adapter or `requestDevice` fails ([`Renderer.js` L784–830](https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/Renderer.js#L784-L830)).
- `forceWebGL: true` skips WebGPU entirely. Nothing switches backends after `init()`.
- The WebGPU backend:
  - requests the adapter with `featureLevel: 'compatibility'` and enables every feature the adapter offers;
  - turns multisampling off when the device lacks `core-features-and-limits` ([`WebGPUBackend.js` L214–264](https://github.com/mrdoob/three.js/blob/r186/src/renderers/webgpu/WebGPUBackend.js#L214-L264)).

**Buffers.**

- Attributes upload on first use, or during `compileAsync`, whenever their `version` changes.
- WebGPU creates buffers with `mappedAtCreation`, then updates only the `updateRanges` with `queue.writeBuffer` ([`WebGPUAttributeUtils.js` L160–265](https://github.com/mrdoob/three.js/blob/r186/src/renderers/webgpu/utils/WebGPUAttributeUtils.js#L160-L265)). WebGL2 uses `bufferData` and `bufferSubData`.
- Object-scope uniforms live in one uniform buffer (UBO) per render object. Each render object clones its own bindings ([`RenderObject.js` L436](https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/RenderObject.js#L436)).

**Textures.**

- `Textures.updateTexture` uploads when `texture.version` changes, and binds a default placeholder until the data is ready ([`Textures.js` L204–416](https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/Textures.js#L204-L416)).
- An upload normally happens lazily, on the first draw that binds the texture. `renderer.initTexture()`, synchronous since r181, forces it earlier ([`Renderer.js` L3083](https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/Renderer.js#L3083)).
- The two backends upload differently:
  - **WebGPU:** `copyExternalImageToTexture` for images and `writeTexture` for data, with mipmaps generated in render passes ([`WebGPUTextureUtils.js` L985–1010](https://github.com/mrdoob/three.js/blob/r186/src/renderers/webgpu/utils/WebGPUTextureUtils.js#L985-L1010)).
  - **WebGL2:** `texStorage*` followed by `texSubImage*` and `generateMipmap`.
- Array textures accept partial `layerUpdates`. Only compressed arrays upload mip levels per layer.
- `copyTextureToTexture` copies regions between textures and mip levels.
- `info.memory` keeps byte totals per resource class ([`Info.js` L117](https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/Info.js#L117)).
- WebGPU read-backs return rows padded to 256 bytes, top row first; WebGL2 read-backs are tightly packed, bottom row first ([L813](https://github.com/mrdoob/three.js/blob/r186/src/renderers/webgpu/utils/WebGPUTextureUtils.js#L813)).

**Pipelines and shaders.**

- Materials are TSL node graphs, which `WGSLNodeBuilder` and `GLSLNodeBuilder` turn into WGSL or GLSL ES 3.0. One source serves both backends.
- Pipelines are cached under a key built from the shader code and the render state, and reference-counted ([`Pipelines.js` L161](https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/Pipelines.js#L161)).
- `compileAsync` (L896) precompiles them, using `createRenderPipelineAsync` on WebGPU and `KHR_parallel_shader_compile` on WebGL2.
- Node building happens per material instance, so unique graphs are rebuilt ([#33821](https://github.com/mrdoob/three.js/issues/33821); measured below).
- TSL's default `modelViewMatrix` is a float32 product computed on the GPU; `highpModelViewMatrix` is a float64 product computed on the CPU ([`ModelNode.js` L128–198](https://github.com/mrdoob/three.js/blob/r186/src/nodes/accessors/ModelNode.js#L128-L198)).
- When the camera's clip-space convention differs from the backend's, the renderer silently recomputes the projection (WebGPU depth runs 0 to 1) ([`Renderer.js` L3637–3670](https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/Renderer.js#L3637-L3670)).

**Batching and sorting.**

- Batching tools:
  - `InstancedMesh`.
  - `BatchedMesh`, which uses `WEBGL_multi_draw` on WebGL2 ([`WebGLBufferRenderer.js` L59–77](https://github.com/mrdoob/three.js/blob/r186/src/renderers/webgl-fallback/WebGLBufferRenderer.js#L59-L77)) and a loop of single draws on WebGPU ([`WebGPUBackend.js` L2126–2187](https://github.com/mrdoob/three.js/blob/r186/src/renderers/webgpu/WebGPUBackend.js#L2126-L2187)).
  - Render bundles, on WebGPU only.
- Opaque objects are sorted by group order, `renderOrder`, depth and id, not by state ([`RenderList.js` L14–34](https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/RenderList.js#L14-L34)). `setOpaqueSort` (L2231) replaces the sort.
- Culling and matrices:
  - `_projectObject` skips the frustum test when `frustumCulled` is false (L3242).
  - The scene's matrix traversal is skipped when `scene.matrixWorldAutoUpdate` is false.

**Device loss.**

- WebGPU `device.lost` (unless the reason is `destroyed`) and WebGL `webglcontextlost` (after `preventDefault`) both call `onDeviceLost`.
- The default handler sets `_isDeviceLost`, after which `render()` returns immediately ([L1348–1360](https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/Renderer.js#L1348-L1360)).
- r186 has no way to restore:
  - there is no `webglcontextrestored` listener;
  - `init()` returns its cached promise;
  - on WebGL, `dispose()` calls `loseContext()` ([#34682](https://github.com/mrdoob/three.js/issues/34682), fixed for r187).
- Recovering therefore means creating a new renderer on a new canvas.

### Babylon.js 9.30.0

**Backend choice and shaders.**

- `EngineFactory.CreateAsync` returns a `WebGPUEngine` when WebGPU is supported, then a WebGL `Engine`, then a null engine ([`engineFactory.ts` L17](https://github.com/BabylonJS/Babylon.js/blob/9.30.0/packages/dev/core/src/Engines/engineFactory.ts#L17)).
- On WebGPU, shaders come either from a hand-ported WGSL library (`ShadersWGSL`, 158 entries beside 169 GLSL) or from GLSL converted at runtime by glslang and Tint WebAssembly (WASM) modules. By default those modules load from Babylon's CDN ([`webgpuEngine.pure.ts` L297](https://github.com/BabylonJS/Babylon.js/blob/9.30.0/packages/dev/core/src/Engines/webgpuEngine.pure.ts#L297)).

**Resources.**

- `WebGPUBufferManager.setSubData` wraps `writeBuffer` with alignment fixes.
- `WebGPUTextureManager` uploads images with `copyExternalImageToTexture` and generates mipmaps on the GPU.
- Render pipelines and bind groups are cached, the pipelines in a state tree (`webgpuCacheRenderPipelineTree.ts`).
- "Snapshot rendering" records render bundles for static scenes.
- Batching uses instances and thin instances, which are per-instance attribute buffers ([`thinInstanceMesh.pure.ts` L311](https://github.com/BabylonJS/Babylon.js/blob/9.30.0/packages/dev/core/src/Meshes/thinInstanceMesh.pure.ts#L311)).
- Per-mesh switches bypass the engine's own culling and bounds work: `alwaysSelectAsActiveMesh`, `doNotSyncBoundingInfo` and `freezeWorldMatrix` ([`abstractMesh.pure.ts` L953–958](https://github.com/BabylonJS/Babylon.js/blob/9.30.0/packages/dev/core/src/Meshes/abstractMesh.pure.ts#L953-L958)).

**Loss.**

- Unless `doNotHandleContextLost` is set, every texture keeps its source data (`texture._buffer`, [`abstractEngine.pure.ts` L1671](https://github.com/BabylonJS/Babylon.js/blob/9.30.0/packages/dev/core/src/Engines/abstractEngine.pure.ts#L1671)).
- Restoring rebuilds effects, buffers, internal textures and render targets after `initEngine()` (L685–740).
- On WebGPU, `device.lost` re-runs `initAsync` and clears the pipeline and bind-group caches ([`webgpuEngine.pure.ts` L826, L1286](https://github.com/BabylonJS/Babylon.js/blob/9.30.0/packages/dev/core/src/Engines/webgpuEngine.pure.ts#L826)).
- The cost is a CPU-side copy of every resource.

### PlayCanvas v2.23.3

**Backend choice and shaders.**

- `createGraphicsDevice` tries `deviceTypes` in order.
- Shaders exist twice, as GLSL chunks (267 files) and WGSL chunks (290 files) in `src/scene/shader-lib`.

**Uniforms and uploads.**

- Per-draw uniforms are sub-allocated from 100 kB staging and GPU buffer pairs and bound with dynamic offsets ([`webgpu-graphics-device.js` L1009](https://github.com/playcanvas/engine/blob/v2.23.3/src/platform/graphics/webgpu/webgpu-graphics-device.js#L1009)). This is the remedy three.js discusses in #30560.
- `UploadStream` makes uploads non-blocking:
  - **WebGL2:** a pool of pixel buffer objects (PBOs), each guarded by a `fenceSync` that is polled with `clientWaitSync(…, 0)` ([`webgl-upload-stream.js` L190–223](https://github.com/playcanvas/engine/blob/v2.23.3/src/platform/graphics/webgl/webgl-upload-stream.js#L190-L223)).
  - **WebGPU:** staging buffers recycled with `mapAsync` once their submission completes.

**Pipelines and sorting.**

- Render pipelines are cached by an FNV hash of their state ([`webgpu-render-pipeline.js` L167–251](https://github.com/playcanvas/engine/blob/v2.23.3/src/platform/graphics/webgpu/webgpu-render-pipeline.js#L167-L251)).
- Opaque layers sort by material, then mesh (`SORTMODE_MATERIALMESH`, [`layer.js` L143](https://github.com/playcanvas/engine/blob/v2.23.3/src/scene/layer.js#L143)).
- `BatchManager` merges static and dynamic meshes into batches (`src/scene/batching`).

**Loss.**

- Both backends run `loseContext()` and `restoreContext()` over every texture, buffer, render target, bind-group format and shader, using CPU-side data. Textures keep their source levels (`_levels`) for this.
- WebGPU recreates the device on `device.lost` unless the reason is `destroyed` ([L904–1000](https://github.com/playcanvas/engine/blob/v2.23.3/src/platform/graphics/webgpu/webgpu-graphics-device.js#L904-L1000)).
- `debugLoseContext(delay)` forces a real loss for tests ([`graphics-device.js` L1031](https://github.com/playcanvas/engine/blob/v2.23.3/src/platform/graphics/graphics-device.js#L1031)).

### Filament v1.78.0

**Architecture.**

- Backends: OpenGL and GLES (WebGL2 through Emscripten), Vulkan, Metal and WebGPU (through Dawn).
- Work goes through a command stream executed on a driver thread.

**Uploads.**

- An upload takes a `BufferDescriptor` whose callback hands the memory back after the copy ([`BufferDescriptor.h` L47–63](https://github.com/google/filament/blob/v1.78.0/filament/backend/include/backend/BufferDescriptor.h#L47-L63)).
- The WebGPU backend recycles staging buffers per submission (`WebGPUStagePool.h`).
- Mipmaps come from a single-pass compute downsampler (`SpdMipmapGenerator`) or from render passes.

**Shaders and sorting.**

- `matc` compiles materials offline into packages with one variant per backend, so materials have a single source.
- Commands are sorted by a 64-bit key: channel, pass, priority, a 10-bit depth bucket, then material, variant and instance ids. Blended commands sort by distance ([`RenderPass.h` L60–175](https://github.com/google/filament/blob/v1.78.0/filament/src/RenderPass.h#L60-L175)).
- Automatic instancing merges identical commands.
- Each backend caches its pipelines (`VulkanPipelineCache`, `WebGPUPipelineCache`).

**Loss.** A WebGPU device loss for any reason other than `Destroyed` fails a postcondition check, ending the process ([`WebGPUPlatform.cpp` L653–664](https://github.com/google/filament/blob/v1.78.0/filament/backend/src/webgpu/platform/WebGPUPlatform.cpp#L653-L664)).

### bgfx (d8d6acd)

- **API:** one C API over D3D11 and D3D12, Metal, Vulkan, GL/GLES/WebGL and WebGPU.
- **Frames and uploads:**
  - frames are double-buffered to a render thread;
  - each frame gets transient vertex and index buffers ([`bgfx.h` L3179](https://github.com/bkaradzic/bgfx/blob/d8d6acd94b64e01da3c4d1bc869df2dc2a8eb1ba/include/bgfx/bgfx.h#L3179));
  - data, including `updateTexture2D` data, arrives as `Memory` blocks, either copied or referenced with a release callback;
  - instancing reads per-instance data buffers ([`bgfx.h` L3221](https://github.com/bkaradzic/bgfx/blob/d8d6acd94b64e01da3c4d1bc869df2dc2a8eb1ba/include/bgfx/bgfx.h#L3221)).
- **Sorting:** a 64-bit `SortKey` (view, draw type, program, depth, blend) under a per-view mode: `Default`, `Sequential`, `DepthAscending` or `DepthDescending` ([`bgfx_p.h` L1498](https://github.com/bkaradzic/bgfx/blob/d8d6acd94b64e01da3c4d1bc869df2dc2a8eb1ba/src/bgfx_p.h#L1498)).
- **Shaders:** `shaderc` compiles a single `.sc` dialect offline for each backend.
- **Loss:**
  - device loss raises `Fatal::DeviceLost` ([`renderer_d3d11.cpp` L2402–2419](https://github.com/bkaradzic/bgfx/blob/d8d6acd94b64e01da3c4d1bc869df2dc2a8eb1ba/src/renderer_d3d11.cpp#L2402-L2419));
  - the application must shut down, re-initialize and recreate everything;
  - automatic restore was rejected as wasteful on memory-limited devices ([#442](https://github.com/bkaradzic/bgfx/issues/442)).

### Bevy v0.20.0 (wgpu)

**Backend choice.** The web backend is chosen at compile time ([`settings.rs` L70–84](https://github.com/bevyengine/bevy/blob/v0.20.0/crates/bevy_render/src/settings.rs#L70-L84)):

- the `webgl` feature selects the GL backend with WebGL2 limits;
- the `webgpu` feature selects browser WebGPU;
- there is no runtime fallback, so supporting both needs two builds.

**Batching.**

- Meshes are packed into shared slabs (`slab_allocator.rs`), so batches share their bindings.
- Opaque phases are binned (`BinnedRenderPhase`) and drawn with multi-draw-indirect when GPU preprocessing is available. On WebGL2 they fall back to CPU batching. Transparent phases are sorted ([`render_phase/mod.rs` L109, L1893](https://github.com/bevyengine/bevy/blob/v0.20.0/crates/bevy_render/src/render_phase/mod.rs#L109)).

**Pipelines.** Pipelines are specialized per variant and compiled asynchronously in tasks ([`pipeline_cache.rs` L219–247](https://github.com/bevyengine/bevy/blob/v0.20.0/crates/bevy_render/src/render_resource/pipeline_cache.rs#L219-L247)).

**Upload budget.** `RenderAssetBytesPerFrame` is a soft per-frame byte limit ([`render_asset.rs` L505–560](https://github.com/bevyengine/bevy/blob/v0.20.0/crates/bevy_render/src/render_asset.rs#L505-L560)):

- only whole assets are uploaded;
- uploading stops after the first asset that overflows the limit;
- images take part too, through `GpuImage::byte_len`.

**Loss.** `RenderErrorHandler` returns one of three policies: `Ignore`, `StopRendering` or `Recover(RenderCreation)`. The default quits the application, because ignoring repeated errors causes strobing ([`error_handler.rs` L20, L69](https://github.com/bevyengine/bevy/blob/v0.20.0/crates/bevy_render/src/error_handler.rs#L20)).

### Godot 4.7.2

**Renderers.**

- RenderingDevice serves Vulkan, D3D12 and Metal.
- The GLES3 "Compatibility" renderer is the only one available on the web (WebGL2).
- The shading language is compiled for each renderer.

**Uploads.**

- RenderingDevice uploads through a ring of staging blocks.
- When every block is still in flight, the ring grows to its configured maximum. After that it stalls for previous frames, or flushes and stalls for all of them ([`rendering_device.cpp` L907, L1004–1040](https://github.com/godotengine/godot/blob/4.7.2-stable/servers/rendering/rendering_device.cpp#L1004-L1040)).
- Textures upload in regions of `texture_upload_region_size_px` (L2298).

**Pipelines and sorting.**

- Pipelines are preloaded per surface. A miss compiles on the render thread ([#119678](https://github.com/godotengine/godot/issues/119678)).
- Forward+ sorts render elements by a 128-bit key (priority, shader, material, geometry, surface, depth layer) whose order was chosen to minimize rebinding ([`render_forward_clustered.h` L507–530](https://github.com/godotengine/godot/blob/4.7.2-stable/servers/rendering/renderer_rd/forward_clustered/render_forward_clustered.h#L507-L530)).

**Loss.**

- **Vulkan:** `VK_ERROR_DEVICE_LOST` leads to a fault report, then `CRASH_NOW_MSG` ([`rendering_device_driver_vulkan.cpp` L3266–3268](https://github.com/godotengine/godot/blob/4.7.2-stable/drivers/vulkan/rendering_device_driver_vulkan.cpp#L3266-L3268)).
- **Web:** `webglcontextlost` shows `alert('WebGL context lost, please reload the page')` ([`library_godot_display.js` L746–749](https://github.com/godotengine/godot/blob/4.7.2-stable/platform/web/js/libs/library_godot_display.js#L746-L749)).

### O3DE 2605.0 (Atom)

**Uploads.**

- The RHI (rendering hardware interface) supports DX12, Vulkan, Metal and a null backend.
- Buffers come from pools with a heap level (device or host) and a budget checked at allocation ([`BufferPoolDescriptor.h` L40](https://github.com/o3de/o3de/blob/2605.0/Gems/Atom/RHI/Code/Include/Atom/RHI.Reflect/BufferPoolDescriptor.h#L40)).
- `AsyncUploadQueue` uploads on a dedicated copy queue and thread, through a staging ring ([`AsyncUploadQueue.h` L23–25](https://github.com/o3de/o3de/blob/2605.0/Gems/Atom/RHI/DX12/Code/Source/RHI/AsyncUploadQueue.h#L23-L25)).
- `StreamingImagePool` expands and trims each image's mip chain under a memory budget, with a low-memory callback ([`DeviceStreamingImagePool.h` L86–125](https://github.com/o3de/o3de/blob/2605.0/Gems/Atom/RHI/Code/Include/Atom/RHI/DeviceStreamingImagePool.h#L86-L125)).

**Pipelines and sorting.**

- `PipelineStateCache` takes no lock on a hit and lets many threads compile misses without serializing ([`PipelineStateCache.h` L58–90](https://github.com/o3de/o3de/blob/2605.0/Gems/Atom/RHI/Code/Include/Atom/RHI/PipelineStateCache.h#L58-L90)).
- Draw items go into tagged lists, one per pass, and are sorted by key and depth when the lists are finalized ([`DrawListContext.h` L16–26](https://github.com/o3de/o3de/blob/2605.0/Gems/Atom/RHI/Code/Include/Atom/RHI/DrawListContext.h#L16-L26)).

**Loss.** `Device::SetDeviceRemoved` broadcasts `OnDeviceRemoved` ([`Device.cpp` L113–123](https://github.com/o3de/o3de/blob/2605.0/Gems/Atom/RHI/Code/Source/RHI/Device.cpp#L113-L123)). There is no recovery.

### CesiumJS 1.146

**Backend.**

- WebGL2 only.
- Thin wrappers (`Buffer`, `Texture`, `VertexArray`) sit over GL.
- `ShaderCache` ([L103](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Renderer/ShaderCache.js#L103)) and `RenderState.fromCache` remove duplicate programs and states.

**Upload pacing.**

- `QuadtreePrimitive` works through the tile load queue within a 5 ms slice per frame ([L90, L1331](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/QuadtreePrimitive.js#L1331)).
- glTF loaders use `JobScheduler` ([L50–100](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/JobScheduler.js#L50-L100)):
  - per-type budgets of 10 ms for textures, 10 ms for programs and 30 ms for buffers;
  - a type may borrow budget another type left unused;
  - every type gets at least one job per frame.

**Draws.**

- Each terrain tile is one draw that binds as many imagery textures as the texture units allow ([`GlobeSurfaceTileProvider.js` L2542, L3005](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/GlobeSurfaceTileProvider.js#L3005)).
- Geographic imagery is reprojected to Web Mercator in a framebuffer pass, then mipmapped ([`ImageryLayer.js` L1365](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/ImageryLayer.js#L1365)).
- `Primitive` combines geometry instances into shared buffers, in a worker or on the main thread ([`Primitive.js` L1345](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/Primitive.js#L1345)).
- Opaque commands draw front to back and translucent ones back to front ([`Scene.js` L2448–2491](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/Scene.js#L2448-L2491)).

**Loss.** There is no context-loss handling ([#5991](https://github.com/CesiumGS/cesium/issues/5991)).

## Measurements made for this survey

**Setup.**

- three.js 0.186.1, bundled with Vite 8.3.4.
- Headless Chromium 141.0.7390.37 on a 4-vCPU Xeon at 2.8 GHz, in a localhost secure context.
- Rendering on SwiftShader: through ANGLE for WebGL2 and through Dawn for WebGPU.

**Method.**

- Tiles are 33×33-vertex grids sharing one geometry, each with its own 256² RGBA mipmapped texture.
- Only CPU-side times are meaningful here; GPU times on a software rasterizer are not.
- Times are given as median / p95.

| Measurement                                                                                | WebGL2                | WebGPU                           |
| ------------------------------------------------------------------------------------------ | --------------------- | -------------------------------- |
| Minimal `WebGPURenderer` + TSL bundle (minified / gzip)                                    | 1,089 KB / 258 KB     | same bundle                      |
| `compileAsync`, 400 tiles, one `NodeMaterial` per tile                                     | 733–793 ms            | 565 ms                           |
| `compileAsync`, 400 tiles, one shared material with object-scope texture and matrix        | 56–68 ms              | 149 ms                           |
| `render()` CPU, 400 draws, one material per tile                                           | 3.7–4.1 / 6.6–11.9 ms | no data: device lost (see below) |
| `render()` CPU, 400 draws, shared material                                                 | 1.9–3.9 / 6.7–12.0 ms | 2.9 / 14.2 ms                    |
| The same 400 tiles as one instanced draw from a 2D array texture                           | 0.2 / 0.5–1.2 ms      | not measured                     |
| `initTexture`, 256² RGBA with mipmaps (JS side only)                                       | 0.1–0.2 ms median     | 0.3 ms median                    |
| First full upload of a 400-layer 256² array texture (100 MB from CPU)                      | 1.4–1.7 s             | not measured                     |
| `info.memory.textures` over 50 cycles of evicting the last-drawn tile and adding a new one | stable                | stable                           |

**Bundle-size comparison** (same build; two other engines' minimal entries):

- Babylon.js 9.31.0 with `WebGPUEngine`, `Engine`, `Scene`, `ShaderMaterial` and `RawTexture`: 240 KB gzip in the main chunk.
- PlayCanvas 2.23.3 with `Application` and both devices: 565 KB gzip.

**Correctness checks.**

- Object-scope textures (`texture(…).onObjectUpdate(…)`) sampled the correct texture per tile, confirmed by read-back.
- Importing `three/webgpu` and `three/tsl` under Node 22 works (SSR-safe), and neither bundle contains `eval` or `new Function`.

**WebGPU findings.**

- r186 always sets `swizzle: 'rgba'` on texture views ([`GPUTextureViewDescriptor.js` L84](https://github.com/mrdoob/three.js/blob/r186/src/renderers/webgpu/descriptors/GPUTextureViewDescriptor.js#L84)).
  - Chromium 141 rejects the type of that member, so every mipmapped texture threw on WebGPU until the test copy was patched.
  - three.js follows the latest WebGPU API, so older browsers can fail after initialization succeeds.
- Disposed or unreferenced renderers reported a device loss with reason `unknown`, carrying the message from [#33559](https://github.com/mrdoob/three.js/issues/33559); three.js filters only `destroyed`.
- One live renderer holding about 240 MB of textures also lost its device, cause not determined.

## Known failure modes from issue trackers

| Issue                                                                     | Kind                               | Symptom and root cause                                                                                                                                                                                                                                                            | Lesson                                                                        |
| ------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [three.js #30560](https://github.com/mrdoob/three.js/issues/30560)        | Performance, backend inconsistency | One UBO per object, bound and updated every draw. The WebGL2 path runs 80% more GL calls than `WebGLRenderer`; 20k meshes are up to 4× slower. Open.                                                                                                                              | Keep draws in the hundreds; benchmark WebGL2 separately.                      |
| [three.js #33821](https://github.com/mrdoob/three.js/issues/33821)        | Compile stall                      | Each unique node graph is rebuilt per material, and every render submits. 10k meshes take 1–2 s against 28–131 ms on `WebGLRenderer`. Open.                                                                                                                                       | Never one `NodeMaterial` per tile; one `render()` per frame.                  |
| [three.js #34597](https://github.com/mrdoob/three.js/issues/34597)        | Memory leak                        | The WebGL2 fallback never deletes programs, shaders or vertex array objects (VAOs) (0.185–0.186.1). VAOs are cached per attribute set ([`WebGLBackend.js` L932](https://github.com/mrdoob/three.js/blob/r186/src/renderers/webgl-fallback/WebGLBackend.js#L932)). Fixed for r187. | Per-tile geometry leaks on WebGL2 until r187; count GL objects in soak tests. |
| [three.js #32409](https://github.com/mrdoob/three.js/issues/32409)        | Memory leak                        | Internal render objects (shadow and override materials) kept disposed meshes alive. Fixed in May 2026.                                                                                                                                                                            | Lifecycle tests must check the heap, not only `info`.                         |
| [three.js #34999](https://github.com/mrdoob/three.js/issues/34999)        | Memory leak                        | New bind groups re-upload a disposed texture captured when the shader was built (r186). Fixed for r187.                                                                                                                                                                           | Keep an evict-and-add regression test; our pattern measured stable.           |
| [three.js #34682](https://github.com/mrdoob/three.js/issues/34682)        | Device loss                        | The WebGL backend never recovers after `webglcontextrestored`, and `dispose()` loses the context again. Fixed for r187.                                                                                                                                                           | Recover with a new renderer and a new canvas.                                 |
| [three.js #33559](https://github.com/mrdoob/three.js/issues/33559)        | Device loss, testing               | WebGPU on a software rasterizer in CI loses the device ("A valid external Instance reference no longer exists"). Skipped examples were counted as passes. Open.                                                                                                                   | A loss event fails the test.                                                  |
| [three.js #28101](https://github.com/mrdoob/three.js/issues/28101)        | Upload stall                       | Seven 16k textures froze the main thread for about 8 s. Maintainers left chunked uploads to the application.                                                                                                                                                                      | The engine owns budgets: small tiles, KTX2.                                   |
| [three.js #31143](https://github.com/mrdoob/three.js/issues/31143)        | Backend inconsistency              | WebGPU mipmaps were generated before the copy had been submitted, giving dark mips.                                                                                                                                                                                               | Visual tests at minified scales on both backends.                             |
| [three.js #31132](https://github.com/mrdoob/three.js/issues/31132)        | Backend inconsistency              | Chrome applies PNG gAMA and cHRM metadata differently on WebGL and WebGPU.                                                                                                                                                                                                        | Decode with `colorSpaceConversion: 'none'`.                                   |
| [three.js #33166](https://github.com/mrdoob/three.js/issues/33166)        | Backend inconsistency              | Reversed-Z failed in Firefox, which has no `EXT_clip_control`.                                                                                                                                                                                                                    | Depth needs a per-path fallback ([ADR 0005](../adr/0005-depth-strategy.md)).  |
| [CesiumJS #5991](https://github.com/CesiumGS/cesium/issues/5991)          | Device loss                        | Unhandled since 2017: an unrelated "width must be > 0" error, then rendering stops.                                                                                                                                                                                               | Treat loss as a first-class state.                                            |
| [CesiumJS #11533](https://github.com/CesiumGS/cesium/issues/11533)        | Leak, lifecycle                    | Destroying a viewer keeps its context; the 16th viewer fails at Chrome's context cap.                                                                                                                                                                                             | `destroy()` must release the context.                                         |
| [CesiumJS #12231](https://github.com/CesiumGS/cesium/issues/12231)        | Glitch                             | Resizing the atlas rebound framebuffers and made the whole map flicker (1.122 regression).                                                                                                                                                                                        | Resource updates must not disturb frame state.                                |
| [Babylon.js #18927](https://github.com/BabylonJS/Babylon.js/issues/18927) | Memory leak                        | `dispose()` flushed the deferred-destruction queues and destroyed the device before tearing down scenes.                                                                                                                                                                          | Destroy scene resources, then queues, then the device; test 100 cycles.       |
| [PlayCanvas #9675](https://github.com/playcanvas/engine/issues/9675)      | Device loss                        | After a second GPU-process crash, Chrome refused the adapter; the rejection went unhandled and the app got no signal.                                                                                                                                                             | Recovery can fail: emit a terminal event.                                     |
| [PlayCanvas #6677](https://github.com/playcanvas/engine/issues/6677)      | Device loss                        | `mapAsync` after loss threw `AbortError` for about 2% of users.                                                                                                                                                                                                                   | Gate every asynchronous GPU call on liveness.                                 |
| [Bevy #23183](https://github.com/bevyengine/bevy/issues/23183)            | Device loss, OOM                   | The recover policy retried an out-of-memory condition every frame, which strobed.                                                                                                                                                                                                 | Cap recovery attempts; never flash.                                           |
| [Bevy #10456](https://github.com/bevyengine/bevy/issues/10456)            | Device loss                        | WebGL2 loss crashes the app; WebGPU loss leaves a black canvas. Open.                                                                                                                                                                                                             | Both paths need recovery tests.                                               |
| [Godot #119678](https://github.com/godotengine/godot/issues/119678)       | Pipeline stall                     | Missing permutations are compiled on first visibility, about 0.5 s each, up to 2 s per stall.                                                                                                                                                                                     | Compile every variant before the first frame.                                 |
| [bgfx #3855](https://github.com/bkaradzic/bgfx/issues/3855)               | Device loss                        | An out-of-bounds shader access caused `VK_ERROR_DEVICE_LOST`, reported at an unrelated sync point.                                                                                                                                                                                | Loss diagnosis needs labels and the last operation.                           |
| [O3DE #19473](https://github.com/o3de/o3de/issues/19473)                  | Device loss                        | The editor crashes inside device-removed handling when the window moves to another monitor. Open.                                                                                                                                                                                 | Test the loss path itself (monitor change, sleep).                            |
| [O3DE #18835](https://github.com/o3de/o3de/issues/18835)                  | Memory leak                        | Every view switch creates another shadow atlas of hundreds of MB. Open.                                                                                                                                                                                                           | Budget accounting must catch duplicates.                                      |

## How they test and benchmark it

- **three.js:**
  - Puppeteer screenshots almost every example, with a pixel threshold of 0.1 and at most 0.1% differing pixels ([`puppeteer.js` L87–88](https://github.com/mrdoob/three.js/blob/r186/test/e2e/puppeteer.js#L87-L88)).
  - CI runs Ubuntu with xvfb and Mesa lavapipe, using `--enable-unsafe-webgpu --enable-features=Vulkan --disable-vulkan-surface` and `VK_DRIVER_FILES` set to lavapipe ([L209–223](https://github.com/mrdoob/three.js/blob/r186/test/e2e/puppeteer.js#L209-L223), [`ci.yml` L42–73](https://github.com/mrdoob/three.js/blob/r186/.github/workflows/ci.yml#L42-L73)).
  - Pages get deterministic `requestAnimationFrame` and clocks.
  - WebGPU examples run only on WebGPU. TSL unit tests run every expression on both backends through `forceWebGL` ([`gpu-test-utils.js` L228–236](https://github.com/mrdoob/three.js/blob/r186/test/unit/addons/tsl/gpu-test-utils.js#L228-L236)).
- **Babylon.js:**
  - Playwright renders about 900 playground scenes in each engine project (`webgl2`, and `webgpu` in branded Chrome).
  - Both backends share one set of reference images, with only 39 WebGPU-specific overrides. Tolerance is 3.5% per channel and 1.1% of pixels ([`visualizationPlaywright.utils.ts` L307–309](https://github.com/BabylonJS/Babylon.js/blob/9.30.0/packages/tools/tests/test/playwright/visualizationPlaywright.utils.ts#L307-L309)).
  - Each test can list `excludedEngines`, and GL errors are checked after rendering.
- **PlayCanvas:** unit tests run on a null device and, in CI, again on Dawn's `null` backend through the `webgpu` npm package. That backend does full validation and WGSL compilation without a GPU ([`test/webgpu-device.mjs`](https://github.com/playcanvas/engine/blob/v2.23.3/test/webgpu-device.mjs)).
- **Filament:**
  - `renderdiff` compares golden images, with separate goldens per platform ([README](https://github.com/google/filament/blob/v1.78.0/test/renderdiff/README.md)).
  - Desktop backends render on Mesa's software rasterizers.
  - WebGL and WebGPU render in headless Chromium on SwiftShader, with the browser build, rasterizer and size pinned.
- **Bevy:**
  - Example screenshots are taken on macOS, Linux (Mesa Vulkan) and Windows and compared per platform.
  - WebGL2 WASM examples run in Playwright Chromium and Firefox under xvfb ([`validation-jobs.yml` L103–153](https://github.com/bevyengine/bevy/blob/v0.20.0/.github/workflows/validation-jobs.yml#L103-L153)).
- **Godot:** headless doctest unit tests and a test project running on Mesa Vulkan. There is no image comparison.
- **O3DE:** Python suites, some on the null renderer and some on GPUs. The GPU suites compare against golden images under both `-rhi=dx12` and `-rhi=vulkan`, with shared goldens ([`TestSuite_Main_GPU.py` L35–50](https://github.com/o3de/o3de/blob/2605.0/AutomatedTesting/Gem/PythonTests/Atom/TestSuite_Main_GPU.py#L35-L50)).
- **CesiumJS:** Jasmine specs assert pixel colors (`toRender`) on real WebGL. CI runs headless Firefox with `--webgl-stub`, which skips rendering.
- **bgfx:** CI only builds; the examples are tested by hand.

Patterns:

- one set of references for every backend (Babylon.js, O3DE), against goldens per platform (Filament);
- software rasterizers in CI (three.js, Filament, Bevy, Godot);
- backends that only validate (PlayCanvas, O3DE, CesiumJS).

## Literature

- **Cozzi and Ring (2011):**
  - Chapter 3, "Renderer Design", wraps the graphics API behind an engine-owned renderer interface, with cached render state and sorting by state.
  - Chapter 10, "Exploiting Parallelism in Resource Preparation", decodes in worker threads and keeps GPU submission on the rendering thread. This is the split ADR 0011 adopts.
- **Ulrich (2002):** chunked level of detail streams chunks that are ready for the GPU, so the upload granularity equals the tile.
- **Specifications:** the [WebGPU](https://www.w3.org/TR/webgpu/) and [WebGL](https://registry.khronos.org/webgl/specs/latest/1.0/) specifications define how losses are reported:
  - a device's `lost` promise reports a reason;
  - a context fires `webglcontextlost` and `webglcontextrestored`, and the page must call `preventDefault()` to allow a restore.

## Comparison of approaches

### Renderer base

The minified sizes below are measured gzip sizes.

**1. three.js r186 `WebGPURenderer`**

- **Fallback and shaders:** automatic fallback at `init()`; one shader source, TSL compiled to WGSL and GLSL.
- **Loss and uploads:** no built-in restore; the application recreates the renderer. `initTexture` and `compileAsync` exist, but there is no staging and no budget.
- **License and size:** MIT, 258 KB.
- **Fit:** TypeScript with ESM, no WASM, CSP-clean, SSR-safe import. Releases often; known WebGL2-path overheads.

**2. Babylon.js `WebGPUEngine` + `Engine`**

- **Fallback and shaders:** automatic fallback through `EngineFactory`. Shaders are WGSL and GLSL ports, or GLSL converted at runtime through glslang and Tint WASM.
- **Loss and uploads:** full restore, at the cost of CPU copies of every resource. Uploads go through engine helpers.
- **License and size:** Apache-2.0, 240 KB.
- **Fit:** the WASM converters load from Babylon's CDN unless self-hosted; dual shader authoring; the engine's scene model sits above ours.

**3. PlayCanvas**

- **Fallback and shaders:** automatic fallback through the `deviceTypes` list; shaders authored twice, once in GLSL and once in WGSL.
- **Loss and uploads:** full restore on both backends. `UploadStream` uses PBOs and staging buffers.
- **License and size:** MIT, 565 KB.
- **Fit:** strong internals, but dual shader authoring and an application framework included.

**4. Custom backend**

- **Fallback and shaders:** we write the fallback ourselves, with two shader languages or a translator.
- **Loss and uploads:** whatever we design; uploads under full control.
- **License and size:** our own code, the smallest.
- **Fit:** months of work on two backends; this is the escape hatch for proven hot paths.

**5. Bevy / wgpu, Filament, bgfx (WASM)**

- **Fallback and shaders:** Bevy fixes the backend at compile time. Shaders are WGSL translated by naga, or compiled offline.
- **Loss and uploads:** loss leads to quitting or a fatal error. Uploads are native.
- **License and size:** permissive, but each is a large WASM module.
- **Fit:** a C++ or Rust toolchain, CSP `wasm-unsafe-eval`, offline shader compilers.

**6. CesiumJS renderer**

- **Fallback and shaders:** WebGL2 only.
- **Loss and uploads:** no loss handling; time-sliced uploads.
- **License and size:** Apache-2.0, not measured.
- **Fit:** no WebGPU.

### Resource strategies, and how they fail

- **Uploads:**
  - **Lazy upload on first draw** (the three.js default) puts the cost into the frame that first shows the tile ([#28101](https://github.com/mrdoob/three.js/issues/28101)).
  - **Time-sliced or byte-capped queues** (CesiumJS, Bevy) bound that cost. The cap must count bytes as well as time, because WebGPU work is queued and invisible to JS timing.
  - **Staging rings** (PlayCanvas, Godot, O3DE, Filament) avoid driver stalls but stall themselves when full (Godot). three.js r186 does not expose staging.
- **Pipelines:**
  - Every engine caches them by hash.
  - A miss mid-frame costs 0.5 s on native drivers ([Godot #119678](https://github.com/godotengine/godot/issues/119678)) and 1–2 ms per material in TSL node building (measured).
  - The fix is a closed, warmed set of pipeline variants.
- **Batching:**
  - **Per-object draws with per-object UBOs** are the three.js default; they cost about 5–10 µs of CPU per draw here and more on WebGL2 ([#30560](https://github.com/mrdoob/three.js/issues/30560)).
  - **Dynamic offsets** (PlayCanvas) and **multi-draw-indirect** (Bevy) cut that cost, but neither is reachable through three.js r186.
  - **Instancing from a texture array** costs 0.2 ms for 400 tiles on both backends. It needs fixed-size layers, and per-layer mip uploads work only for compressed arrays or GPU copies.
- **State sorting:** sort keys (Filament, bgfx, O3DE) are cheap and deterministic. In three.js, `renderOrder` carries an engine key.
- **Device loss** is handled in four ways:
  - **Crash or quit** (Godot, Filament, Bevy by default): unacceptable here.
  - **Application rebuild** (bgfx, three.js r186).
  - **Engine restore from CPU copies** (Babylon.js, PlayCanvas): convenient but doubles memory.
  - **Re-decode from the RAM tier** (ADR 0007): no duplicated decoded memory. This is our case, because tiles are always re-fetchable.

## Chosen approach for VibeGlobe

Adopt **three.js `WebGPURenderer` pinned to exactly `0.186.1`** (MIT, tag r186), behind the engine's `RendererBackend`, as [ADR 0010](../adr/0010-renderer-base.md) details.

**Why three.js.**

- It is the only candidate with automatic WebGPU-to-WebGL2 fallback, one shader source and no WASM.
- Its measured costs fit the budgets once the engine follows a few rules:
  - shared materials with object-scope bindings;
  - explicit uploads under the ADR 0007 budget;
  - engine-owned matrices, projection and sort keys;
  - recovery by recreating the renderer.
- Babylon.js and PlayCanvas recover from loss better, but both mean authoring every shader twice, or shipping a WASM shader translator that must be self-hosted.

**Upgrades.** Every three.js release is evaluated with the full visual, scenario, leak and performance suites. The first upgrade, r187, is required before M4: its fixes for #34597, #34682 and #34999 matter for per-tile terrain meshes on WebGL2.

### What must still be measured

| Milestone | Measurement                                                                                                                                          | Pass condition, or what it decides                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| M2        | On the reference devices and both backends: `render()` CPU and GPU time (timestamp queries) for 200, 400 and 800 tile draws with the shared material | Renderer CPU p95 above 3 ms at the reference tile count on WebGL2 switches imagery to the instanced texture-array path |
| M2        | Pipeline compiles after warm-up, counted in the debug overlay over the scenario suite                                                                | Must stay 0                                                                                                            |
| M2        | Startup self-test on the pinned CI Chromium 156, Chromium 141 (the container's browser), Safari and Firefox                                          | Proves the WebGPU path, or the automatic WebGL2 fallback                                                               |
| M2        | Loss recovery: `GPUDevice.destroy()` from a test hook and `WEBGL_lose_context`, 20 cycles each                                                       | Time until the pinned base is back; no growth in heap, `info.memory` or wrapped-context GL object counts               |
| M2        | 100 mount/unmount cycles on both backends, with several instances on one page (Chrome's 16-context cap on WebGL2)                                    | No growth in heap, `info.memory` or wrapped-context GL object counts                                                   |
| M2        | Bundle size of `@vibeglobe/renderer` with three.js                                                                                                   | Sets the renderer budget                                                                                               |
| M3        | Upload cost model: bytes per millisecond for 256² and 512² `ImageBitmap` uploads with mips, on each backend, with GPU timestamps                     | Calibrates the 2 ms / 8 MB budget of ADR 0007                                                                          |
| M3        | Instanced texture-array path: GPU copies into layers (`copyTextureToTexture` per mip level)                                                          | Run only if the M2 switch triggers                                                                                     |

## Open questions

Update 2026-10-20: the owner settled the bundle budget: no separate lightweight first-frame path; the byte budget is set from the M2 measurement with a blocking CI size check, time to first frame is binding, and the engine can be loaded through a dynamic import ([ADR 0015](../adr/0015-owner-decisions-2026-10-20.md)).

- **Bundle budget:** three.js alone is about 258 KB gzip. That leaves about 40 KB of the proposed 300 KB initial-JavaScript budget (`docs/plan/quality.md`). The budget needs owner review in M2.
- **Shared `GPUDevice`:** should several engine instances share one device? r186 accepts a `device` parameter. Sharing saves memory but couples one instance's loss to all of them.
- **Context cap:** how does the engine behave when several instances on the WebGL2 path approach the browser's context limit?
- **WebGPU compatibility adapters:** r186 requests `featureLevel: 'compatibility'`. Texture-array views and the limits on such adapters (older Android, D3D11) must be verified on hardware.
