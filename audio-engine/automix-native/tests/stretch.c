#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "am_events.h"
#include "am_stretch.h"
static void require(int ok, const char *label) {
  if (!ok) {
    fprintf(stderr, "FAIL %s\n", label);
    exit(1);
  }
}
int main(void) {
  const unsigned rate = 8000, channels = 2;
  const size_t source_frames = 24000, frames = 8000;
  float *source = malloc(source_frames * channels * 4), *ref = malloc(frames * channels * 4),
        *actual = malloc(frames * channels * 4);
  require(source && ref && actual, "allocate");
  for (size_t i = 0; i < source_frames; i++) {
    source[2 * i] = 0.4f * (float)sin(6.2831853071795864769 * 440 * i / rate);
    source[2 * i + 1] = -source[2 * i];
  }
  ta_am_stretch *c = ta_am_stretch_create(rate, channels, ta_am_get_kernels(TA_AM_C));
  require(c != NULL, "create C");
  for (int mode = TA_AM_C; mode <= TA_AM_AVX2; mode++) {
    const ta_am_kernels *k = ta_am_get_kernels((ta_am_cpu)mode);
    if (!k) continue;
    ta_am_stretch *s = ta_am_stretch_create(rate, channels, k);
    require(s != NULL, "create path");
    for (unsigned p = 0; p < 5; p++) {
      const float speed[] = {0.88f, 0.96f, 1.0f, 1.04f, 1.12f};
      float first = speed[p];
      require(!ta_am_stretch_render(c, source, source_frames, 8000, first, 1, ref, frames),
              "render C");
      require(!ta_am_stretch_render(s, source, source_frames, 8000, first, 1, actual, frames),
              "render native");
      double energy = 0, max_error = 0, max_stereo = 0;
      for (size_t i = 0; i < frames; i++) {
        energy += actual[2 * i] * actual[2 * i];
        double d = fabs(ref[2 * i] - actual[2 * i]);
        if (d > max_error) max_error = d;
        d = fabs(actual[2 * i] + actual[2 * i + 1]);
        if (d > max_stereo) max_stereo = d;
      }
      unsigned crossings = 0;
      for (size_t i = 1001; i < frames - 1000; i++)
        if (actual[2 * i] >= 0 && actual[2 * (i - 1)] < 0) crossings++;
      double hz = crossings * rate / (double)(frames - 2000);
      printf("MEASURE %s rate=%.3f error=%.8g stereo=%.8g energy=%.8g pitch=%.3f\n",
             ta_am_cpu_name(k->cpu), first, max_error, max_stereo, energy / frames, hz);
      require(max_error < 0.0001, "C/assembly audio parity");
      require(max_stereo < 0.000001, "anti-phase stereo preserved");
      require(hz > 438 && hz < 442, "pitch preserved");
      require(energy / frames > 0.06 && energy / frames < 0.1, "gain bounded");
      if (first == 1)
        require(!memcmp(actual, source + 16000, frames * channels * 4), "unity-rate exact audio");
      double end = ta_am_stretch_source_at(8000, first, 1, frames, (double)frames);
      require(fabs(end - (8000 + frames * (first * 0.9 + 0.1))) < 0.001, "source mapping integral");
      printf("PASS %s rate=%.3f error=%.8g pitch=%.3f\n", ta_am_cpu_name(k->cpu), first, max_error,
             hz);
    }
    require(ta_am_stretch_render(s, source, source_frames, 8000, .879f, 1, actual, frames) != 0 &&
        ta_am_stretch_render(s, source, source_frames, 8000, 1.121f, 1, actual, frames) != 0, "out-of-policy stretch rejected");
    ta_am_stretch_free(s);
  }
  float beat[30] = {0}, down[30] = {0};
  double beats[30], db[30];
  size_t nb, nd;
  beat[5] = 2;
  beat[6] = 2;
  beat[20] = 3;
  down[19] = 1;
  require(!ta_am_beat_events(beat, down, 30, beats, &nb, db, &nd), "event conversion");
  require(nb == 2 && nd == 1 && beats[0] == 5.5 / 50 && db[0] == beats[1],
          "minimal event reference");
  ta_am_stretch_free(c);
  free(source);
  free(ref);
  free(actual);
  return 0;
}
