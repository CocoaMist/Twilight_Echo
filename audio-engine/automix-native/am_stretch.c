/* Time-only C adaptation of the phase prediction in Signalsmith Stretch 1.3.2.
 * Copyright (c) 2022 Geraint Luff / Signalsmith Audio Ltd.
 * Changes: bounded offline buffers, radix-2 FFT, explicit source mapping,
 * no pitch/formant mapping or randomised large-ratio path. MIT, see licenses.
 */
#include "am_stretch.h"

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "am_fft.h"
typedef ta_am_complex complex_value;
struct ta_am_stretch {
  unsigned rate, channels;
  size_t n, hop, bins;
  const ta_am_kernels *k;
  ta_am_fft *fft;
  float *window, *r, *q, *normalisation, *energies, *previous_energies;
  complex_value *current, *previous, *output, *rotation;
};
static double bessel0(double x) {
  double sum = 1, term = 1;
  for (unsigned i = 1; i < 40; i++) {
    term *= x * x / (4.0 * i * i);
    sum += term;
    if (term < sum * 1e-14)
      break;
  }
  return sum;
}
ta_am_stretch *ta_am_stretch_create(unsigned rate, unsigned channels,
                                    const ta_am_kernels *k) {
  if (!k || rate < 8000 || rate > 384000 || !channels || channels > 8)
    return NULL;
  ta_am_stretch *s = calloc(1, sizeof(*s));
  if (!s)
    return NULL;
  s->rate = rate;
  s->channels = channels;
  s->k = k;
  s->n = 2;
  while (s->n < rate * 0.12)
    s->n *= 2;
  s->hop = s->n / 4;
  s->bins = s->n / 2 + 1;
  size_t bands = s->bins * channels;
  s->window = malloc(s->n * 4);
  s->r = malloc(s->n * 4);
  s->q = malloc(s->n * 4);
  s->current = calloc(bands, sizeof(complex_value));
  s->previous = calloc(bands, sizeof(complex_value));
  s->output = calloc(bands, sizeof(complex_value));
  s->rotation = malloc(s->bins * sizeof(complex_value));
  s->energies = calloc(bands, 4);
  s->previous_energies = calloc(bands, 4);
  s->fft = ta_am_fft_create(s->n, k);
  if (!s->window || !s->r || !s->q || !s->current || !s->previous ||
      !s->output || !s->rotation || !s->energies || !s->previous_energies ||
      !s->fft) {
    ta_am_stretch_free(s);
    return NULL;
  }
  for (size_t i = 0; i < s->n; i++) {
    double x = (2.0 * i + 1) / s->n - 1;
    s->window[i] = (float)(bessel0(8 * sqrt(fmax(0, 1 - x * x))) / bessel0(8));
  }
  for (size_t b = 0; b < s->bins; b++) {
    double angle = 6.2831853071795864769 * b * s->hop / s->n;
    s->rotation[b] = (complex_value){(float)cos(angle), (float)sin(angle)};
  }
  return s;
}
void ta_am_stretch_free(ta_am_stretch *s) {
  if (s) {
    free(s->window);
    free(s->r);
    free(s->q);
    free(s->normalisation);
    free(s->current);
    free(s->previous);
    free(s->output);
    free(s->rotation);
    free(s->energies);
    free(s->previous_energies);
    ta_am_fft_free(s->fft);
    free(s);
  }
}
double ta_am_stretch_source_at(double start, float first, float last,
                               size_t frames, double frame) {
  return ta_am_get_kernels(TA_AM_AUTO)
      ->source_at(start, first, last, frames, frame);
}
static int analyse(ta_am_stretch *s, const float *x, size_t frames,
                   int64_t center, unsigned channel, complex_value *spectrum) {
  size_t half = s->n / 2;
  memset(s->r, 0, s->n * 4);
  memset(s->q, 0, s->n * 4);
  /* Geometry stays in C; all window/overlap arithmetic uses the selected
   * numerical kernel. Split at the FFT half-rotation for contiguous access. */
  for (unsigned part = 0; part < 2; part++) {
    int64_t lo = (int64_t)(part * half), hi = lo + (int64_t)half;
    if (lo < (int64_t)half - center)
      lo = (int64_t)half - center;
    if (hi > (int64_t)frames + (int64_t)half - center)
      hi = (int64_t)frames + (int64_t)half - center;
    if (hi > lo) {
      size_t p = ((size_t)lo + half) % s->n;
      s->k->window(s->r + p,
                   x + (center + lo - (int64_t)half) * s->channels + channel,
                   s->window + lo, (size_t)(hi - lo), s->channels, 0);
    }
  }
  if (ta_am_fft_transform(s->fft, s->r, s->q, 0))
    return -1;
  for (size_t b = 0; b < s->bins; b++)
    spectrum[b] = (complex_value){s->r[b], s->q[b]};
  return 0;
}
static void predict(ta_am_stretch *s, float time_factor) {
  ta_am_phase_state state = {s->bins,
                             s->channels,
                             (unsigned)(s->n / s->hop),
                             time_factor,
                             0,
                             s->current,
                             s->previous,
                             s->output,
                             s->rotation,
                             s->energies,
                             s->previous_energies};
  s->k->phase(&state);
  memcpy(s->previous_energies, s->energies, s->channels * s->bins * 4);
}
int ta_am_stretch_render(ta_am_stretch *s, const float *input,
                         size_t input_frames, double start, float first,
                         float last, float *output, size_t frames) {
  return ta_am_stretch_render_cancelled(s, input, input_frames, start, first,
                                        last, output, frames, NULL);
}
int ta_am_stretch_render_cancelled(ta_am_stretch *s, const float *input,
                                   size_t input_frames, double start,
                                   float first, float last, float *output,
                                   size_t frames, const ta_am_cancel *cancel) {
  if (!s || !input || !output || !frames || frames > 384000 * 32ull ||
      input_frames > 384000 * 40ull || !isfinite(start) || start < 0 ||
      !isfinite(first) || !isfinite(last) || first < 0.88f || first > 1.12f ||
      last < 0.88f || last > 1.12f ||
      s->k->source_at(start, first, last, frames, (double)frames) >
          input_frames)
    return -1;
  if (ta_am_cancelled(cancel))
    return -2;
  for (size_t i = 0; i < input_frames * s->channels; i++)
    if (!isfinite(input[i]))
      return -1;
  if (first == 1 && last == 1 && start == floor(start)) {
    memcpy(output, input + (size_t)start * s->channels,
           frames * s->channels * 4);
    return 0;
  }
  free(s->normalisation);
  s->normalisation = calloc(frames, 4);
  if (!s->normalisation)
    return -1;
  memset(output, 0, frames * s->channels * 4);
  memset(s->output, 0, s->channels * s->bins * sizeof(complex_value));
  memset(s->previous_energies, 0, s->channels * s->bins * 4);
  int64_t prev_center = 0;
  int first_block = 1;
  for (int64_t center = -(int64_t)s->n / 2;
       center < (int64_t)frames + (int64_t)s->n / 2;
       center += (int64_t)s->hop) {
    if (ta_am_cancelled(cancel))
      return -2;
    double pos =
        center<0 ? start + center * first : center>(int64_t) frames
            ? s->k->source_at(start, first, last, frames, (double)frames) +
                  (center - (int64_t)frames) * last
            : s->k->source_at(start, first, last, frames, (double)center);
    int64_t source_center = (int64_t)llround(pos);
    for (unsigned c = 0; c < s->channels; c++)
      if (analyse(s, input, input_frames, source_center, c,
                  s->current + c * s->bins) ||
          analyse(s, input, input_frames, source_center - (int64_t)s->hop, c,
                  s->previous + c * s->bins))
        return -1;
    float factor = first_block
                       ? 1 / first
                       : (float)s->hop / (float)(source_center - prev_center);
    predict(s, factor);
    prev_center = source_center;
    first_block = 0;
    int64_t lo = (int64_t)s->n / 2 - center,
            hi = (int64_t)frames + (int64_t)s->n / 2 - center;
    if (lo < 0)
      lo = 0;
    if (hi > (int64_t)s->n)
      hi = (int64_t)s->n;
    if (hi > lo)
      s->k->window(s->normalisation + center + lo - (int64_t)s->n / 2,
                   s->window + lo, s->window + lo, (size_t)(hi - lo), 1, 1);
    for (unsigned c = 0; c < s->channels; c++) {
      complex_value *out = s->output + c * s->bins;
      for (size_t b = 0; b < s->bins; b++) {
        s->r[b] = out[b].r;
        s->q[b] = out[b].i;
      }
      s->q[0] = s->q[s->n / 2] = 0;
      for (size_t b = 1; b < s->n / 2; b++) {
        s->r[s->n - b] = s->r[b];
        s->q[s->n - b] = -s->q[b];
      }
      if (ta_am_fft_transform(s->fft, s->r, s->q, 1))
        return -1;
      for (unsigned part = 0; part < 2; part++) {
        int64_t low = lo > (int64_t)(part * s->n / 2)
                          ? lo
                          : (int64_t)(part * s->n / 2),
                high = hi < (int64_t)((part + 1) * s->n / 2)
                           ? hi
                           : (int64_t)((part + 1) * s->n / 2);
        if (high > low)
          s->k->window(output +
                           (center + low - (int64_t)s->n / 2) * s->channels + c,
                       s->r + ((size_t)low + s->n / 2) % s->n, s->window + low,
                       (size_t)(high - low), s->channels, 1);
      }
    }
  }
  for (unsigned c = 0; c < s->channels; c++)
    s->k->normalise(output + c, s->normalisation, frames, s->channels);
  return 0;
}
