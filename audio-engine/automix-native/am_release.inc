/* A short original-speed handoff for a continuous musical release whose
 * quiet tail has lost the model's music label. Positive context is bounded;
 * unknown coverage, a rebuild or an inaudible fade cannot be rescued by score. */
static int release_continuous(const ta_am_features *f, double start, double end,
                              const ta_am_kernels *k) {
  float full = region_energy(f, start, start + .5, k, 0), low = -160;
  for (unsigned i = 0; i < f->frame_count; i++) {
    double t = f->start_seconds + i / 50.;
    if (t >= start && t < start + .5) low = fmaxf(low, f->frame_low_db[i]);
  }
  for (double s = start + .5; s < end - .001; s += .5) {
    double finish = fmin(end, s + .5);
    float db = region_energy(f, s, finish, k, 0), bass = -160;
    for (unsigned i = 0; i < f->frame_count; i++) {
      double t = f->start_seconds + i / 50.;
      if (t >= s && t < finish) bass = fmaxf(bass, f->frame_low_db[i]);
    }
    if (db > full + 3 || bass > low + 4) return 0;
    full = db; low = bass;
  }
  return 1;
}
static int release_context(const ta_am_features *f, double start, double end,
                           const ta_am_kernels *k) {
  // Search only the preceding eight seconds, nearest witness first. A music
  // label elsewhere in the track does not establish the origin of this tail.
  for (double distance = 1; distance <= 8; distance += .5) {
    double witness = start - distance;
    if (witness < f->start_seconds) break;
    float voice = ta_am_voice_between(f, witness, start, 0);
    if (voice < 0 || voice > .08f || !music_witness(f, witness, witness + 1) ||
        region_energy(f, witness, witness + 1, k, 0) <= -40) continue;
    if (release_continuous(f, witness, end, k)) return 1;
  }
  return 0;
}
static int select_release_boundary(const ta_am_features *a, const ta_am_features *b,
                                   ta_am_mode mode, const ta_am_binding *bind,
                                   const ta_am_kernels *k, uint64_t minimum_start,
                                   ta_am_plan_spec *out) {
  if (!a->spectral_count || !b->spectral_count) return 0;
  double end = fmin(a->duration_seconds, a->end_seconds) - silence_boundary(a, 0);
  double begin = silence_boundary(b, 1);
  float best = -FLT_MAX;
  for (unsigned seconds = 2; seconds <= 8; seconds++) {
    double start = end - seconds, finish = begin + seconds;
    if (start < a->start_seconds || finish > b->end_seconds ||
        start * bind->sample_rate < minimum_start) continue;
    float av = ta_am_voice_between(a, start, end, 0),
          bv = ta_am_voice_between(b, begin, finish, 0),
          late = ta_am_voice_between(a, start + seconds * .5, end, 0),
          early = ta_am_voice_between(b, begin, begin + seconds * .5, 0);
    if (av < 0 || bv < 0 || late < 0 || early < 0 || late > .08f || early > .08f ||
        !music_witness(b, begin, finish) ||
        !tail_sparse(a, start + seconds * .25, start + seconds * .75)) continue;
    float entry = region_energy(a, start, start + 1, k, 0),
          exit = region_energy(b, finish - 1, finish, k, 0),
          decay = entry - region_energy(a, end - 1, end, k, 0);
    if (entry <= -40 || exit <= -50 || decay < 12 || fabsf(entry - exit) > 12 ||
        !release_context(a, start, end, k)) continue;
    float adb = region_rms(a, start, end, k), bdb = region_rms(b, begin, finish, k);
    float gain = fmaxf(.5f, fminf(2, powf(10, (adb - bdb) / 20)));
    float ripple, joint;
    // One second of actual overlap supports a short release handoff. This
    // never counts as the long route, which requires half its span audible.
    if (!unaligned_envelope(a, b, start, begin, seconds, gain, entry, exit, 1, &ripple, &joint)) continue;
    float score = 2 - ripple * .2f + joint * .025f - (av + bv) * 2 -
        fabsf(entry - exit) * .02f - (float)fabs((double)seconds - 6) * .05f;
    if (score <= best) continue;
    ta_am_plan_spec spec = {0};
    spec.binding = *bind; spec.mode = mode; spec.kind = TA_AM_RELEASE_BOUNDARY;
    spec.current_rate = spec.next_rate = 1; spec.next_gain = gain; spec.score = score;
    spec.vocal_clash = fminf(av, bv);
    spec.output_frames = (uint64_t)seconds * bind->sample_rate;
    spec.current_start = (uint64_t)llround(start * bind->sample_rate);
    spec.current_end = spec.current_start + spec.output_frames;
    spec.next_start = (uint64_t)llround(begin * bind->sample_rate);
    spec.next_end = spec.next_start + spec.output_frames;
    size_t context = (size_t)spec.output_frames + bind->sample_rate * 4;
    if (spec.current_end > (uint64_t)llround(end * bind->sample_rate) ||
        spec.next_end > (uint64_t)llround(finish * bind->sample_rate) ||
        preparation_peak(&spec, context, context) > 128u * 1024 * 1024 ||
        !ta_am_plan_valid(&spec, k)) continue;
    *out = spec; best = score;
  }
  return best > -FLT_MAX;
}
