#!/usr/bin/env bash
# Builds packages/worker/wasm/vibeglobe-basis.wasm (ADR 0020 rule 4): the upstream Basis Universal transcoder with
# a plain C interface (packages/worker/wasm/basis-transcoder.cpp), compiled by a pinned wasi-sdk into a module with
# no JavaScript glue. Only ETC1S, UASTC LDR 4x4, Zstandard and the engine's targets are compiled in.
#
#   scripts/wasm-basis.sh [work directory]
#
# The work directory (default: a temporary one) receives the toolchain and the sources; the build is reproducible:
# the same pins give the same bytes, which the nightly run compares with the committed file.
set -euo pipefail

BASIS_REPOSITORY=https://github.com/BinomialLLC/basis_universal.git
BASIS_COMMIT=323239a6a5ffa57d6570cfc403be99156e33a8b0 # tag v1_60
WASI_SDK_URL=https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-x86_64-linux.tar.gz
WASI_SDK_SHA256=52640dde13599bf127a95499e61d6d640256119456d1af8897ab6725bcf3d89c

root=$(cd "$(dirname "$0")/.." && pwd)
work=${1:-$(mktemp -d)}
mkdir -p "$work"
cd "$work"

if [ ! -x wasi-sdk/bin/clang++ ]; then
  curl -sSLo wasi-sdk.tar.gz "$WASI_SDK_URL"
  echo "$WASI_SDK_SHA256  wasi-sdk.tar.gz" | sha256sum -c -
  mkdir -p wasi-sdk
  tar xzf wasi-sdk.tar.gz -C wasi-sdk --strip-components 1
fi
if [ ! -d basis_universal ]; then
  git init -q basis_universal
  git -C basis_universal fetch -q --depth 1 "$BASIS_REPOSITORY" "$BASIS_COMMIT"
  git -C basis_universal checkout -q FETCH_HEAD
fi

flags=(
  --target=wasm32-wasip1 -Os -flto -fno-exceptions -fno-rtti -DNDEBUG
  -fvisibility=hidden -msimd128 -mbulk-memory -mnontrapping-fptoint -msign-ext
  -DBASISD_SUPPORT_KTX2=1 -DBASISD_SUPPORT_KTX2_ZSTD=1 -DBASISD_SUPPORT_UASTC=1
  -DBASISD_SUPPORT_DXT1=1 -DBASISD_SUPPORT_BC7_MODE5=1 -DBASISD_SUPPORT_ETC2_EAC_A8=1 -DBASISD_SUPPORT_ASTC=1
  -DBASISD_SUPPORT_DXT5A=0 -DBASISD_SUPPORT_PVRTC1=0 -DBASISD_SUPPORT_PVRTC2=0 -DBASISD_SUPPORT_ATC=0
  -DBASISD_SUPPORT_FXT1=0 -DBASISD_SUPPORT_ETC2_EAC_RG11=0 -DBASISD_SUPPORT_UASTC_HDR=0 -DBASISD_SUPPORT_ASTC_HIGHER_OPAQUE_QUALITY=0
  -I basis_universal/transcoder -I basis_universal/zstd
)
wasi-sdk/bin/clang "${flags[@]}" -x c -c basis_universal/zstd/zstddeclib.c -o zstd.o
wasi-sdk/bin/clang++ "${flags[@]}" -std=c++17 -c basis_universal/transcoder/basisu_transcoder.cpp -o transcoder.o
wasi-sdk/bin/clang++ "${flags[@]}" -std=c++17 -c "$root/packages/worker/wasm/basis-transcoder.cpp" -o wrapper.o
wasi-sdk/bin/clang++ "${flags[@]}" -mexec-model=reactor -Wl,--strip-all -Wl,--gc-sections -o vibeglobe-basis.wasm wrapper.o transcoder.o zstd.o
cp vibeglobe-basis.wasm "$root/packages/worker/wasm/vibeglobe-basis.wasm"
sha256sum "$root/packages/worker/wasm/vibeglobe-basis.wasm"
