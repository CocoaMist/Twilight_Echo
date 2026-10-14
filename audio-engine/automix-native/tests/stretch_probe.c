#include <stdio.h>
#include <stdlib.h>
#include "am_stretch.h"
#include "am_file.h"
int main(int argc, char **argv) {
  if (argc != 9) return 2;
  unsigned rate = (unsigned)strtoul(argv[3], NULL, 10), channels = (unsigned)strtoul(argv[4], NULL, 10);
  size_t frames = (size_t)strtoul(argv[5], NULL, 10);
  float ratio = strtof(argv[6], NULL);
  const ta_am_kernels *k = ta_am_get_kernels(argv[8][0] == 'c' ? TA_AM_C :
    argv[8][0] == 's' ? TA_AM_SSE2 : TA_AM_AVX2);
  if (!k) return 3;
  FILE *f = ta_am_open_read(argv[1]);
  if (!f || !channels || channels > 8 || frames > 384000 * 30ull) return 1;
  fseek(f, 0, SEEK_END);
  long bytes = ftell(f);
  rewind(f);
  if (bytes < 0 || bytes % (4 * channels)) return 1;
  size_t count = (size_t)bytes / (4 * channels);
  float *input = malloc((size_t)bytes), *output = malloc(frames * channels * 4);
  if (!input || !output || fread(input, 1, (size_t)bytes, f) != (size_t)bytes) return 1;
  fclose(f);
  ta_am_stretch *s = ta_am_stretch_create(rate, channels, k);
  if (!s || ta_am_stretch_render(s, input, count, strtod(argv[7], NULL), ratio, ratio, output, frames)) return 1;
  f = fopen(argv[2], "wb");
  if (!f || fwrite(output, 4 * channels, frames, f) != frames) return 1;
  fclose(f);
  ta_am_stretch_free(s);
  free(input);
  free(output);
  return 0;
}
