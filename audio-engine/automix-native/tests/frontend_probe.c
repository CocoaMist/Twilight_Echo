#include <stdio.h>
#include <stdlib.h>

#include "am_frontend.h"
int main(int argc, char **argv) {
  if (argc != 6) return 2;
  ta_am_model_kind kind = argv[1][0] == 'b' ? TA_AM_BEAT_THIS : TA_AM_YAMNET;
  const ta_am_kernels *k = ta_am_get_kernels(argv[5][0] == 'c'   ? TA_AM_C
                                             : argv[5][0] == 's' ? TA_AM_SSE2
                                                                 : TA_AM_AVX2);
  if (!k) return 3;
  FILE *f = fopen(argv[2], "rb");
  if (!f) return 1;
  fseek(f, 0, SEEK_END);
  long bytes = ftell(f);
  rewind(f);
  if (bytes < 0 || bytes % 4) return 1;
  size_t samples = (size_t)bytes / 4, frames = (size_t)strtoul(argv[4], NULL, 10),
         bands = kind == TA_AM_BEAT_THIS ? 128 : 64;
  if (frames > 100000 || samples > 22050 * 600) return 1;
  float *x = malloc(samples * 4 + 4), *mel = malloc(frames * bands * 4);
  if (!x || !mel || fread(x, 4, samples, f) != samples) return 1;
  fclose(f);
  ta_am_frontend *frontend = ta_am_frontend_create(kind, k);
  if (!frontend) return 1;
  if (ta_am_frontend_process(frontend, x, samples, 0, frames, mel)) return 1;
  f = fopen(argv[3], "wb");
  if (!f || fwrite(mel, 4, frames * bands, f) != frames * bands) return 1;
  fclose(f);
  ta_am_frontend_free(frontend);
  free(x);
  free(mel);
  return 0;
}
