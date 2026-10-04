// Force-included ahead of kraken.cpp: declaring the decoder extern "C" first
// gives its definition C linkage, so ctypes finds it by its plain name.
#pragma once
#include <stddef.h>
extern "C" int Kraken_Decompress(const unsigned char *src, size_t src_len, unsigned char *dst, size_t dst_len);
