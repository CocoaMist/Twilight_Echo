#include "am_plan.h"
#include "am_rhythm.h"

#include <float.h>
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
struct ta_am_prepared {
  ta_am_plan_spec spec;
  float *lane[2], *gain[2];
  size_t bytes;
  size_t reservation;
  const ta_am_kernels *k;
};
static _Atomic size_t preparation_bytes = 0;
static int reserve_preparation(size_t bytes) {
  size_t current =
      atomic_load_explicit(&preparation_bytes, memory_order_relaxed);
  do {
    if (bytes > 128u * 1024 * 1024 - current)
      return 0;
  } while (!atomic_compare_exchange_weak_explicit(
      &preparation_bytes, &current, current + bytes, memory_order_acq_rel,
      memory_order_relaxed));
  return 1;
}
static void reason_text(char *s, size_t n, const char *text) {
  if (s && n)
    snprintf(s, n, "%s", text);
}
static int identity_valid(const char *s) {
  for (unsigned i = 0; i < 64; i++)
    if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f')))
      return 0;
  return !s[64];
}
int ta_am_features_valid(const ta_am_features *f) {
  if (!f || !isfinite(f->duration_seconds) || !isfinite(f->start_seconds) ||
      !isfinite(f->end_seconds) || f->duration_seconds <= 0 ||
      f->duration_seconds > 604800 || f->start_seconds < 0 ||
      f->end_seconds <= f->start_seconds ||
      f->end_seconds - f->start_seconds > 120.001 ||
      f->end_seconds > f->duration_seconds + 1e-6 || f->beat_count > TA_AM_MAX_EVENTS ||
      f->downbeat_count > TA_AM_MAX_EVENTS || f->voice_count > TA_AM_MAX_VOICE || !f->frame_count ||
      f->frame_count > TA_AM_MAX_FRAMES || (f->spectral_count && f->spectral_count != f->frame_count) ||
      fabs(f->frame_count - (f->end_seconds - f->start_seconds) * 50) > 1.001 ||
      f->complete > 1 ||
      (f->complete && (f->start_seconds != 0 ||
                       fabs(f->end_seconds - f->duration_seconds) > 0.0001)) ||
      !isfinite(f->rms_db) || f->rms_db < -160 || f->rms_db > 60 ||
      !isfinite(f->peak) || f->peak < 0 || f->peak > 1000 ||
      !isfinite(f->bpm) || f->bpm < 0 || f->bpm > 300 ||
      !isfinite(f->tempo_confidence) || f->tempo_confidence < 0 ||
      f->tempo_confidence > 1 || f->key < -1 || f->key > 23 ||
      !isfinite(f->key_confidence) || f->key_confidence < 0 ||
      f->key_confidence > 1)
    return 0;
  for (unsigned i = 0; i < f->beat_count; i++)
    if (!isfinite(f->beats[i]) || f->beats[i] < f->start_seconds ||
        f->beats[i] > f->end_seconds || (i && f->beats[i] <= f->beats[i - 1]))
      return 0;
  for (unsigned i = 0; i < f->downbeat_count; i++)
    if (!isfinite(f->downbeats[i]) || f->downbeats[i] < f->start_seconds ||
        f->downbeats[i] > f->end_seconds ||
        (i && f->downbeats[i] <= f->downbeats[i - 1]))
      return 0;
  for (unsigned i = 0; i < f->voice_count; i++)
    if (!isfinite(f->voice[i]) || !isfinite(f->music[i]) || f->voice[i] < 0 ||
        f->voice[i] > 1 || f->music[i] < 0 || f->music[i] > 1 ||
        !isfinite(f->voice_start[i]) || !isfinite(f->voice_end[i]) ||
        f->voice_start[i] < f->start_seconds ||
        f->voice_end[i] > f->end_seconds + 1e-6 ||
        f->voice_end[i] <= f->voice_start[i] ||
        (i && f->voice_start[i] <= f->voice_start[i - 1]))
      return 0;
  for (unsigned i = 0; i < f->frame_count; i++)
    if (!isfinite(f->frame_db[i]) || f->frame_db[i] < -160 ||
        f->frame_db[i] > 60 || !isfinite(f->frame_peak[i]) ||
        f->frame_peak[i] < 0 || f->frame_peak[i] > 1000 ||
        (f->spectral_count && (!isfinite(f->frame_onset[i]) || f->frame_onset[i] < 0 || f->frame_onset[i] > 1000 ||
          !isfinite(f->frame_low_db[i]) || f->frame_low_db[i] < -160 || f->frame_low_db[i] > 60)))
      return 0;
  return 1;
}
static double silence_boundary(const ta_am_features *f, int leading) {
  unsigned count = 0, limit = f->frame_count;
  while (count < limit) {
    unsigned i = leading ? count : f->frame_count - 1 - count;
    if (f->frame_db[i] > -65 || f->frame_peak[i] > 0.00018f)
      break;
    count++;
  }
  if (count < 8) return 0;
  double seconds = count / 50.;
  double start = leading ? f->start_seconds : f->end_seconds - seconds;
  double end = leading ? f->start_seconds + seconds : f->end_seconds;
  float activity = ta_am_voice_between(f, start, end, 0);
  return activity >= 0 && activity <= .08f ? seconds : 0;
}
static int tempo_rates(float a, float b, float limit, float *ar, float *br) {
  float lower = fmaxf(a, b) * (1 - limit),
        upper = fminf(a, b) * (1 + limit);
  if (lower > upper) return 0;
  float target = fmaxf(lower, fminf(upper, sqrtf(a * b)));
  *ar = target / a; *br = target / b;
  return *ar >= 1 - limit && *ar <= 1 + limit &&
         *br >= 1 - limit && *br <= 1 + limit;
}
static float region_energy(const ta_am_features *f, double start, double end,
                           const ta_am_kernels *k, int active_only) {
  float energy[TA_AM_MAX_FRAMES];
  unsigned count = 0;
  for (unsigned i = 0; i < f->frame_count; i++) {
    double time = f->start_seconds + i / 50.;
    if (time >= start && time < end && (!active_only || f->frame_db[i] > -55))
      energy[count++] = f->frame_db[i];
  }
  if (!count) return active_only ? region_energy(f, start, end, k, 0) : -160;
  k->affine(energy, energy, .23025850929940458f, 0, count);
  k->unary(energy, energy, count, 0);
  float mean = (float)(k->sum(energy, count, 1) / count), db;
  k->unary(&db, &mean, 1, 6);
  // Candidate decisions use a fixed dB grid, independent of SIMD reductions.
  return (float)(round(db * 4.342944819032518 * 100) / 100);
}
static float region_rms(const ta_am_features *f, double start, double end,
                        const ta_am_kernels *k) {
  return region_energy(f, start, end, k, 1);
}
static int music_witness(const ta_am_features *f, double start, double end) {
  if (ta_am_voice_between(f, start, end, 0) < 0) return 0;
  unsigned active = 0, musical = 0;
  for (unsigned i = 0; i < f->frame_count; i++) {
    double t = f->start_seconds + i / 50.;
    if (t < start || t >= end || f->frame_db[i] <= -55) continue;
    float music = 0;
    for (unsigned j = 0; j < f->voice_count; j++)
      if (f->voice_start[j] <= t && f->voice_end[j] > t)
        music = fmaxf(music, f->music[j]);
    active++; musical += music >= .1f;
  }
  // Quiet padding is not negative music evidence. The model's independent
  // parent-class score is a positive witness, not a veto on every other frame.
  return active >= 25 && musical >= 25;
}
static size_t preparation_peak(const ta_am_plan_spec *s, size_t na, size_t nb) {
  size_t samples = (size_t)s->output_frames * s->binding.channels;
  size_t peak = samples * 16 + (na + nb) * s->binding.channels * 4 +
                (size_t)s->output_frames * 4 + 8u * 1024 * 1024;
  if (s->effect == TA_AM_ECHO || s->effect == TA_AM_REVERB) peak += samples * 4;
  if (s->stem_enhanced) peak += (na + nb) * s->binding.channels * 4;
  size_t fft = 2;
  while (fft < s->binding.sample_rate * .12) fft *= 2;
  return peak + fft * (s->binding.channels * 32 + 32) +
         (size_t)s->binding.sample_rate * s->binding.channels * 8;
}
static int content_boundary(const ta_am_features *a, const ta_am_features *b,
                             const ta_am_binding *bind, const ta_am_kernels *k,
                             double end, double begin, uint64_t minimum_start,
                             ta_am_plan_spec *out) {
  float best = -FLT_MAX;
  for (unsigned seconds = 2; seconds <= 8; seconds++) {
    double start = end - seconds, b_end = begin + seconds;
    if (start < a->start_seconds || b_end > b->end_seconds ||
        start * bind->sample_rate < minimum_start) continue;
    float av = ta_am_voice_between(a, start, end, 0),
          bv = ta_am_voice_between(b, begin, b_end, 0);
    // Vocal tails may finish while the outgoing deck still leads; incoming
    // words may begin after it leads. Unknown activity cannot prove that handoff.
    float late_a = ta_am_voice_between(a, start + seconds * .5, end, 0),
          early_b = ta_am_voice_between(b, begin, begin + seconds * .5, 0);
    if (av < 0 || bv < 0 || late_a < 0 || early_b < 0 ||
        late_a > .08f || early_b > .08f ||
        !music_witness(a, start, end) ||
        !music_witness(b, begin, b_end)) continue;
    // Envelope evidence must include quiet frames. Active-only loudness is
    // useful for gain matching but would hide a real fade into a quiet exit.
    float entry = region_energy(a, start, start + 1, k, 0),
          exit = region_energy(a, end - 1, end, k, 0);
    if (entry <= -55 || region_rms(b, begin, b_end, k) <= -55 ||
        region_energy(b, b_end - 1, b_end, k, 0) <= -55) continue;
    double silence = silence_boundary(a, 0);
    float decay = entry - exit;
    if (silence < .4 && decay < 6) continue;
    float a_db = region_rms(a, start, end, k), b_db = region_rms(b, begin, b_end, k);
    float score = .5f + fminf(fmaxf(decay, 0), 18) * .03f +
        (float)fmin(silence, 2) * .15f - (av + bv) * 2 -
        (float)fabs((double)seconds - 6) * .05f - fminf(fabsf(a_db - b_db), 12) * .025f;
    if (score <= best) continue;
    ta_am_plan_spec spec = {0};
    spec.binding = *bind; spec.mode = TA_AM_NATURAL;
    spec.kind = TA_AM_CONTENT_BOUNDARY; spec.effect = TA_AM_CLEAN;
    spec.current_rate = spec.next_rate = 1;
    // Zero remains the honest value for unknown beat tempo/confidence.
    spec.bpm = spec.confidence = 0; spec.score = score;
    spec.next_gain = fmaxf(.5f, fminf(2, powf(10, (a_db - b_db) / 20)));
    spec.output_frames = (uint64_t)seconds * bind->sample_rate;
    if (spec.output_frames * bind->channels * 16 > 128u * 1024 * 1024) continue;
    spec.current_start = (uint64_t)llround(start * bind->sample_rate);
    spec.current_end = spec.current_start + spec.output_frames;
    spec.next_start = (uint64_t)llround(begin * bind->sample_rate);
    spec.next_end = spec.next_start + spec.output_frames;
    if (spec.current_end > (uint64_t)llround(end * bind->sample_rate) ||
        spec.next_end > (uint64_t)llround(b_end * bind->sample_rate)) continue;
    size_t context = (size_t)spec.output_frames + bind->sample_rate * 4;
    if (preparation_peak(&spec, context, context) > 128u * 1024 * 1024) continue;
    *out = spec; best = score;
  }
  return best > -FLT_MAX;
}
int ta_am_select(const ta_am_features *a, const ta_am_features *b,
                 ta_am_mode mode, const ta_am_binding *bind,
                 ta_am_plan_spec *out, char *reason, size_t n) {
  return ta_am_select_with_kernels(
      a, b, mode, bind, ta_am_get_kernels(TA_AM_AUTO), out, reason, n);
}
static int select_boundary(const ta_am_features *a, const ta_am_features *b,
                              ta_am_mode mode, const ta_am_binding *bind,
                              const ta_am_kernels *k, ta_am_plan_spec *out,
                              uint64_t minimum_start, char *reason, size_t n) {
  reason_text(reason, n, "");
  if (!out || !bind || !k || !ta_am_features_valid(a) ||
      !ta_am_features_valid(b) || bind->sample_rate < 8000 ||
      bind->sample_rate > 384000 || !bind->channels || bind->channels > 8 ||
      !identity_valid(bind->current_identity) ||
      !identity_valid(bind->next_identity) ||
      (mode != TA_AM_NATURAL && mode != TA_AM_DJ)) {
    reason_text(reason, n, "invalid_request");
    return -1;
  }
  memset(out, 0, sizeof(*out));
  if (a->end_seconds < a->duration_seconds - 0.021 ||
      b->start_seconds > 0.001) {
    reason_text(reason, n, "incomplete_boundary_coverage");
    return 0;
  }
  if (a->duration_seconds < 12 || b->duration_seconds < 12) {
    reason_text(reason, n, "short_track");
    return 0;
  }
  if (a->peak < 0.0001f || b->peak < 0.0001f) {
    reason_text(reason, n, "silent_track");
    return 0;
  }
  float limit = mode == TA_AM_NATURAL ? 0.04f : 0.12f;
  // A bounded short codec tail may be absent from the actual decoded coverage.
  // Do not ask regional estimators or source joins to consume that absent PCM.
  double end = fmin(a->duration_seconds, a->end_seconds) - silence_boundary(a, 0),
         begin = silence_boundary(b, 1);
  double durations[5] = {mode == TA_AM_NATURAL ? 6 : 12,
                         mode == TA_AM_NATURAL ? 4 : 8,
                         mode == TA_AM_NATURAL ? 8 : 16,
                         mode == TA_AM_NATURAL ? 5 : 10,
                         mode == TA_AM_NATURAL ? 7 : 14};
  if ((!a->beat_count || !b->beat_count) && mode == TA_AM_DJ) {
    reason_text(reason, n, "missing_boundary_beats");
    return 0;
  }
  float best = -FLT_MAX;
  ta_am_plan_spec selected = {0};
  int rhythm_found = 0, compatible_tempo = 0;
  for (unsigned d = 0; d < 5; d++) {
    ta_am_rhythm ra, rb;
    if (!ta_am_rhythm_region(a, fmax(a->start_seconds, end - durations[d] * (1 + limit) - 2), end, k, &ra) ||
        !ta_am_rhythm_region(b, begin, fmin(b->end_seconds, begin + durations[d] * (1 + limit) + 2), k, &rb))
      continue;
    rhythm_found = 1;
    for (unsigned harmonic = 0; harmonic < 3; harmonic++) {
      float folded = rb.bpm * (harmonic == 0 ? 1 : harmonic == 1 ? .5f : 2);
      if (folded < 55 || folded > 300) continue;
      float ar, br;
      if (!tempo_rates(ra.bpm, folded, limit, &ar, &br)) continue;
      compatible_tempo = 1;
      double first_b = rb.first;
    for (unsigned beat = 0; beat < a->beat_count; beat++) {
      if (a->beats[beat] < ra.first || a->beats[beat] > ra.last) continue;
      double seconds = durations[d], span = (0.9 * ar + 0.1) * seconds,
             start = end - span;
      double shift = (first_b - begin) / br - (a->beats[beat] - start) / ar;
      seconds += shift * ar / (0.9 * ar + 0.1);
      start = end - seconds * (0.9 * ar + 0.1);
      if (seconds < 4 ||
          seconds > (mode == TA_AM_NATURAL ? 8 : 16) ||
          start < a->start_seconds || start < 0 ||
          start * bind->sample_rate < minimum_start || a->beats[beat] < start ||
          a->beats[beat] > start + seconds * ar * .75 ||
          (first_b - begin) / br > seconds * .75)
        continue;
      double b_end = begin + seconds * (0.9 * br + 0.1);
      if (b_end > b->end_seconds)
        continue;
      float av = ta_am_voice_between(a, start, end, 0),
            bv = ta_am_voice_between(b, begin, b_end, 0);
      float conflict = av < 0 || bv < 0 ? 1 : fminf(av, bv);
      float a_db = region_rms(a, start, end, k), b_db = region_rms(b, begin, b_end, k);
      float score = fminf(ra.confidence, rb.confidence) * 3 -
                    conflict * 2 - fabsf(ar - 1) * 5 - fabsf(br - 1) * 5 -
                    (float)fabs(seconds - durations[0]) * 0.05f -
                    fminf(fabsf(a_db - b_db), 12) * .025f - harmonic * .03f;
      if (a->key >= 0 && b->key >= 0 && a->key_confidence >= .6f && b->key_confidence >= .6f) {
        int distance = abs(a->key % 12 - b->key % 12);
        if (distance && distance != 5 && distance != 7) score -= .15f;
      }
      if (score <= best)
        continue;
      memset(&selected, 0, sizeof(selected));
      selected.binding = *bind;
      selected.mode = mode;
      selected.effect = TA_AM_CLEAN;
      selected.current_rate = ar;
      selected.next_rate = br;
      selected.bpm = ra.bpm * ar;
      selected.confidence = fminf(ra.confidence, rb.confidence);
      selected.score = score;
      selected.next_gain =
          fmaxf(0.5f, fminf(2, powf(10, (a_db - b_db) / 20)));
      selected.output_frames = (uint64_t)llround(seconds * bind->sample_rate);
      selected.current_start = (uint64_t)llround(start * bind->sample_rate);
      selected.current_end = (uint64_t)llround(k->source_at(
          (double)selected.current_start, ar, 1, (size_t)selected.output_frames,
          (double)selected.output_frames));
      /* Rounding start/output independently can otherwise consume one source
       * frame past the real boundary. Keep one shared, bounded integral. */
      uint64_t boundary_frame = (uint64_t)llround(end * bind->sample_rate);
      while ((selected.current_end > boundary_frame ||
              k->source_at((double)selected.current_start, ar, 1,
                           (size_t)selected.output_frames,
                           (double)selected.output_frames) >
                  (double)boundary_frame) &&
             selected.output_frames > 2) {
        selected.output_frames--;
        selected.current_end = (uint64_t)llround(k->source_at(
            (double)selected.current_start, ar, 1,
            (size_t)selected.output_frames, (double)selected.output_frames));
      }
      selected.next_start = (uint64_t)llround(begin * bind->sample_rate);
      selected.next_end = (uint64_t)llround(k->source_at(
          (double)selected.next_start, br, 1, (size_t)selected.output_frames,
          (double)selected.output_frames));
      if (mode == TA_AM_DJ) {
        float safe_a = ta_am_voice_between(a, start, end, 1),
              safe_b = ta_am_voice_between(b, begin, b_end, 1);
        if (safe_a >= 0 && safe_b >= 0 && safe_a < 0.03f && safe_b < 0.03f) {
          /* Repeat needs the strongest beat confidence. Effect selection
           * uses measurable context, with deterministic ties. */
          selected.effect =
              selected.confidence > 0.92f && selected.bpm > 150 ? TA_AM_REPEAT
              : a->key >= 0 && b->key >= 0 && a->key % 12 == b->key % 12
                  ? TA_AM_REVERB
              : fabsf(a->rms_db - b->rms_db) > 5 ? TA_AM_FILTER
                                                 : TA_AM_ECHO;
        }
      }
      size_t bytes = (size_t)selected.output_frames * bind->channels * 4 * 4;
      size_t na = (size_t)(selected.current_end - selected.current_start + bind->sample_rate * 4),
             nb = (size_t)(selected.next_end - selected.next_start + bind->sample_rate * 4);
      if (bytes > 128u * 1024 * 1024 ||
          preparation_peak(&selected, na, nb) > 128u * 1024 * 1024)
        continue;
      best = score;
      *out = selected;
    }
    }
  }
  if (best == -FLT_MAX) {
    if (mode == TA_AM_NATURAL && content_boundary(a, b, bind, k, end, begin, minimum_start, out)) return 1;
    reason_text(reason, n, !rhythm_found ? "low_beat_confidence" :
        !compatible_tempo ? "tempo_outside_mode_limit" : "no_safe_boundary_candidate");
    return 0;
  }
  return 1;
}
#include "am_dj.inc"

