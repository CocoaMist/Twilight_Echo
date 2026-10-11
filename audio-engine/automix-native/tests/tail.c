#include "am_plan.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static void require(int ok, const char *message) {
  if (!ok) { fprintf(stderr, "FAIL: %s\n", message); exit(1); }
}
static void fixture(ta_am_features *f, int tail) {
  memset(f, 0, sizeof(*f));
  f->start_seconds = tail ? 240 : 0; f->end_seconds = tail ? 300 : 60;
  f->duration_seconds = 300; f->rms_db = -12; f->peak = .4f; f->key = -1;
  f->frame_count = f->spectral_count = 3000;
  f->voice_count = 1; f->voice_start[0] = f->start_seconds; f->voice_end[0] = f->end_seconds;
  f->voice[0] = .001f; f->music[0] = .9f;
  for (unsigned i = 0; i < f->frame_count; i++) {
    double t = i / 50.;
    f->frame_db[i] = (float)(-12 - (tail && t > 54 ? (t - 54) * 3 : 0));
    f->frame_peak[i] = .4f; f->frame_low_db[i] = f->frame_db[i] - 8;
    f->frame_onset[i] = tail ? 8 : 0;
  }
}
static int select_plan(ta_am_features *a, ta_am_features *b, const ta_am_binding *bind,
                       const ta_am_kernels *k, uint64_t earliest, ta_am_plan_spec *spec) {
  char reason[128];
  return ta_am_select_after(a, b, TA_AM_DJ, bind, k, earliest, spec, reason, sizeof(reason));
}
int main(void) {
  ta_am_features *a = malloc(sizeof(*a)), *b = malloc(sizeof(*b));
  require(a && b, "allocate bounded analysis"); fixture(a, 1); fixture(b, 0);
  ta_am_binding bind = {0}; bind.sample_rate = 8000; bind.channels = 2;
  memset(bind.current_identity, 'a', 64); memset(bind.next_identity, 'b', 64);
  ta_am_plan_spec spec, reference;
  const ta_am_kernels *k = ta_am_get_kernels(TA_AM_C);
  require(ta_am_features_valid(a) && ta_am_features_valid(b), "valid tail evidence");
  for (int cpu = TA_AM_C; cpu <= TA_AM_AVX2; cpu++) {
    const ta_am_kernels *cpu_k = ta_am_get_kernels((ta_am_cpu)cpu); if (!cpu_k) continue;
    require(select_plan(a, b, &bind, cpu_k, 0, &spec) == 1 && spec.kind == TA_AM_TAIL_OVERLAP,
        "known instrumental decay can overlap sparse incoming music without a beat grid");
    require(spec.bpm == 0 && spec.confidence == 0 && spec.current_rate == 1 && spec.next_rate == 1 &&
        spec.effect == TA_AM_CLEAN && spec.current_end == 300 * 8000 && spec.next_start == 0,
        "tail route preserves source speed and complete outgoing music");
    if (cpu == TA_AM_C) reference = spec;
    else require(!memcmp(&reference, &spec, sizeof(spec)), "C SSE2 AVX2 select identical tail tickets");
  }
  spec = reference; spec.mode = TA_AM_NATURAL;
  require(!ta_am_plan_valid(&spec, k), "long tail never admitted into Natural");
  spec = reference; spec.bpm = 120;
  require(!ta_am_plan_valid(&spec, k), "tail ticket cannot claim beat tempo");
  spec = reference; spec.kind = TA_AM_CONTENT_BOUNDARY;
  require(!ta_am_plan_valid(&spec, k), "short route cannot disguise a long overlap");
  require(select_plan(a, b, &bind, k, 293 * 8000, &spec) == 1 && spec.kind == TA_AM_CONTENT_BOUNDARY &&
      spec.current_start >= 293 * 8000, "late preparation falls back to a still-safe short route");
  b->voice_count = 0;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "unknown voice never proves an instrumental handoff");
  fixture(b, 0); b->music[0] = 0;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "silent parent-class evidence cannot be rescued by score");
  fixture(b, 0); b->spectral_count = 0;
  require(select_plan(a, b, &bind, k, 0, &spec) == 1 && spec.kind != TA_AM_TAIL_OVERLAP,
      "unknown spectral evidence retains the short fallback");
  fixture(b, 0);
  for (unsigned i = 0; i < b->frame_count; i++) b->frame_onset[i] = 8;
  require(select_plan(a, b, &bind, k, 0, &spec) == 1 && spec.kind != TA_AM_TAIL_OVERLAP,
      "two dense transient layers cannot use the unaligned long route");
  fixture(b, 0);
  for (unsigned i = 0; i < b->frame_count; i++) b->frame_low_db[i] = i % 2 ? -10 : -25;
  require(select_plan(a, b, &bind, k, 0, &spec) == 1 && spec.kind != TA_AM_TAIL_OVERLAP,
      "low-band pulses veto a falsely smooth full-band envelope");
  fixture(b, 0); b->voice[0] = .6f;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "early incoming words cannot be hidden in long overlap");
  fixture(b, 0); b->voice_count = 2;
  b->voice_end[0] = 8; b->voice[0] = .6f;
  b->voice_start[1] = 8; b->voice_end[1] = 60; b->voice[1] = .001f; b->music[1] = .9f;
  b->downbeat_count = 3; b->downbeats[0] = 9; b->downbeats[1] = 12; b->downbeats[2] = 16;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "safe entry cannot justify skipping an earlier vocal introduction");
  fixture(b, 0); b->voice_count = 2;
  b->voice_end[0] = 5; b->voice_start[1] = 6; b->voice_end[1] = 60;
  b->voice[1] = .001f; b->music[1] = .9f;
  require(ta_am_voice_between(b, 0, 16, 0) < 0 &&
      (select_plan(a, b, &bind, k, 0, &spec) != 1 || spec.kind != TA_AM_TAIL_OVERLAP),
      "one-second model coverage hole cannot qualify a long route; known short evidence remains usable");
  fixture(b, 0);
  for (unsigned i = 0; i < 850; i++) b->frame_db[i] = -90;
  require(select_plan(a, b, &bind, k, 0, &spec) != 1 || spec.kind != TA_AM_TAIL_OVERLAP,
      "padding and late music do not count as a long audible overlap");
  fixture(b, 0);
  for (unsigned i = 400; i < 600; i++) b->frame_db[i] = -75;
  require(select_plan(a, b, &bind, k, 0, &spec) != 1 || spec.kind != TA_AM_TAIL_OVERLAP,
      "a central energy hole fails envelope continuity");
  fixture(b, 0); bind.sample_rate = 192000; bind.channels = 8;
  require(select_plan(a, b, &bind, k, 0, &spec) != 1 || spec.kind != TA_AM_TAIL_OVERLAP,
      "full source and DSP reservation, not output alone, bounds long route memory");
  bind.sample_rate = 8000; bind.channels = 2;
  spec = reference;
  size_t frames = (size_t)spec.output_frames, count = frames * bind.channels;
  float *x = malloc(count * sizeof(float)), *y = malloc(count * sizeof(float)), *mix = malloc(count * sizeof(float));
  require(x && y && mix, "render buffers");
  for (size_t i = 0; i < count; i++) { x[i] = .15f * sinf((float)i * .07f); y[i] = .1f * cosf((float)i * .13f); }
  char reason[128];
  for (int cpu = TA_AM_C; cpu <= TA_AM_AVX2; cpu++) {
    const ta_am_kernels *cpu_k = ta_am_get_kernels((ta_am_cpu)cpu); if (!cpu_k) continue;
    ta_am_prepared *p = ta_am_prepare(&spec, x, frames, spec.current_start, y, frames, spec.next_start, cpu_k, reason, sizeof(reason));
    require(p != NULL, reason);
    ta_am_prepared_mix(p, 0, ta_am_prepared_lane(p, 0), ta_am_prepared_lane(p, 1), mix, frames);
    for (size_t i = 0; i < count; i++) require(isfinite(mix[i]) && fabsf(mix[i]) < 1, "finite limited PCM");
    require(fabsf(mix[0] - x[0]) < 1e-6f && fabsf(mix[count - 1] - y[count - 1]) < 1e-6f,
        "tail lane endpoints join the unchanged outgoing and incoming PCM");
    ta_am_prepared_free(p);
  }
  free(x); free(y); free(mix); free(a); free(b);
  puts("tail eligibility and rendering passed"); return 0;
}
