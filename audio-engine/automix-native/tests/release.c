#include "am_plan.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static void require(int ok, const char *message) {
  if (!ok) { fprintf(stderr, "FAIL: %s\n", message); exit(1); }
}
static void fixture(ta_am_features *f, int outgoing) {
  memset(f, 0, sizeof(*f));
  f->start_seconds = outgoing ? 270 : 0; f->end_seconds = outgoing ? 300 : 30;
  f->duration_seconds = 300; f->rms_db = -20; f->peak = .4f; f->key = -1;
  f->frame_count = f->spectral_count = 1500;
  f->voice_count = outgoing ? 2 : 1;
  f->voice_start[0] = f->start_seconds; f->voice_end[0] = outgoing ? 291 : 30;
  f->voice[0] = .001f; f->music[0] = .9f;
  if (outgoing) {
    f->voice_start[1] = 291; f->voice_end[1] = 300; f->voice[1] = .001f;
  }
  for (unsigned i = 0; i < f->frame_count; i++) {
    double t = i / 50.;
    f->frame_db[i] = outgoing ? (float)(-12 - fmax(0, t - 21) * 4) : -20;
    f->frame_peak[i] = .4f; f->frame_low_db[i] = f->frame_db[i] - 8;
  }
}
static int select_plan(ta_am_features *a, ta_am_features *b, const ta_am_binding *bind,
                       const ta_am_kernels *k, uint64_t earliest, ta_am_plan_spec *spec) {
  char reason[128];
  return ta_am_select_after(a, b, TA_AM_NATURAL, bind, k, earliest, spec, reason, sizeof(reason));
}
int main(void) {
  ta_am_features *a = malloc(sizeof(*a)), *b = malloc(sizeof(*b));
  require(a && b, "allocate bounded features"); fixture(a, 1); fixture(b, 0);
  ta_am_binding bind = {0}; bind.sample_rate = 8000; bind.channels = 2;
  memset(bind.current_identity, 'a', 64); memset(bind.next_identity, 'b', 64);
  ta_am_plan_spec spec, reference;
  const ta_am_kernels *k = ta_am_get_kernels(TA_AM_C);
  for (int cpu = TA_AM_C; cpu <= TA_AM_AVX2; cpu++) {
    const ta_am_kernels *cpu_k = ta_am_get_kernels((ta_am_cpu)cpu); if (!cpu_k) continue;
    require(select_plan(a, b, &bind, cpu_k, 0, &spec) == 1 && spec.kind == TA_AM_RELEASE_BOUNDARY,
        "local positive music and a continuous unlabeled decay permit a short handoff");
    require(spec.bpm == 0 && spec.confidence == 0 && spec.current_rate == 1 && spec.next_rate == 1 &&
        spec.effect == TA_AM_CLEAN && spec.current_end == 300 * 8000 && spec.next_start == 0 &&
        spec.output_frames <= 8 * 8000 && ta_am_plan_valid(&spec, cpu_k),
        "release preserves original speed, song ending and incoming introduction");
    if (cpu == TA_AM_C) reference = spec;
    else require(!memcmp(&reference, &spec, sizeof(spec)), "C SSE2 AVX2 choose identical release tickets");
  }
  spec = reference; spec.mode = TA_AM_DJ;
  require(ta_am_plan_valid(&spec, k), "short release is also a valid DJ fallback");
  char reason[128];
  require(ta_am_select_after(a, b, TA_AM_DJ, &bind, k, 0, &spec, reason, sizeof(reason)) == 1 &&
      spec.kind == TA_AM_RELEASE_BOUNDARY, "DJ selects release after other routes fail");
  spec = reference; spec.bpm = 120;
  require(!ta_am_plan_valid(&spec, k), "release cannot claim beat evidence");
  spec = reference; spec.output_frames = 9 * 8000; spec.current_end = spec.current_start + spec.output_frames;
  spec.next_end = spec.next_start + spec.output_frames; spec.mode = TA_AM_DJ;
  require(!ta_am_plan_valid(&spec, k), "DJ cannot turn release into a long mix");
  require(select_plan(a, b, &bind, k, 299 * 8000, &spec) == 0, "missed boundary never rewinds playback");
  a->voice_count = 0;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "unknown voice is not quiet voice");
  fixture(a, 1); a->music[0] = 0;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "no positive musical origin keeps fallback");
  fixture(a, 1); a->voice_end[0] = 280; a->voice_start[1] = 280;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "remote music label cannot authorize a later sound");
  fixture(a, 1); a->voice_end[0] = 290;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "model coverage hole breaks contextual provenance");
  fixture(a, 1); a->voice[0] = .2f;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "preceding words cannot be relabeled instrumental release");
  fixture(a, 1); a->voice[1] = .2f;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "late outgoing words retain protection");
  fixture(a, 1); a->spectral_count = 0;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "missing low-band evidence retains fallback");
  fixture(a, 1);
  for (unsigned i = 0; i < a->frame_count; i++) a->frame_onset[i] = 8;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "dense outgoing attacks are not an unaligned release");
  fixture(a, 1);
  for (unsigned i = 1250; i < 1300; i++) a->frame_db[i] = -100;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "full-band reentry after a hole is not continuous decay");
  fixture(a, 1);
  for (unsigned i = 1250; i < 1300; i++) a->frame_low_db[i] = -100;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "bass reentry vetoes a smooth full-band tail");
  fixture(a, 1);
  for (unsigned i = 1050; i < a->frame_count; i++) a->frame_db[i] = -70;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "inaudible padding cannot raise success counts");
  fixture(a, 1); b->music[0] = 0;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "incoming positive music is still required");
  fixture(b, 0); b->voice[0] = .2f;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "early incoming words retain protection");
  fixture(b, 0);
  for (unsigned i = 0; i < 225; i++) b->frame_db[i] = -100;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "mixed envelope hole cannot be rescued by positive labels");
  fixture(b, 0); bind.sample_rate = 384000; bind.channels = 8;
  require(select_plan(a, b, &bind, k, 0, &spec) == 0, "complete preparation peak remains bounded to 128MiB");
  free(a); free(b); puts("contextual release eligibility passed"); return 0;
}