const char *ta_am_transition_name(ta_am_transition_kind kind) {
  return kind == TA_AM_CONTENT_BOUNDARY ? "content-boundary" :
         kind == TA_AM_TAIL_OVERLAP ? "tail-overlap" :
         kind == TA_AM_RELEASE_BOUNDARY ? "release-boundary" :
         kind == TA_AM_BEAT_ALIGNED ? "beat-aligned" : "";
}

int ta_am_plan_valid(const ta_am_plan_spec *s, const ta_am_kernels *k) {
  if (!s || !k || (s->mode != TA_AM_NATURAL && s->mode != TA_AM_DJ) ||
      s->binding.sample_rate < 8000 || s->binding.sample_rate > 384000 ||
      !s->binding.channels || s->binding.channels > 8 ||
      !identity_valid(s->binding.current_identity) ||
      !identity_valid(s->binding.next_identity) || s->output_frames < 2 ||
      s->output_frames > (uint64_t)s->binding.sample_rate *
                             (s->mode == TA_AM_NATURAL ? 8 : 32) ||
      s->current_start >= s->current_end || s->next_start >= s->next_end ||
      s->current_end > (uint64_t)s->binding.sample_rate * 604800 ||
      s->next_end > (uint64_t)s->binding.sample_rate * 604800 ||
      !isfinite(s->current_rate) || !isfinite(s->next_rate) ||
      !isfinite(s->next_gain) || s->next_gain < 0.5f || s->next_gain > 2 ||
      !isfinite(s->bpm) || s->bpm < 0 || s->bpm > 300 ||
      !isfinite(s->confidence) || s->confidence < 0 || s->confidence > 1 ||
      !isfinite(s->score) || s->effect < TA_AM_CLEAN ||
      s->effect > TA_AM_REPEAT ||
      (s->mode == TA_AM_NATURAL && s->effect != TA_AM_CLEAN) ||
      (s->kind != TA_AM_BEAT_ALIGNED && s->kind != TA_AM_CONTENT_BOUNDARY &&
       s->kind != TA_AM_TAIL_OVERLAP && s->kind != TA_AM_RELEASE_BOUNDARY) ||
      (s->kind == TA_AM_BEAT_ALIGNED && (s->bpm < 55 || s->confidence < .55f)) ||
      (s->kind != TA_AM_BEAT_ALIGNED && (
          s->effect != TA_AM_CLEAN || s->current_rate != 1 || s->next_rate != 1 ||
          s->bpm != 0 || s->confidence != 0)) ||
      (s->kind == TA_AM_CONTENT_BOUNDARY && s->output_frames > (uint64_t)s->binding.sample_rate * 8) ||
      (s->kind == TA_AM_RELEASE_BOUNDARY && (
          s->output_frames < (uint64_t)s->binding.sample_rate * 2 ||
          s->output_frames > (uint64_t)s->binding.sample_rate * 8)) ||
      (s->kind == TA_AM_TAIL_OVERLAP && (s->mode != TA_AM_DJ ||
          s->output_frames < (uint64_t)s->binding.sample_rate * 16 ||
          s->output_frames > (uint64_t)s->binding.sample_rate * 24)))
    return 0;
  float lo = s->mode == TA_AM_NATURAL ? 0.96f : 0.88f,
        hi = s->mode == TA_AM_NATURAL ? 1.04f : 1.12f;
  if (s->current_rate < lo || s->current_rate > hi || s->next_rate < lo ||
      s->next_rate > hi)
    return 0;
  return s->current_end ==
             (uint64_t)llround(k->source_at(
                 (double)s->current_start, s->current_rate, 1,
                 (size_t)s->output_frames, (double)s->output_frames)) &&
         s->next_end ==
             (uint64_t)llround(k->source_at((double)s->next_start, s->next_rate,
                                            1, (size_t)s->output_frames,
                                            (double)s->output_frames));
}
uint64_t ta_am_plan_source_frame(const ta_am_plan_spec *s, unsigned deck,
                                 double frame) {
  if (!s || deck > 1 || !isfinite(frame))
    return 0;
  double start = (double)(deck ? s->next_start : s->current_start);
  float rate = deck ? s->next_rate : s->current_rate;
  return (uint64_t)llround(
      ta_am_stretch_source_at(start, rate, 1, (size_t)s->output_frames, frame));
}
static int effects(ta_am_prepared *p) {
  if (p->spec.effect == TA_AM_CLEAN)
    return 0;
  unsigned channels = p->spec.binding.channels,
           rate = p->spec.binding.sample_rate;
  size_t frames = (size_t)p->spec.output_frames;
  float *x = p->lane[0];
  size_t start = frames / 2;
  if (p->spec.effect == TA_AM_FILTER) {
    /* Gain buffers are scratch until the final crossfade curves are built. */
    size_t count = frames - start;
    float *alpha = p->gain[0], *blend = p->gain[1];
    p->k->linear(blend, 0, (float)(count - 1) / count, count);
    p->k->affine(alpha, blend, logf(0.03f), 0, count);
    p->k->unary(alpha, alpha, count, 0);
    p->k->affine(alpha, alpha, -6.2831853071795864769f * 18000 / rate, 0,
                 count);
    p->k->unary(alpha, alpha, count, 0);
    p->k->affine(alpha, alpha, -1, 1, count);
    p->k->lowpass_exit(x + start * channels, count, channels, alpha, blend);
  } else if (p->spec.effect == TA_AM_REPEAT) {
    size_t period = (size_t)llround(60.0 * rate / p->spec.bpm);
    if (period && period * 2 < frames - start) {
      size_t base = frames - period * 2;
      size_t seam = rate / 100;
      if (seam > period / 8)
        seam = period / 8;
      for (size_t frame = base + period; frame < frames; frame++) {
        size_t src = base + (frame - base) % period;
        float blend =
            seam ? (float)fmin(1, (double)(frame - base - period) / seam) : 1;
        for (unsigned c = 0; c < channels; c++) {
          size_t i = frame * channels + c;
          p->k->affine(x + i, x + i, 1 - blend, 0, 1);
          p->k->axpy(x + i, x + src * channels + c, blend, 1);
        }
      }
    }
  } else {
    /* Offline FIR tails. Add from the unmodified lane to avoid unstable
     * feedback and truncate only after the prepared fade reaches zero. */
    float *original = malloc(frames * channels * 4);
    if (!original)
      return -1;
    memcpy(original, x, frames * channels * 4);
    unsigned taps = p->spec.effect == TA_AM_ECHO ? 3 : 6;
    for (unsigned tap = 1; tap <= taps; tap++) {
      double delay = p->spec.effect == TA_AM_ECHO
                         ? 60.0 / p->spec.bpm * tap
                         : 0.037 * tap + 0.011 * tap * tap;
      size_t offset = (size_t)llround(delay * rate);
      if (offset >= frames - start)
        continue;
      float gain =
          p->spec.effect == TA_AM_ECHO ? powf(0.28f, (float)tap) : 0.08f / tap;
      p->k->axpy(x + (start + offset) * channels, original + start * channels,
                 gain, (frames - start - offset) * channels);
    }
    free(original);
  }
  return 0;
}
static void prepare_source_joins(ta_am_prepared *p, unsigned deck,
                                  const float *source, uint64_t origin) {
  float rate = deck ? p->spec.next_rate : p->spec.current_rate;
  if (rate == 1) return;
  uint64_t begin = (deck ? p->spec.next_start : p->spec.current_start) - origin,
           end = (deck ? p->spec.next_end : p->spec.current_end) - origin;
  size_t frames = (size_t)p->spec.output_frames;
  size_t edge = p->spec.binding.sample_rate / 50;
  if (edge > frames / 4) edge = frames / 4;
  if (edge < 2) return;
  unsigned channels = p->spec.binding.channels;
  float curve[7680], reverse[7680];
  // Evaluate the smooth gain window through the same dispatched arithmetic
  // as the other curves. C supplies bounded frame/source geometry only.
  p->k->linear(curve, 0, 1, edge);
  p->k->binary(reverse, curve, curve, edge, 1);
  p->k->affine(curve, curve, -2, 3, edge);
  p->k->binary(curve, curve, reverse, edge, 1);
  p->k->affine(reverse, curve, -1, 1, edge);
  // A phase vocoder can retain a different waveform phase at rate=1. Blend
  // to real decoded source on a short smooth window before/after processing;
  // changing source-time metadata alone cannot remove that audible splice.
  for (unsigned side = 0; side < 2; side++)
    for (size_t i = 0; i < edge; i++) {
      size_t frame = side ? frames - edge + i : i;
      double position = side ? (double)end - (double)(edge - i)
                             : (double)begin + i * (double)rate;
      size_t index = (size_t)floor(position);
      float fraction = (float)(position - index);
      float weight = side ? curve[i] : reverse[i];
      float original[8];
      p->k->affine(original, source + index * channels, 1 - fraction, 0, channels);
      if (fraction)
        p->k->axpy(original, source + (index + 1) * channels, fraction, channels);
      p->k->affine(p->lane[deck] + frame * channels,
          p->lane[deck] + frame * channels, 1 - weight, 0, channels);
      p->k->axpy(p->lane[deck] + frame * channels, original, weight, channels);
    }
}
static int prepare_headroom(ta_am_prepared *p, const ta_am_cancel *cancel) {
  size_t frames = (size_t)p->spec.output_frames;
  unsigned channels = p->spec.binding.channels;
  float *envelope = malloc(frames * sizeof(float));
  if (!envelope) return -1;
  float mix[512 * 8], peaks[512];
  for (size_t frame = 0; frame < frames; frame += 512) {
    if (ta_am_cancelled(cancel)) { free(envelope); return -1; }
    size_t n = frames - frame < 512 ? frames - frame : 512;
    size_t offset = frame * channels;
    ta_am_frame_mix predicted = {mix, p->lane[0] + offset, p->lane[1] + offset,
        p->gain[0] + offset, p->gain[1] + offset, n, channels, channels};
    p->k->mix_frames(&predicted);
    for (size_t i = 0; i < n; i++) {
      double unused;
      p->k->moments(mix + i * channels, channels, &unused, peaks + i);
    }
    p->k->clamp(peaks, peaks, .98f, FLT_MAX, n);
    p->k->linear(envelope + frame, .98f, .98f, n);
    p->k->binary(envelope + frame, envelope + frame, peaks, n, 2);
  }
  p->k->headroom_envelope(envelope, frames, p->spec.binding.sample_rate);
  for (size_t frame = 0; frame < frames; frame++) {
    if (!(frame % 512) && ta_am_cancelled(cancel)) { free(envelope); return -1; }
    for (unsigned deck = 0; deck < 2; deck++)
      p->k->affine(p->gain[deck] + frame * channels,
          p->gain[deck] + frame * channels, envelope[frame], 0, channels);
  }
  free(envelope);
  return 0;
}
ta_am_prepared *ta_am_prepare(const ta_am_plan_spec *s, const float *a,
                              size_t na, uint64_t oa, const float *b, size_t nb,
                              uint64_t ob, const ta_am_kernels *k, char *reason,
                              size_t n) {
  return ta_am_prepare_cancelled(s, a, na, oa, b, nb, ob, k, NULL, reason, n);
}
ta_am_prepared *ta_am_prepare_cancelled(const ta_am_plan_spec *s,
                                        const float *a, size_t na, uint64_t oa,
                                        const float *b, size_t nb, uint64_t ob,
                                        const ta_am_kernels *k,
                                        const ta_am_cancel *cancel,
                                        char *reason, size_t n) {
  if (!ta_am_plan_valid(s, k)) {
    reason_text(reason, n, "invalid_prepare_request");
    return NULL;
  }
  size_t reservation = ta_am_preparation_reserve(s, na, nb);
  if (!reservation) {
    reason_text(reason, n, "preparation_memory_budget");
    return NULL;
  }
  ta_am_prepared *p = ta_am_prepare_reserved(s, a, na, oa, b, nb, ob, k, cancel,
                                             reservation, reason, n);
  ta_am_prepared_release_scratch_budget(p);
  return p;
}
size_t ta_am_preparation_reserve(const ta_am_plan_spec *s, size_t na,
                                 size_t nb) {
  if (!s || s->binding.channels < 1 || s->binding.channels > 8 ||
      s->output_frames > 384000 * 32ull || na > 384000 * 40ull ||
      nb > 384000 * 40ull)
    return 0;
  size_t peak = preparation_peak(s, na, nb);
  return peak <= 128u * 1024 * 1024 && reserve_preparation(peak) ? peak : 0;
}
void ta_am_preparation_abandon(size_t reservation) {
  atomic_fetch_sub_explicit(&preparation_bytes, reservation,
                            memory_order_acq_rel);
}
/* Prepared offline: measured bass exchange is smooth at source boundaries. */
static int bass_handoff(ta_am_prepared* p, const ta_am_cancel* cancel) {
  const ta_am_plan_spec* s = &p->spec;
  float amount = fminf(.85f, fmaxf(0, s->low_clash) * .75f);
  if (s->mode == TA_AM_DJ) amount = fmaxf(amount, .5f);
  if (s->stem_enhanced || amount <= 0 || s->kind != TA_AM_BEAT_ALIGNED) return 0;
  float state[2][8] = {{0}};
  float alpha = 1 - expf(-6.28318530718f * 180 / s->binding.sample_rate);
  for (size_t i = 0; i < s->output_frames; i++) {
    if (!(i & 2047) && ta_am_cancelled(cancel)) return -1;
    double t = (double)i / (s->output_frames - 1);
    double outgoing = t < .5 ? 0 : .5 - .5 * cos(3.14159265359 * (t - .5) * 2);
    for (unsigned d = 0; d < 2; d++) for (unsigned ch = 0; ch < s->binding.channels; ch++) {
      size_t n = i * s->binding.channels + ch;
      float x = p->lane[d][n];
      state[d][ch] += alpha * (x - state[d][ch]);
      double reduction = d ? (t < .5 ? sin(3.14159265359 * t * 2) : 0) : outgoing;
      p->lane[d][n] = x - state[d][ch] * amount * (float)reduction;
    }
  }
  return 0;
}

