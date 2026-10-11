/* Bounded phrase search. Only verified, contiguous analysis enters this view. */
static int cut_safe(const ta_am_features *f, double time) {
  double s = fmax(f->start_seconds, time - .5), e = fmin(f->end_seconds, time + .5);
  float voice = ta_am_voice_between(f, s, e, 1);
  return e > s && voice >= 0 && voice <= .08f;
}
static float low_fraction(const ta_am_features *f, double start, double end) {
  if (!f->spectral_count) return -1;
  double sum = 0; unsigned count = 0;
  for (unsigned i = 0; i < f->frame_count; i++) {
    double t = f->start_seconds + i / 50.;
    if (t >= start && t < end && f->frame_db[i] > -55) {
      sum += fmin(1, pow(10, (f->frame_low_db[i] - f->frame_db[i]) / 10.));
      count++;
    }
  }
  return count ? (float)(sum / count) : -1;
}
static float onset_density(const ta_am_features *f, double start, double end) {
  if (!f->spectral_count) return 0;
  unsigned count = 0, active = 0;
  for (unsigned i = 0; i < f->frame_count; i++) {
    double t = f->start_seconds + i / 50.;
    if (t >= start && t < end) { count++; active += f->frame_onset[i] > 3; }
  }
  return count ? (float)active / count : 0;
}
static int select_dj_phrases(const ta_am_features *a, const ta_am_features *b,
                             const ta_am_binding *bind, const ta_am_kernels *k,
                             uint64_t minimum_start, ta_am_plan_spec *out) {
  if (a->downbeat_count < 2 || b->downbeat_count < 2) return 0;
  double end = fmin(a->duration_seconds, a->end_seconds) - silence_boundary(a, 0);
  double begin = silence_boundary(b, 1), ends[65] = {end}, starts[33] = {begin};
  unsigned ne = 1, ns = 1, evaluated = 0;
  double earliest = fmax(fmax(20, a->duration_seconds * .2),
      a->duration_seconds - fmin(60, a->duration_seconds * .25));
  double max_entry = fmin(20, b->duration_seconds * .25);
  for (unsigned i = a->downbeat_count; i > 0 && ne < 65; i--) {
    double t = a->downbeats[i - 1];
    if (t >= earliest && t <= end - .5 && cut_safe(a, t)) ends[ne++] = t;
  }
  for (unsigned i = 0; i < b->downbeat_count && ns < 33; i++) {
    double t = b->downbeats[i];
    if (t > begin + .1 && t <= max_entry && cut_safe(b, t)) starts[ns++] = t;
  }
  float best = -FLT_MAX;
  for (unsigned e = 0; e < ne; e++) {
    ta_am_rhythm ra;
    if (!ta_am_rhythm_region(a, fmax(a->start_seconds, ends[e] - 38), ends[e], k, &ra)) continue;
    for (unsigned s = 0; s < ns; s++) {
      ta_am_rhythm rb;
      if (!ta_am_rhythm_region(b, starts[s], fmin(b->end_seconds, starts[s] + 38), k, &rb)) continue;
      for (unsigned fold = 0; fold < 3; fold++) {
        float folded = rb.bpm * (fold == 0 ? 1 : fold == 1 ? .5f : 2);
        if (folded < 55 || folded > 300) continue;
        float ar, br;
        if (!tempo_rates(ra.bpm, folded, .12f, &ar, &br)) continue;
        float confidence = fminf(ra.confidence, rb.confidence);
        double first_b = -1;
        for (unsigned i = 0; i < b->downbeat_count; i++)
          if (b->downbeats[i] >= starts[s] && b->downbeats[i] >= rb.first && b->downbeats[i] <= rb.last) { first_b = b->downbeats[i]; break; }
        if (first_b < 0) continue;
        for (unsigned bars = 16; bars >= 4; bars -= 4) {
          double target = bars * 4 * 60. / (ra.bpm * ar);
          if (target < 4 || target > 32.02 || (target > 16 && confidence < .65f)) continue;
          double initial_start = ends[e] - target * (.9 * ar + .1);
          for (unsigned beat = 0; beat < a->downbeat_count; beat++) {
            double at = a->downbeats[beat];
            if (at < initial_start - 2 || at > initial_start + 2 || at < ra.first || at > ra.last) continue;
            if (++evaluated > 20000) goto finished;
            double shift = (first_b - starts[s]) / br - (at - initial_start) / ar;
            double seconds = target + shift * ar / (.9 * ar + .1);
            double start = ends[e] - seconds * (.9 * ar + .1);
            double b_end = starts[s] + seconds * (.9 * br + .1);
            if (seconds < 4 || seconds > 32 || start < a->start_seconds || start < fmax(20, a->duration_seconds * .2) ||
                start * bind->sample_rate < minimum_start || at < start || (at - start) / ar > seconds * .5 ||
                (first_b - starts[s]) / br > seconds * .5 || b_end > b->end_seconds) continue;
            float av = ta_am_voice_between(a, start, ends[e], 0), bv = ta_am_voice_between(b, starts[s], b_end, 0);
            float conflict = av < 0 || bv < 0 ? 1 : fminf(av, bv);
            float adb = region_rms(a, start, ends[e], k), bdb = region_rms(b, starts[s], b_end, k);
            float al = low_fraction(a, start, ends[e]), bl = low_fraction(b, starts[s], b_end);
            float low = al < 0 || bl < 0 ? 0 : fminf(1, sqrtf(al * bl) * 3);
            float a_slope = region_energy(a, ends[e] - 1, ends[e], k, 0) - region_energy(a, start, start + 1, k, 0);
            float b_slope = region_energy(b, b_end - 1, b_end, k, 0) - region_energy(b, starts[s], starts[s] + 1, k, 0);
            float score = confidence * 3 - conflict * 2 - fabsf(ar - 1) * 5 - fabsf(br - 1) * 5 +
                (float)seconds * .028f - fminf(fabsf(adb - bdb), 12) * .025f - low * .1f - fold * .03f -
                (float)((end - ends[e]) + starts[s]) * .003f -
                fabsf(onset_density(a, start, ends[e]) - onset_density(b, starts[s], b_end)) * .25f;
            score += fmaxf(-12, fminf(12, -a_slope)) * .015f + fmaxf(-12, fminf(12, b_slope)) * .01f;
            if (a->key >= 0 && b->key >= 0 && a->key_confidence >= .6f && b->key_confidence >= .6f) {
              int distance = abs(a->key % 12 - b->key % 12);
              if (distance && distance != 5 && distance != 7) score -= .15f;
            }
            if (score <= best) continue;
            ta_am_plan_spec spec = {0}; spec.binding = *bind; spec.mode = TA_AM_DJ;
            spec.current_rate = ar; spec.next_rate = br; spec.bpm = ra.bpm * ar; spec.confidence = confidence;
            spec.score = score; spec.low_clash = low; spec.vocal_clash = conflict;
            spec.next_gain = fmaxf(.5f, fminf(2, powf(10, (adb - bdb) / 20)));
            spec.output_frames = (uint64_t)llround(seconds * bind->sample_rate);
            spec.current_start = (uint64_t)llround(start * bind->sample_rate);
            uint64_t end_frame = (uint64_t)llround(ends[e] * bind->sample_rate);
            while (spec.output_frames > 2 && k->source_at((double)spec.current_start, ar, 1,
                    (size_t)spec.output_frames, (double)spec.output_frames) > end_frame) spec.output_frames--;
            spec.current_end = (uint64_t)llround(k->source_at((double)spec.current_start, ar, 1,
                (size_t)spec.output_frames, (double)spec.output_frames));
            spec.next_start = (uint64_t)llround(starts[s] * bind->sample_rate);
            spec.next_end = (uint64_t)llround(k->source_at((double)spec.next_start, br, 1,
                (size_t)spec.output_frames, (double)spec.output_frames));
            if (spec.next_end > (uint64_t)llround(b->end_seconds * bind->sample_rate) ||
                spec.current_start < minimum_start || spec.output_frames * bind->channels * 16 > 128u * 1024 * 1024) continue;
            float va = ta_am_voice_between(a, start, ends[e], 1), vb = ta_am_voice_between(b, starts[s], b_end, 1);
            if (va >= 0 && vb >= 0 && va < .03f && vb < .03f)
              spec.effect = confidence > .92f && spec.bpm > 150 ? TA_AM_REPEAT :
                a->key >= 0 && b->key >= 0 && a->key % 12 == b->key % 12 ? TA_AM_REVERB :
                fabsf(adb - bdb) > 5 ? TA_AM_FILTER : TA_AM_ECHO;
            size_t na = (size_t)(spec.current_end - spec.current_start + bind->sample_rate * 4);
            size_t nb = (size_t)(spec.next_end - spec.next_start + bind->sample_rate * 4);
            size_t peak = preparation_peak(&spec, na, nb);
            if (peak > 128u * 1024 * 1024 || !ta_am_plan_valid(&spec, k)) continue;
            *out = spec; best = score;
          }
        }
      }
    }
  }
finished:
  return best > -FLT_MAX;
}
int ta_am_select_after(const ta_am_features *a, const ta_am_features *b,
                       ta_am_mode mode, const ta_am_binding *bind,
                       const ta_am_kernels *k, uint64_t minimum_start,
                       ta_am_plan_spec *out, char *reason, size_t n) {
  int valid = out && bind && k && ta_am_features_valid(a) && ta_am_features_valid(b) &&
      bind->sample_rate >= 8000 && bind->sample_rate <= 384000 && bind->channels > 0 && bind->channels <= 8 &&
      identity_valid(bind->current_identity) && identity_valid(bind->next_identity);
  if (valid && mode == TA_AM_DJ && a->end_seconds >= a->duration_seconds - .021 && b->start_seconds <= .001 &&
      a->duration_seconds >= 12 && b->duration_seconds >= 12 && a->peak >= .0001f && b->peak >= .0001f &&
      select_dj_phrases(a, b, bind, k, minimum_start, out)) {
    reason_text(reason, n, ""); return 1;
  }
  int result = select_boundary(a, b, mode, bind, k, out, minimum_start, reason, n);
  if (result == 0 && valid && mode == TA_AM_DJ && a->end_seconds >= a->duration_seconds - .021 && b->start_seconds <= .001 &&
      content_boundary(a, b, bind, k, fmin(a->duration_seconds, a->end_seconds) - silence_boundary(a, 0),
        silence_boundary(b, 1), minimum_start, out)) {
    out->mode = TA_AM_DJ; reason_text(reason, n, ""); result = 1;
  }
  if (result == 1 && out->current_start < minimum_start) {
    reason_text(reason, n, "preparation_missed_boundary"); return 0;
  }
  if (result == 1 && a->spectral_count && b->spectral_count) {
    float al = low_fraction(a, (double)out->current_start / bind->sample_rate, (double)out->current_end / bind->sample_rate);
    float bl = low_fraction(b, (double)out->next_start / bind->sample_rate, (double)out->next_end / bind->sample_rate);
    if (al >= 0 && bl >= 0) out->low_clash = fminf(1, sqrtf(al * bl) * 3);
  }
  return result;
}
int ta_am_select_with_kernels(const ta_am_features *a, const ta_am_features *b,
                              ta_am_mode mode, const ta_am_binding *bind,
                              const ta_am_kernels *k, ta_am_plan_spec *out,
                              char *reason, size_t n) {
  return ta_am_select_after(a, b, mode, bind, k, 0, out, reason, n);
}
