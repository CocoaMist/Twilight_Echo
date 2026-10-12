#include "am_fft.h"

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
struct ta_am_fft {
  size_t n;
  size_t *reverse;
  float *wr, *wi, *inverse_wi;
  const ta_am_kernels *kernels;
};
ta_am_fft *ta_am_fft_create(size_t n, const ta_am_kernels *kernels) {
  if (!kernels || n < 2 || n > (1u << 20) || (n & (n - 1))) return NULL;
  ta_am_fft *f = calloc(1, sizeof(*f));
  if (!f) return NULL;
  f->n = n;
  f->kernels = kernels;
  f->reverse = malloc(n * sizeof(size_t));
  f->wr = malloc(n * sizeof(float));
  f->wi = malloc(n * sizeof(float));
  f->inverse_wi = malloc(n * sizeof(float));
  if (!f->reverse || !f->wr || !f->wi || !f->inverse_wi) {
    ta_am_fft_free(f);
    return NULL;
  }
  unsigned bits = 0;
  for (size_t j = n; j > 1; j >>= 1) bits++;
  for (size_t i = 0; i < n; i++) {
    size_t x = i, r = 0;
    for (unsigned b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    f->reverse[i] = r;
  }
  for (size_t len = 2; len <= n; len <<= 1) {
    size_t half = len / 2;
    for (size_t k = 0; k < half; k++) {
      double p = 6.2831853071795864769 * (double)k / (double)len;
      size_t index = half - 1 + k;
      f->wr[index] = (float)cos(p);
      f->wi[index] = (float)-sin(p);
      f->inverse_wi[index] = -f->wi[index];
    }
  }
  return f;
}
void ta_am_fft_free(ta_am_fft *f) {
  if (f) {
    free(f->reverse);
    free(f->wr);
    free(f->wi);
    free(f->inverse_wi);
    free(f);
  }
}
int ta_am_fft_transform(ta_am_fft *f, float *r, float *q, int inverse) {
  if (!f || !r || !q || r == q) return -1;
  for (size_t i = 0; i < f->n; i++) {
    if (!isfinite(r[i]) || !isfinite(q[i])) return -1;
    size_t j = f->reverse[i];
    if (j > i) {
      float t = r[i];
      r[i] = r[j];
      r[j] = t;
      t = q[i];
      q[i] = q[j];
      q[j] = t;
    }
  }
  for (size_t len = 2; len <= f->n; len <<= 1) {
    size_t half = len / 2;
    for (size_t s = 0; s < f->n; s += len)
      f->kernels->butterfly(r + s, q + s, r + s + half, q + s + half, f->wr + half - 1,
                            (inverse ? f->inverse_wi : f->wi) + half - 1, half);
  }
  if (inverse) {
    float scale = 1.0f / (float)f->n;
    f->kernels->affine(r, r, scale, 0, f->n);
    f->kernels->affine(q, q, scale, 0, f->n);
  }
  return 0;
}
