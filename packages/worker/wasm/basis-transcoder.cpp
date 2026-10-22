// The plain C interface of VibeGlobe's Basis Universal transcoder build (ADR 0020 rule 4): no Emscripten, no
// JavaScript glue and no imports beyond memory growth, so a worker instantiates it under
// `script-src 'self' 'wasm-unsafe-eval'`. The caller allocates the input and output in the module's memory, opens
// the KTX2 file once, transcodes each level into its buffer and closes it. Every function reports failure with 0.
#include "basisu_transcoder.h"

#include <new>
#include <stdint.h>
#include <stdlib.h>

using basist::ktx2_transcoder;
using basist::transcoder_texture_format;

namespace {

// The engine's targets, numbered as in core's `ktx2-targets.ts`.
bool format_of(uint32_t target, transcoder_texture_format &out) {
  switch (target) {
  case 0: out = transcoder_texture_format::cTFRGBA32; return true;
  case 1: out = transcoder_texture_format::cTFBC1_RGB; return true;
  case 2: out = transcoder_texture_format::cTFBC7_RGBA; return true;
  case 3: out = transcoder_texture_format::cTFETC1_RGB; return true;
  case 4: out = transcoder_texture_format::cTFETC2_RGBA; return true;
  case 5: out = transcoder_texture_format::cTFASTC_4x4_RGBA; return true;
  default: return false;
  }
}

bool initialized = false;

} // namespace

extern "C" {

__attribute__((export_name("vg_alloc"))) void *vg_alloc(uint32_t bytes) { return malloc(bytes); }

__attribute__((export_name("vg_free"))) void vg_free(void *pointer) { free(pointer); }

/** Opens a KTX2 file held at `data` (kept alive by the caller until `vg_close`); 0 when it is not a valid one. */
__attribute__((export_name("vg_open"))) ktx2_transcoder *vg_open(const uint8_t *data, uint32_t bytes) {
  if (!initialized) {
    basist::basisu_transcoder_init();
    initialized = true;
  }
  ktx2_transcoder *transcoder = new (std::nothrow) ktx2_transcoder();
  if (!transcoder) return nullptr;
  if (!transcoder->init(data, bytes) || !transcoder->is_ldr() || !transcoder->start_transcoding()) {
    delete transcoder;
    return nullptr;
  }
  return transcoder;
}

/** 1 for ETC1S, 2 for UASTC LDR 4x4, 0 for anything else. */
__attribute__((export_name("vg_kind"))) uint32_t vg_kind(const ktx2_transcoder *transcoder) {
  return transcoder->is_etc1s() ? 1 : transcoder->is_uastc() ? 2 : 0;
}

__attribute__((export_name("vg_has_alpha"))) uint32_t vg_has_alpha(const ktx2_transcoder *transcoder) {
  return transcoder->get_has_alpha() ? 1 : 0;
}

/**
 * Transcodes level `level` of the first layer and face to `target` into `out`, which holds `capacity` blocks (or
 * pixels for RGBA32). Returns 1 on success.
 */
__attribute__((export_name("vg_transcode"))) uint32_t vg_transcode(ktx2_transcoder *transcoder, uint32_t level,
                                                                   uint32_t target, void *out, uint32_t capacity) {
  transcoder_texture_format format;
  if (!format_of(target, format) || level >= transcoder->get_levels()) return 0;
  return transcoder->transcode_image_level(level, 0, 0, out, capacity, format) ? 1 : 0;
}

__attribute__((export_name("vg_close"))) void vg_close(ktx2_transcoder *transcoder) { delete transcoder; }
}
