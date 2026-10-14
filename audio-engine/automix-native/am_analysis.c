#include "am_analysis.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "am_asset_lock.h"
#include "am_events.h"
#include "am_fft.h"
#include "am_hash.h"
struct ta_am_analyser {
  ta_am_graph *beat, *voice;
  ta_am_frontend *beat_front, *voice_front;
  float *mel, *voice_mel, *key_r, *key_q, *key_window;
  float key_weights[359][2], key_profiles[24][12], key_profile_norm[24];
  unsigned key_pc[359];
  ta_am_fft *key_fft;
  const ta_am_kernels *k;
};
ta_am_analyser *ta_am_analyser_create(const char *beat, const char *voice,
                                      const ta_am_kernels *k, char *error,
                                      size_t n) {
  char hash[65];
  if (ta_am_sha256_file(beat, hash) || strcmp(hash, TA_AM_BEAT_GRAPH_SHA256) ||
      ta_am_sha256_file(voice, hash) ||
      strcmp(hash, TA_AM_VOICE_GRAPH_SHA256)) {
    if (error && n)
      snprintf(error, n, "public model asset integrity mismatch");
    return NULL;
  }
  ta_am_analyser *a = calloc(1, sizeof(*a));
  if (!a)
    return NULL;
  a->k = k;
  a->beat = ta_am_graph_load(beat, k, error, n);
  if (!a->beat)
    goto fail;
  a->voice = ta_am_graph_load(voice, k, error, n);
  if (!a->voice)
    goto fail;
  if (ta_am_graph_input_count(a->beat, 0) != 1500 * 128 ||
      ta_am_graph_output_count(a->beat, 0) != 1500 ||
      ta_am_graph_output_count(a->beat, 1) != 1500 ||
      ta_am_graph_input_count(a->voice, 0) != 96 * 64 ||
      ta_am_graph_output_count(a->voice, 0) != 521)
    goto fail;
  a->beat_front = ta_am_frontend_create(TA_AM_BEAT_THIS, k);
  a->voice_front = ta_am_frontend_create(TA_AM_YAMNET, k);
  a->mel = malloc(1500 * 128 * 4);
  a->voice_mel = malloc(96 * 64 * 4);
  a->key_fft = ta_am_fft_create(4096, k);
  a->key_r = malloc(4096 * 4);
  a->key_q = malloc(4096 * 4);
  a->key_window = malloc(4096 * 4);
  if (!a->beat_front || !a->voice_front || !a->mel || !a->voice_mel ||
      !a->key_fft || !a->key_r || !a->key_q || !a->key_window)
    goto fail;
  for (size_t i = 0; i < 4096; i++)
    a->key_window[i] =
        (float)(0.5 - 0.5 * cos(6.2831853071795864769 * i / 4096));
  /* Geometry/profile constants are computed once off the analysis path. */
  for (unsigned b = 13; b < 372; b++) {
    double note = 69 + 12 * log2(b * 22050.0 / (4096 * 440));
    int base = (int)floor(note);
    float fraction = (float)(note - base);
    a->key_pc[b - 13] = (unsigned)(((base % 12) + 12) % 12);
    a->key_weights[b - 13][0] = 1 - fraction;
    a->key_weights[b - 13][1] = fraction;
  }
  static const float profiles[2][12] = {
      {6.35f, 2.23f, 3.48f, 2.33f, 4.38f, 4.09f, 2.52f, 5.19f, 2.39f, 3.66f,
       2.29f, 2.88f},
      {6.33f, 2.68f, 3.52f, 5.38f, 2.6f, 3.53f, 2.54f, 4.75f, 3.98f, 2.69f,
       3.34f, 3.17f}};
  for (unsigned mode = 0; mode < 2; mode++) {
    float mean = 0;
    for (unsigned i = 0; i < 12; i++)
      mean += profiles[mode][i] / 12;
    for (unsigned root = 0; root < 12; root++) {
      unsigned key = mode * 12 + root;
      for (unsigned i = 0; i < 12; i++)
        a->key_profiles[key][i] = profiles[mode][(i + 12 - root) % 12] - mean;
      a->key_profile_norm[key] = k->reduce(a->key_profiles[key], 12, 1, 1);
    }
  }
  return a;
fail:
  ta_am_analyser_free(a);
  return NULL;
}
void ta_am_analyser_free(ta_am_analyser *a) {
  if (a) {
    ta_am_graph_free(a->beat);
    ta_am_graph_free(a->voice);
    ta_am_frontend_free(a->beat_front);
    ta_am_frontend_free(a->voice_front);
    free(a->mel);
    free(a->voice_mel);
    ta_am_fft_free(a->key_fft);
    free(a->key_r);
    free(a->key_q);
    free(a->key_window);
    free(a);
  }
}
static int ascending(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return x < y ? -1 : x > y;
}
static void tempo(ta_am_features *f) {
  if (f->beat_count < 8)
    return;
  double intervals[1500];
  size_t n = 0;
  for (size_t i = 1; i < f->beat_count; i++) {
    double d = f->beats[i] - f->beats[i - 1];
    if (d > 0.15 && d < 2)
      intervals[n++] = d;
  }
  if (n < 7)
    return;
  qsort(intervals, n, sizeof(double), ascending);
  double median = intervals[n / 2], sum = 0;
  unsigned good = 0;
  for (size_t i = 0; i < n; i++) {
    double diff = fabs(intervals[i] - median) / median;
    if (diff < 0.08)
      good++;
    sum += fmin(diff, 1);
  }
  double bpm = 60 / median;
  if (bpm < 55 || bpm > 215)
    return;
  f->bpm = (float)bpm;
  f->tempo_confidence = (float)((double)good / n * fmax(0, 1 - sum / n * 4));
}
static void key_estimate(ta_am_analyser *a, ta_am_features *f,
                         const float *input, size_t samples) {
  /* Independent 4096-point chroma, soft assignment in semitone space.
   * Require a clear profile and margin. Unknown is preserved as -1. */
  float chroma[12] = {0};
  for (size_t start = 0; start + 4096 <= samples; start += 2048) {
    memset(a->key_q, 0, 4096 * 4);
    a->k->binary(a->key_r, input + start, a->key_window, 4096, 1);
    if (ta_am_fft_transform(a->key_fft, a->key_r, a->key_q, 0))
      return;
    a->k->binary(a->key_r, a->key_r, a->key_r, 372, 1);
    a->k->binary(a->key_q, a->key_q, a->key_q, 372, 1);
    a->k->binary(a->key_r, a->key_r, a->key_q, 372, 0);
    a->k->unary(a->key_r, a->key_r, 372, 5);
    for (unsigned b = 13; b < 372; b++) {
      unsigned pc = a->key_pc[b - 13];
      a->k->axpy(chroma + pc, a->key_r + b, a->key_weights[b - 13][0], 1);
      a->k->axpy(chroma + (pc + 1) % 12, a->key_r + b,
                 a->key_weights[b - 13][1], 1);
    }
  }
  float scaled[12], divisor = 12;
  for (unsigned i = 0; i < 12; i++)
    a->k->binary(scaled + i, chroma + i, &divisor, 1, 2);
  float mean = a->k->reduce(scaled, 12, 1, 0);
  a->k->affine(chroma, chroma, 1, -mean, 12);
  float norm = a->k->reduce(chroma, 12, 1, 1);
  if (norm < 1e-12f)
    return;
  float best = -1, next = -1;
  int selected = -1;
  for (int key = 0; key < 24; key++) {
    float denominator, score;
    /* dot is correlation; the selected assembly implementation owns it. */
    score = a->k->dot(chroma, a->key_profiles[key], 12);
    a->k->binary(&denominator, &norm, a->key_profile_norm + key, 1, 1);
    a->k->unary(&denominator, &denominator, 1, 5);
    a->k->binary(&score, &score, &denominator, 1, 2);
    if (score > best) {
      next = best;
      best = score;
      selected = key;
    } else if (score > next)
      next = score;
  }
  if (best > 0.65f && best - next > 0.12f) {
    f->key = selected;
    f->key_confidence = fminf(1, (best - next) * 4);
  }
}
static float energy_db(const ta_am_kernels *k, double energy, size_t samples) {
  float mean = (float)fmax(energy / samples, 1e-14), db;
  k->unary(&db, &mean, 1, 6);
  k->affine(&db, &db, 4.342944819032518f, 0, 1);
  return db;
}
int ta_am_analyse_window(ta_am_analyser *a, const float *x, size_t samples,
                         const float *voice, size_t voice_samples, double start,
                         double duration, ta_am_features *f,
                         const ta_am_cancel *cancel) {
  if (!a || !x || !voice || !f || !samples || samples > 661500 ||
      !voice_samples || voice_samples > 480000 || !isfinite(start) ||
      !isfinite(duration) || start < 0 || duration <= 0 || duration > 604800 ||
      start >= duration ||
      fabs(samples / 22050.0 - voice_samples / 16000.0) > 0.05)
    return -1;
  if (ta_am_cancelled(cancel))
    return -2;
  memset(f, 0, sizeof(*f));
  f->key = -1;
  f->start_seconds = start;
  /* Both frontends must have real PCM for the declared coverage. */
  double window_seconds = fmin(samples / 22050.0, voice_samples / 16000.0);
  f->end_seconds = fmin(duration, start + window_seconds);
  f->duration_seconds = duration;
  f->complete =
      start == 0 && fabs(f->end_seconds - duration) <= 1.0 / 16000 + 1e-9;
  f->frame_count = (uint32_t)fmin(1500, ceil((f->end_seconds - start) * 50));
  double total = 0;
  float low = 0, alpha = (float)(1 - exp(-6.283185307179586 * 200 / 22050));
  f->spectral_count = f->frame_count;
  for (size_t i = 0; i < samples; i++) {
    if (!isfinite(x[i]))
      return -1;
  }
  a->k->moments(x, samples, &total, &f->peak);
  f->rms_db = energy_db(a->k, total, samples);
  for (size_t frame = 0; frame < f->frame_count; frame++) {
    size_t s = frame * 441, end = s + 441 < samples ? s + 441 : samples;
    double energy = 0;
    a->k->moments(x + s, end - s, &energy, f->frame_peak + frame);
    f->frame_db[frame] = energy_db(a->k, energy, end - s);
    double low_energy = 0;
    for (size_t i = s; i < end; i++) {
      low += alpha * (x[i] - low);
      low_energy += (double)low * low;
    }
    f->frame_low_db[frame] = energy_db(a->k, low_energy, end - s);
    f->frame_onset[frame] = frame ? fmaxf(0, f->frame_db[frame] - f->frame_db[frame - 1]) : 0;
  }
  /* Pad short windows with actual silence, so reflected padding never repeats
   * a short song across the complete 30-second inference context. */
  float *padded = NULL;
  const float *beat_input = x;
  if (samples < 661500) {
    padded = calloc(661500, 4);
    if (!padded)
      return -1;
    memcpy(padded, x, samples * 4);
    beat_input = padded;
  }
  int result = ta_am_frontend_process(a->beat_front, beat_input, 661500, 0,
                                      1500, a->mel);
  free(padded);
  if (result)
    return result;
  if ((result = ta_am_graph_run(a->beat, a->mel, 1500 * 128, cancel)))
    return result;
  size_t nb, nd;
  if (ta_am_beat_events(ta_am_graph_output(a->beat, 0),
                        ta_am_graph_output(a->beat, 1), f->frame_count,
                        f->beats, &nb, f->downbeats, &nd))
    return -1;
  f->beat_count = (uint32_t)nb;
  f->downbeat_count = (uint32_t)nd;
  for (size_t i = 0; i < nb; i++)
    f->beats[i] += start;
  for (size_t i = 0; i < nd; i++)
    f->downbeats[i] += start;
  tempo(f);
  key_estimate(a, f, x, samples);
  for (size_t patch = 0;
       voice_samples >= 15600 && f->voice_count < 64; patch++) {
    size_t max_offset = voice_samples - 15600,
           offset = patch * 7680 < max_offset ? patch * 7680 : max_offset;
    if (ta_am_cancelled(cancel))
      return -2;
    if (ta_am_frontend_process(a->voice_front, voice, voice_samples, offset, 96,
                               a->voice_mel) ||
        (result = ta_am_graph_run(a->voice, a->voice_mel, 96 * 64, cancel)))
      return result ? result : -1;
    const float *scores = ta_am_graph_output(a->voice, 0);
    f->voice[f->voice_count] = ta_am_voice_probability(scores, 521);
    /* Class 132 is Music in the pinned YAMNet published class map. */
    f->music[f->voice_count] = scores[132];
    f->voice_start[f->voice_count] = start + offset / 16000.0;
    f->voice_end[f->voice_count] =
        fmin(f->end_seconds, start + (offset + 15600) / 16000.0);
    f->voice_count++;
    if (offset == max_offset)
      break;
  }
  return 0;
}
float ta_am_voice_between(const ta_am_features *f, double start, double end,
                          int music) {
  if (!f || !isfinite(start) || !isfinite(end) || start < f->start_seconds ||
      end > f->end_seconds || end < start || !f->voice_count)
    return -1;
  float maximum = 0;
  int covered = 0;
  double covered_end = start;
  for (size_t i = 0; i < f->voice_count; i++) {
    double s = f->voice_start[i], e = f->voice_end[i];
    if (e < start || s > end)
      continue;
    if (!isfinite(s) || !isfinite(e) || !isfinite(f->voice[i]) ||
        !isfinite(f->music[i]) || f->voice[i] < 0 || f->voice[i] > 1 ||
        f->music[i] < 0 || f->music[i] > 1 || s > covered_end + 1e-6 ||
        (music && f->music[i] < 0.1f))
      return -1;
    maximum = fmaxf(maximum, f->voice[i]);
    covered = 1;
    covered_end = fmax(covered_end, e);
  }
  return covered && covered_end >= end ? maximum : -1;
}
