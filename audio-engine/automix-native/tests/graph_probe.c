#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#include "am_graph.h"
int main(int argc, char **argv) {
  if (argc != 5) {
    fprintf(stderr, "usage: graph_probe graph.tamg input.f32 output.f32 c|sse2|avx2\n");
    return 2;
  }
  ta_am_cpu cpu = argv[4][0] == 'c' ? TA_AM_C : argv[4][0] == 's' ? TA_AM_SSE2 : TA_AM_AVX2;
  const ta_am_kernels *k = ta_am_get_kernels(cpu);
  if (!k) {
    fprintf(stderr, "CPU unavailable\n");
    return 3;
  }
  char err[256];
  ta_am_graph *g = ta_am_graph_load(argv[1], k, err, sizeof(err));
  if (!g) {
    fprintf(stderr, "%s\n", err);
    return 1;
  }
  size_t n = ta_am_graph_input_count(g, 0);
  float *x = malloc(n * 4);
  FILE *f = fopen(argv[2], "rb");
  if (!x || !f || fread(x, 4, n, f) != n) {
    fprintf(stderr, "input unavailable\n");
    return 1;
  }
  fclose(f);
  clock_t start = clock();
  int result = ta_am_graph_run(g, x, n, NULL);
  printf("%s memory=%zu run_ms=%.3f status=%d\n", ta_am_cpu_name(cpu), ta_am_graph_memory(g),
         1000.0 * (clock() - start) / CLOCKS_PER_SEC, result);
  if (result) return 1;
  f = fopen(argv[3], "wb");
  if (!f) return 1;
  for (unsigned i = 0; ta_am_graph_output_count(g, i); i++) {
    size_t count = ta_am_graph_output_count(g, i);
    if (fwrite(ta_am_graph_output(g, i), 4, count, f) != count) return 1;
  }
  fclose(f);
  free(x);
  ta_am_graph_free(g);
  return 0;
}
