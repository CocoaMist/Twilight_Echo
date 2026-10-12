#include "am_analysis.h"
#include "am_file.h"
#include <stdio.h>
#include <stdlib.h>

/* Development binary fixture ABI, never consumed by the application/cache. */
_Static_assert(sizeof(ta_am_features) == 216648, "v2 analysis ABI");
static float *read_pcm(const char *path, size_t limit, size_t *count) {
  FILE *f = ta_am_open_read(path);
  if (!f)
    return NULL;
  fseek(f, 0, SEEK_END);
  long bytes = ftell(f);
  rewind(f);
  if (bytes <= 0 || bytes % 4 || (size_t)bytes / 4 > limit) {
    fclose(f);
    return NULL;
  }
  *count = (size_t)bytes / 4;
  float *x = malloc((size_t)bytes);
  if (!x || fread(x, 4, *count, f) != *count) {
    free(x);
    x = NULL;
  }
  fclose(f);
  return x;
}
int main(int argc, char **argv) {
  if (argc != 9)
    return 2;
  const ta_am_kernels *k = ta_am_get_kernels(argv[8][0] == 'c'   ? TA_AM_C
                                             : argv[8][0] == 's' ? TA_AM_SSE2
                                                                 : TA_AM_AVX2);
  if (!k)
    return 3;
  size_t n, nv;
  float *x = read_pcm(argv[3], 661500, &n),
        *voice = read_pcm(argv[4], 480000, &nv);
  if (!x || !voice)
    return 1;
  char error[256];
  ta_am_analyser *a =
      ta_am_analyser_create(argv[1], argv[2], k, error, sizeof(error));
  if (!a) {
    fprintf(stderr, "%s\n", error);
    return 1;
  }
  ta_am_features f;
  int result = ta_am_analyse_window(a, x, n, voice, nv, strtod(argv[5], NULL),
                                    strtod(argv[6], NULL), &f, NULL);
  if (result || !ta_am_features_valid(&f)) {
    fprintf(stderr, "analysis failed %d\n", result);
    return 1;
  }
  FILE *out = fopen(argv[7], "wb");
  if (!out || fwrite(&f, sizeof(f), 1, out) != 1 || fclose(out))
    return 1;
  ta_am_analyser_free(a);
  free(x);
  free(voice);
  return 0;
}
