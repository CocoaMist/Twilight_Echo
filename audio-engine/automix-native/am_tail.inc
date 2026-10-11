/* A separate original-speed DJ route, used only after beat routes fail.
 * Sparse RMS/low-band transients are a conservative proxy, not a drum model.
 * Eligibility is conjunctive; score cannot rescue missing/unsafe evidence. */
static int tail_music(const ta_am_features *f, double start, double end) {
  unsigned count = 0, active = 0, musical = 0;
  for (unsigned i = 0; i < f->frame_count; i++) {
    double t = f->start_seconds + i / 50.;
    if (t < start || t >= end) continue;
    count++;
    if (f->frame_db[i] <= -55) continue;
    active++;
    for (unsigned j = 0; j < f->voice_count; j++) {
      if (f->voice_start[j] <= t && f->voice_end[j] > t && f->music[j] >= .1f) {
        musical++; break;
      }
    }
  }
  return count && active * 100 >= count * 85 && musical * 100 >= count * 80;
}
static int tail_sparse(const ta_am_features *f, double start, double end) {
  if (!f->spectral_count) return 0;
  unsigned count = 0, rises = 0, bass_rises = 0;
  for (unsigned i = 1; i < f->frame_count; i++) {
    double t = f->start_seconds + i / 50.;
    if (t < start || t >= end) continue;
    count++;
    rises += f->frame_onset[i] > 3;
    bass_rises += f->frame_low_db[i] - f->frame_low_db[i - 1] > 3;
  }
  return count && rises * 1000 <= count * 25 && bass_rises * 1000 <= count * 40;
}
static int tail_envelope(const ta_am_features *a, const ta_am_features *b,
                         double start, double begin, unsigned seconds,
                         float gain, float entry, float exit,
                         float *ripple_out, float *joint_out) {
  double bins[24] = {0};
  unsigned samples[24] = {0}, joint = 0, count = 0;
  double audible = pow(10, fmax(-55, fmax(entry, exit) - 24) / 10.);
  for (unsigned i = 0; i < a->frame_count; i++) {
    double t = a->start_seconds + i / 50. - start;
    if (t < 0 || t >= seconds) continue;
    // Analysis owns 20ms cells, not arbitrary sample-accurate boundaries.
    long bi = (long)floor((begin + t - b->start_seconds) * 50 + 1e-7);
    if (bi < 0 || bi >= (long)b->frame_count) return 0;
    double p = fmin(1, (t + .01) / seconds);
    double ga = cos(p * 1.5707963267948966);
    double gb = sin(p * 1.5707963267948966) * (gain + (1 - gain) * p);
    double ax = pow(10, a->frame_db[i] / 10.) * ga * ga;
    double by = pow(10, b->frame_db[bi] / 10.) * gb * gb;
    unsigned bin = (unsigned)t;
    bins[bin] += ax + by; samples[bin]++; count++;
    joint += ax >= audible && by >= audible;
  }
  if (count < seconds * 50 - 1 || joint * 2 < count) return 0;
  float ripple = 0;
  for (unsigned i = 0; i < seconds; i++) {
    if (!samples[i]) return 0;
    double mixed = 10 * log10(fmax(bins[i] / samples[i], 1e-16));
    double expected = entry + (exit - entry) * i / (seconds - 1.);
    ripple = fmaxf(ripple, (float)fabs(mixed - expected));
  }
  // Quantize before candidate comparisons, like regional energy decisions.
  *ripple_out = roundf(ripple * 100) / 100;
  *joint_out = (float)joint / 50;
  return *ripple_out <= 5;
}
static int select_tail_overlap(const ta_am_features *a, const ta_am_features *b,
                               const ta_am_binding *bind, const ta_am_kernels *k,
                               uint64_t minimum_start, ta_am_plan_spec *out) {
  if (!a->spectral_count || !b->spectral_count) return 0;
  double end = fmin(a->duration_seconds, a->end_seconds) - silence_boundary(a, 0);
  double begin = silence_boundary(b, 1), starts[33] = {begin};
  double earliest = fmax(fmax(a->start_seconds, fmax(20, a->duration_seconds * .2)),
      a->duration_seconds - fmin(60, a->duration_seconds * .25));
  double max_entry = fmin(20, b->duration_seconds * .25);
  unsigned ns = 1;
  for (unsigned i = 0; i < b->downbeat_count && ns < 33; i++) {
    double t = b->downbeats[i];
    float skipped = ta_am_voice_between(b, begin, t, 0);
    if (t > begin + .1 && t <= max_entry && skipped >= 0 && skipped <= .08f && cut_safe(b, t))
      starts[ns++] = t;
  }
  float best = -FLT_MAX;
  for (unsigned seconds = 16; seconds <= 24; seconds += 4) {
    double start = end - seconds;
    if (start < earliest || start * bind->sample_rate < minimum_start) continue;
    float av = ta_am_voice_between(a, start, end, 0);
    float late = ta_am_voice_between(a, start + seconds * .5, end, 0);
    float entry = region_energy(a, start, start + 1, k, 0);
    float decay = entry - region_energy(a, end - 1, end, k, 0);
    if (av < 0 || late < 0 || late > .08f || entry <= -50 || decay < 6 ||
        !tail_music(a, start, end)) continue;
    int sparse_a = tail_sparse(a, start + seconds * .25, start + seconds * .75);
    for (unsigned s = 0; s < ns; s++) {
      double finish = starts[s] + seconds;
      if (finish > b->end_seconds) continue;
      float bv = ta_am_voice_between(b, starts[s], finish, 0);
      float early = ta_am_voice_between(b, starts[s], starts[s] + seconds * .5, 0);
      float exit = region_energy(b, finish - 1, finish, k, 0);
      if (bv < 0 || early < 0 || early > .08f || exit <= -50 || fabsf(entry - exit) > 12 ||
          !tail_music(b, starts[s], finish) || (!sparse_a &&
          !tail_sparse(b, starts[s] + seconds * .25, starts[s] + seconds * .75))) continue;
      float adb = region_rms(a, start, end, k), bdb = region_rms(b, starts[s], finish, k);
      float gain = fmaxf(.5f, fminf(2, powf(10, (adb - bdb) / 20)));
      float ripple, joint;
      if (!tail_envelope(a, b, start, starts[s], seconds, gain, entry, exit, &ripple, &joint)) continue;
      // Duration alone is no reward: audible overlap and envelope continuity
      // compete with vocal activity and skipped instrumental content.
      float score = 2 - ripple * .2f + joint * .025f - (av + bv) * 2 -
          (float)(starts[s] - begin) * .04f - fabsf(entry - exit) * .02f;
      if (score <= best) continue;
      ta_am_plan_spec spec = {0};
      spec.binding = *bind; spec.mode = TA_AM_DJ; spec.kind = TA_AM_TAIL_OVERLAP;
      spec.current_rate = spec.next_rate = 1; spec.next_gain = gain; spec.score = score;
      spec.vocal_clash = fminf(av, bv);
      spec.output_frames = (uint64_t)seconds * bind->sample_rate;
      spec.current_start = (uint64_t)llround(start * bind->sample_rate);
      spec.current_end = spec.current_start + spec.output_frames;
      spec.next_start = (uint64_t)llround(starts[s] * bind->sample_rate);
      spec.next_end = spec.next_start + spec.output_frames;
      size_t context = (size_t)spec.output_frames + bind->sample_rate * 4;
      if (spec.current_start < minimum_start ||
          spec.current_end > (uint64_t)llround(end * bind->sample_rate) ||
          spec.next_end > (uint64_t)llround(b->end_seconds * bind->sample_rate) ||
          preparation_peak(&spec, context, context) > 128u * 1024 * 1024 ||
          !ta_am_plan_valid(&spec, k)) continue;
      *out = spec; best = score;
    }
  }
  return best > -FLT_MAX;
}
