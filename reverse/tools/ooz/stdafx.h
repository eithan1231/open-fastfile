// Stands in for ooz's MSVC stdafx.h so its sources build with g++ on Linux.
// build.sh copies the ooz sources next to this file, so theirs is never seen.
// Only the decoder is used: the oo2core DLL path (LoadLib) compiles to a stub
// that fails, and nothing here loads a Windows binary.
#pragma once

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

#include <immintrin.h>

#include <algorithm>

typedef unsigned char byte;
typedef unsigned char uint8;
typedef unsigned int uint32;
typedef uint64_t uint64;
typedef int64_t int64;
typedef signed int int32;
typedef unsigned short uint16;
typedef signed short int16;
typedef unsigned int uint;

#define __int64 long long
#define __forceinline inline __attribute__((always_inline))

// MSVC intrinsics. _BitScan* take an unsigned long* in MSVC; ooz passes both
// uint32* and unsigned long*, so these are templates over the out-pointer.
template <typename T>
static inline unsigned char _BitScanReverse(T *index, uint32_t mask) {
  if (!mask) return 0;
  *index = (T)(31 - __builtin_clz(mask));
  return 1;
}
template <typename T>
static inline unsigned char _BitScanForward(T *index, uint32_t mask) {
  if (!mask) return 0;
  *index = (T)__builtin_ctz(mask);
  return 1;
}
// _rotl comes from GCC's <immintrin.h> (ia32intrin.h).
#define _byteswap_ushort __builtin_bswap16
#define _byteswap_ulong __builtin_bswap32
#define _byteswap_uint64 __builtin_bswap64

// Timing and DLL loading, used only by the command-line main().
typedef long long LARGE_INTEGER;
static inline int QueryPerformanceCounter(LARGE_INTEGER *t) {
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  *t = (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
  return 1;
}
static inline int QueryPerformanceFrequency(LARGE_INTEGER *f) {
  *f = 1000000000LL;
  return 1;
}
typedef void *HINSTANCE;
static inline HINSTANCE LoadLibraryA(const char *) { return nullptr; }
static inline void *GetProcAddress(HINSTANCE, const char *) { return nullptr; }
#define WINAPI
