/* Development-only real pair renderer. No sources/PCM are release inputs. */
#include "am_plan.h"
#include "am_file.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fixture_v1.h"
static int features(const char *path, ta_am_features *f) {
  FILE *in = ta_am_open_read(path);
  if (!in) return 0;
  int ok = read_feature_fixture(in, f) && fgetc(in) == EOF;
  fclose(in);
  return ok && ta_am_features_valid(f);
}
static float *pcm(const char *path, unsigned channels, unsigned rate, size_t *frames) {
  FILE *in = ta_am_open_read(path);
  if (!in) return NULL;
  fseek(in, 0, SEEK_END);
  long bytes = ftell(in);
  rewind(in);
  if (bytes <= 0 || bytes % (4 * channels) || (size_t)bytes > (size_t)rate * channels * 4 * 40) {
    fclose(in); return NULL;
  }
  float *x = malloc((size_t)bytes);
  int ok = x && fread(x, (size_t)bytes, 1, in) == 1;
  fclose(in);
  if (!ok) { free(x); return NULL; }
  *frames = (size_t)bytes / (4 * channels);
  for (size_t i = 0; i < *frames * channels; i++)
    if (!isfinite(x[i])) { free(x); return NULL; }
  return x;
}
int main(int argc, char **argv) {
  if (argc != 15) return 2;
  int selection_only = getenv("TA_AM_PROBE_SELECT_ONLY") != NULL;
  const ta_am_kernels *k = ta_am_get_kernels(!strcmp(argv[10], "c") ? TA_AM_C :
      !strcmp(argv[10], "sse2") ? TA_AM_SSE2 : !strcmp(argv[10], "avx2") ? TA_AM_AVX2 : TA_AM_AUTO);
  if (!k) return 3;
  ta_am_features a, b;
  if (!features(argv[1], &a) || !features(argv[2], &b)) return 2;
  ta_am_binding bind = {0};
  bind.sample_rate = (unsigned)strtoul(argv[7], NULL, 10);
  bind.channels = (unsigned)strtoul(argv[8], NULL, 10);
  if (strlen(argv[13]) != 64 || strlen(argv[14]) != 64) return 2;
  memcpy(bind.current_identity, argv[13], 65); memcpy(bind.next_identity, argv[14], 65);
  bind.plan_id = bind.queue_revision = bind.playback_generation = bind.format_revision = 1;
  ta_am_plan_spec spec;
  char why[128] = {0};
  int selected = ta_am_select_with_kernels(&a, &b, !strcmp(argv[9], "natural") ? TA_AM_NATURAL : TA_AM_DJ,
      &bind, k, &spec, why, sizeof(why));
  if (selected < 0) return 2;
  ta_am_prepared *prepared = NULL;
  if (selected && !selection_only) {
    size_t an = 0, bn = 0;
    float *x = pcm(argv[3], bind.channels, bind.sample_rate, &an);
    float *y = pcm(argv[5], bind.channels, bind.sample_rate, &bn);
    if (!x || !y) { free(x); free(y); return 2; }
    prepared = ta_am_prepare(&spec, x, an, strtoull(argv[4], NULL, 10), y, bn,
        strtoull(argv[6], NULL, 10), k, why, sizeof(why));
    free(x); free(y);
    if (!prepared) selected = 0;
  }
  FILE *report = fopen(argv[12], "wb");
  if (!report) { ta_am_prepared_free(prepared); return 2; }
  fprintf(report, "{\"intelligent\":%s,\"reason\":\"%s\"", selected ? "true" : "false", why);
  if (selection_only) fprintf(report, ",\"selectionOnly\":true");
  if (selected) {
    fprintf(report, ",\"strategy\":\"%s\"", spec.kind == TA_AM_CONTENT_BOUNDARY ? "content-boundary" : "beat-aligned");
    fprintf(report, ",\"effect\":%d,\"outputFrames\":%llu,\"currentStart\":%llu,\"currentEnd\":%llu,"
        "\"nextStart\":%llu,\"nextEnd\":%llu,\"currentRate\":%.9g,\"nextRate\":%.9g,"
        "\"score\":%.9g,\"confidence\":%.9g,\"preparedBytes\":%zu",
        spec.effect, (unsigned long long)spec.output_frames, (unsigned long long)spec.current_start,
        (unsigned long long)spec.current_end, (unsigned long long)spec.next_start, (unsigned long long)spec.next_end,
        spec.current_rate, spec.next_rate, spec.score, spec.confidence, ta_am_prepared_bytes(prepared));
    FILE *out = prepared ? fopen(argv[11], "wb") : NULL;
    if (selection_only) goto report_end;
    if (!out) { fclose(report); ta_am_prepared_free(prepared); return 2; }
    float block[512 * 8];
    const float *x = ta_am_prepared_lane(prepared, 0), *y = ta_am_prepared_lane(prepared, 1);
    for (uint64_t frame = 0; frame < spec.output_frames; frame += 512) {
      size_t n = spec.output_frames - frame > 512 ? 512 : (size_t)(spec.output_frames - frame);
      ta_am_prepared_mix(prepared, frame, x + frame * bind.channels, y + frame * bind.channels, block, n);
      if (fwrite(block, sizeof(float) * bind.channels, n, out) != n) {
        fclose(out); fclose(report); ta_am_prepared_free(prepared); return 2;
      }
    }
    fclose(out);
  }
report_end:
  fprintf(report, "}\n"); fclose(report); ta_am_prepared_free(prepared);
  return 0;
}
