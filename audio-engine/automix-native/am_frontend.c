#include "am_frontend.h"

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "am_fft.h"
struct ta_am_frontend {
  ta_am_model_kind kind;
  size_t n, window, hop, bands, bins;
  float *weights, *hann, *r, *q, *magnitude;
  ta_am_fft *fft;
  const ta_am_kernels *k;
};
static double slaney(double hz) {
  return hz < 1000 ? hz / (200.0 / 3) : 15 + log(hz / 1000) / (log(6.4) / 27);
}
static double inverse_slaney(double m) {
  return m < 15 ? m * (200.0 / 3) : 1000 * exp((m - 15) * (log(6.4) / 27));
}
static double htk(double hz) { return 1127 * log(1 + hz / 700); }
ta_am_frontend *ta_am_frontend_create(ta_am_model_kind kind,
                                      const ta_am_kernels *k) {
  if (!k || (kind != TA_AM_BEAT_THIS && kind != TA_AM_YAMNET))
    return NULL;
  ta_am_frontend *f = calloc(1, sizeof(*f));
  if (!f)
    return NULL;
  f->kind = kind;
  f->k = k;
  f->n = kind == TA_AM_BEAT_THIS ? 1024 : 512;
  f->window = kind == TA_AM_BEAT_THIS ? 1024 : 400;
  f->hop = kind == TA_AM_BEAT_THIS ? 441 : 160;
  f->bands = kind == TA_AM_BEAT_THIS ? 128 : 64;
  f->bins = f->n / 2 + 1;
  f->weights = calloc(f->bands * f->bins, 4);
  f->hann = malloc(f->window * 4);
  f->r = calloc(f->n, 4);
  f->q = calloc(f->n, 4);
  f->magnitude = malloc(f->bins * 4);
  f->fft = ta_am_fft_create(f->n, k);
  if (!f->weights || !f->hann || !f->r || !f->q || !f->magnitude || !f->fft) {
    ta_am_frontend_free(f);
    return NULL;
  }
  for (size_t i = 0; i < f->window; i++)
    f->hann[i] =
        kind == TA_AM_YAMNET
            ? 0.5f * (1 - cosf(6.2831853071795864769f * (float)i /
                               (float)f->window))
            : (float)(0.5 - 0.5 * cos(6.2831853071795864769 * i / f->window));
  double lo = kind == TA_AM_BEAT_THIS ? slaney(30) : htk(125),
         hi = kind == TA_AM_BEAT_THIS ? slaney(11000) : htk(7500),
         rate = kind == TA_AM_BEAT_THIS ? 22050 : 16000;
  for (size_t b = 0; b < f->bands; b++) {
    double edges[3];
    for (size_t j = 0; j < 3; j++) {
      double m = lo + (hi - lo) * (b + j) / (f->bands + 1);
      edges[j] = kind == TA_AM_BEAT_THIS ? inverse_slaney(m) : m;
    }
    for (size_t i = 0; i < f->bins; i++) {
      double freq = rate * i / f->n;
      if (kind == TA_AM_YAMNET) {
        if (!i)
          continue;
        float lower = 1127.0f * logf(1 + 125.0f / 700),
              upper = 1127.0f * logf(1 + 7500.0f / 700);
        float step = (upper - lower) / (float)(f->bands + 1);
        float left = lower + step * (float)b,
              center = lower + step * (float)(b + 1),
              right = lower + step * (float)(b + 2);
        float mf = 1127.0f * logf(1 + (float)freq / 700);
        f->weights[b * f->bins + i] =
            fmaxf(0, fminf((mf - left) / (center - left),
                           (right - mf) / (right - center)));
        continue;
      }
      double weight = fmin((freq - edges[0]) / (edges[1] - edges[0]),
                           (edges[2] - freq) / (edges[2] - edges[1]));
      f->weights[b * f->bins + i] = (float)fmax(0, weight);
    }
  }
  return f;
}
void ta_am_frontend_free(ta_am_frontend *f) {
  if (f) {
    free(f->weights);
    free(f->hann);
    free(f->r);
    free(f->q);
    free(f->magnitude);
    ta_am_fft_free(f->fft);
    free(f);
  }
}
static size_t reflected(int64_t i, size_t count) {
  if (count < 2)
    return 0;
  int64_t period = (int64_t)(2 * (count - 1));
  i %= period;
  if (i < 0)
    i += period;
  return (size_t)(i < (int64_t)count ? i : period - i);
}
int ta_am_frontend_process(ta_am_frontend *f, const float *x, size_t samples,
                           size_t offset, size_t frames, float *mel) {
  if (!f || (!x && samples) || !mel || samples > INT32_MAX ||
      offset > INT32_MAX || frames > 100000)
    return -1;
  for (size_t i = 0; i < samples; i++)
    if (!isfinite(x[i]))
      return -1;
  for (size_t frame = 0; frame < frames; frame++) {
    memset(f->r, 0, f->n * 4);
    memset(f->q, 0, f->n * 4);
    int64_t start = (int64_t)offset + (int64_t)(frame * f->hop) -
                    (f->kind == TA_AM_BEAT_THIS ? (int64_t)f->n / 2 : 0);
    for (size_t i = 0; i < f->window; i++) {
      int64_t pos = start + (int64_t)i;
      float sample = 0;
      if (samples) {
        if (f->kind == TA_AM_BEAT_THIS)
          sample = x[reflected(pos, samples)];
        else if (pos >= 0 && (uint64_t)pos < samples)
          sample = x[pos];
      }
      f->r[i] = sample;
    }
    f->k->binary(f->r, f->r, f->hann, f->window, 1);
    if (ta_am_fft_transform(f->fft, f->r, f->q, 0))
      return -1;
    f->k->binary(f->magnitude, f->r, f->r, f->bins, 1);
    f->k->binary(f->q, f->q, f->q, f->bins, 1);
    f->k->binary(f->magnitude, f->magnitude, f->q, f->bins, 0);
    f->k->unary(f->magnitude, f->magnitude, f->bins, 5);
    if (f->kind == TA_AM_BEAT_THIS)
      f->k->affine(f->magnitude, f->magnitude, 1.0f / 32, 0, f->bins);
    for (size_t b = 0; b < f->bands; b++) {
      float energy = f->k->dot(f->magnitude, f->weights + b * f->bins, f->bins);
      float value =
          f->kind == TA_AM_BEAT_THIS ? 1000 * energy : energy + 0.001f;
      f->k->unary(mel + frame * f->bands + b, &value, 1,
                  f->kind == TA_AM_BEAT_THIS ? 7 : 6);
    }
  }
  return 0;
}