ta_am_prepared *
ta_am_prepare_reserved(const ta_am_plan_spec *s, const float *a, size_t na,
                       uint64_t oa, const float *b, size_t nb, uint64_t ob,
                       const ta_am_kernels *k, const ta_am_cancel *cancel,
                       size_t reservation, char *reason, size_t n) {
  reason_text(reason, n, "");
  if (!ta_am_plan_valid(s, k) || !a || !b || s->output_frames < 2 ||
      s->binding.channels < 1 || s->binding.channels > 8 ||
      s->output_frames > 384000 * 32ull || na > 384000 * 40ull ||
      nb > 384000 * 40ull || s->current_start < oa || s->next_start < ob ||
      !isfinite(s->current_rate) || !isfinite(s->next_rate) ||
      !isfinite(s->next_gain) || s->next_gain < 0.5f || s->next_gain > 2 ||
      s->effect < TA_AM_CLEAN || s->effect > TA_AM_REPEAT ||
      s->current_rate < 0.88f || s->current_rate > 1.12f ||
      s->next_rate < 0.88f || s->next_rate > 1.12f) {
    reason_text(reason, n, "invalid_prepare_request");
    ta_am_preparation_abandon(reservation);
    return NULL;
  }
  if (ta_am_cancelled(cancel)) {
    reason_text(reason, n, "preparation_cancelled");
    ta_am_preparation_abandon(reservation);
    return NULL;
  }
  size_t samples = (size_t)s->output_frames * s->binding.channels,
         bytes = samples * 4 * 4;
  if (reservation < bytes) {
    reason_text(reason, n, "preparation_memory_budget");
    ta_am_preparation_abandon(reservation);
    return NULL;
  }
  ta_am_prepared *p = calloc(1, sizeof(*p));
  if (!p) {
    ta_am_preparation_abandon(reservation);
    return NULL;
  }
  p->reservation = reservation;
  p->spec = *s;
  p->bytes = bytes;
  p->k = k;
  for (unsigned deck = 0; deck < 2; deck++) {
    p->lane[deck] = malloc(samples * 4);
    p->gain[deck] = malloc(samples * 4);
    if (!p->lane[deck] || !p->gain[deck])
      goto fail;
  }
  ta_am_stretch *stretch =
      ta_am_stretch_create(s->binding.sample_rate, s->binding.channels, k);
  if (!stretch)
    goto fail;
  int failed = ta_am_stretch_render_cancelled(
      stretch, a, na, (double)(s->current_start - oa), s->current_rate, 1,
      p->lane[0], (size_t)s->output_frames, cancel);
  if (failed) reason_text(reason, n, "stretch_current_failed");
  if (!failed) {
    failed = ta_am_stretch_render_cancelled(stretch, b, nb, (double)(s->next_start - ob),
        s->next_rate, 1, p->lane[1], (size_t)s->output_frames, cancel);
    if (failed) reason_text(reason, n, "stretch_next_failed");
  }
  ta_am_stretch_free(stretch);
  if (failed || ta_am_cancelled(cancel)) goto fail;
  if (effects(p)) { reason_text(reason, n, "effect_preparation_failed"); goto fail; }
  if (bass_handoff(p, cancel)) { reason_text(reason, n, "eq_preparation_failed"); goto fail; }
  prepare_source_joins(p, 0, a, oa);
  prepare_source_joins(p, 1, b, ob);
  for (unsigned deck = 0; deck < 2; deck++)
    for (size_t i = 0; i < samples; i++)
      if (!isfinite(p->lane[deck][i])) { reason_text(reason, n, "nonfinite_prepared_pcm"); goto fail; }
  k->crossfade_gain(p->gain[0], p->gain[1], s->next_gain,
                    (size_t)s->output_frames, s->binding.channels);
  if (prepare_headroom(p, cancel)) { reason_text(reason, n, "limiter_preparation_failed"); goto fail; }
  if (ta_am_cancelled(cancel))
    goto fail;
  return p;
fail:
  ta_am_prepared_free(p);
  if (!reason || !n || !reason[0]) reason_text(reason, n,
              ta_am_cancelled(cancel) ? "preparation_cancelled"
                                      : "audio_preparation_failed");
  return NULL;
}
void ta_am_prepared_free(ta_am_prepared *p) {
  if (p) {
    atomic_fetch_sub_explicit(&preparation_bytes, p->reservation,
                              memory_order_acq_rel);
    for (unsigned i = 0; i < 2; i++) {
      free(p->lane[i]);
      free(p->gain[i]);
    }
    free(p);
  }
}
void ta_am_prepared_release_scratch_budget(ta_am_prepared *p) {
  if (p) {
    ta_am_preparation_abandon(p->reservation - p->bytes);
    p->reservation = p->bytes;
  }
}
const ta_am_plan_spec *ta_am_prepared_spec(const ta_am_prepared *p) {
  return p ? &p->spec : NULL;
}
size_t ta_am_prepared_bytes(const ta_am_prepared *p) {
  return p ? p->bytes : 0;
}
uint64_t ta_am_prepared_source_frame(const ta_am_prepared *p, unsigned deck,
                                     double frame) {
  if (!p || deck > 1 || !isfinite(frame))
    return 0;
  return (uint64_t)llround(p->k->source_at(
      (double)(deck ? p->spec.next_start : p->spec.current_start),
      deck ? p->spec.next_rate : p->spec.current_rate, 1,
      (size_t)p->spec.output_frames, frame));
}
const float *ta_am_prepared_lane(const ta_am_prepared *p, unsigned deck) {
  return p && deck < 2 ? p->lane[deck] : NULL;
}
void ta_am_prepared_mix(const ta_am_prepared *p, uint64_t frame, const float *a,
                        const float *b, float *out, size_t frames) {
  if (p)
    ta_am_prepared_mix_routed(p, frame, a, b, out, frames,
                              p->spec.binding.channels);
}
void ta_am_prepared_mix_routed(const ta_am_prepared *p, uint64_t frame,
                               const float *a, const float *b, float *out,
                               size_t frames, unsigned channels) {
  if (!p || !a || !b || !out || frame > p->spec.output_frames ||
      frames > p->spec.output_frames - frame || !channels || channels > 8)
    return;
  size_t offset = (size_t)frame * p->spec.binding.channels;
  ta_am_frame_mix mix = {out,
                         a,
                         b,
                         p->gain[0] + offset,
                         p->gain[1] + offset,
                         frames,
                         channels,
                         p->spec.binding.channels};
  p->k->mix_frames(&mix);
}
