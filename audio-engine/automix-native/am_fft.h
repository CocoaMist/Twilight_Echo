#ifndef TWILIGHT_AM_FFT_H
#define TWILIGHT_AM_FFT_H
#include "am_kernels.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct ta_am_fft ta_am_fft;
ta_am_fft *ta_am_fft_create(size_t size, const ta_am_kernels *kernels);
void ta_am_fft_free(ta_am_fft *fft);
/* In-place, non-overlapping finite real/imag arrays of the configured size.
 * One context per worker; no allocations during transform. */
int ta_am_fft_transform(ta_am_fft *fft, float *real, float *imag, int inverse);
#ifdef __cplusplus
}
#endif
#endif
