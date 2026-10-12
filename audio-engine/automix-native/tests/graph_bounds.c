#include "am_graph.h"
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {
  uint32_t rank, constant, d[8];
  uint64_t count, offset;
} tensor;
typedef struct {
  uint32_t op, ni, no, in[8], out[8];
  int32_t p[24];
  float f[4];
} node;
static void require(int ok, const char *label) {
  if (!ok) {
    fprintf(stderr, "FAIL %s\n", label);
    exit(1);
  }
}
static void fixture(unsigned which, const char *path) {
  uint32_t counts[4] = {3, 1, 1, 1}, io[2] = {0, 2};
  uint64_t sizes[3] = {32, 16, 16};
  tensor t[3] = {
      {2, 0, {2, 2}, 4, 0}, {2, 1, {2, 2}, 4, 0}, {2, 0, {2, 2}, 4, 16}};
  node n = {0};
  n.op = 13;
  n.ni = 2;
  n.no = 1;
  n.in[1] = 1;
  n.out[0] = 2;
  float weights[4] = {1, 2, 3, 4};
  switch (which) {
  case 1:
    n.ni = 3;
    n.in[2] = 0;
    break;
  case 2:
    n.op = 21;
    n.p[1] = 1;
    sizes[1] = 0;
    break;
  case 3:
    n.f[0] = NAN;
    break;
  case 4:
    t[2].constant = 1;
    t[2].offset = 0;
    break;
  case 5:
    t[2].d[1] = 3;
    break;
  case 6:
    t[0].offset = UINT64_MAX;
    break;
  case 7:
    t[0].rank = 9;
    break;
  case 8:
    io[0] = 1;
    break;
  case 9:
    n.op = 21;
    n.p[1] = 2;
    break;
  case 10:
    t[0].d[0] = UINT32_MAX;
    t[0].d[1] = UINT32_MAX;
    break;
  case 11:
    n.op = 10;
    n.ni = 1;
    n.f[0] = 1;
    n.f[1] = 0;
    break;
  case 12:
    t[0].d[0] = 0;
    t[0].count = 0;
    break;
  case 13:
    io[1] = 1;
    break;
  }
  FILE *f = fopen(path, "wb");
  require(f != NULL, "fixture file");
  fwrite("TAMG0001", 1, 8, f);
  fwrite(counts, 4, 4, f);
  fwrite(sizes, 8, 3, f);
  fwrite(t, sizeof(tensor), 3, f);
  fwrite(&n, sizeof(n), 1, f);
  fwrite(io, 4, 2, f);
  fwrite(weights, 4, 4, f);
  fclose(f);
}
int main(void) {
  const char *path = "automix-boundary-test.tamg";
  char error[128];
  for (unsigned i = 0; i < 14; i++) {
    fixture(i, path);
    ta_am_graph *g = ta_am_graph_load(path, ta_am_get_kernels(TA_AM_C), error,
                                      sizeof(error));
    if (i && g) {
      fprintf(stderr, "FAIL malformed graph case %u accepted\n", i);
      exit(1);
    } else if (!i) {
      require(g != NULL, error);
      float input[4] = {1, 1, 1, 1};
      ta_am_cancel *cancel = ta_am_cancel_create();
      require(cancel != NULL, "cancel token");
      ta_am_cancel_request(cancel);
      require(ta_am_graph_run(g, input, 4, cancel) == -2,
              "cancel before execution");
      require(!ta_am_graph_run(g, input, 4, NULL), "valid graph execution");
      const float *out = ta_am_graph_output(g, 0);
      require(out[0] == 4 && out[1] == 6 && out[2] == 4 && out[3] == 6,
              "matrix output");
      ta_am_cancel_free(cancel);
    }
    ta_am_graph_free(g);
  }
  remove(path);
  puts("PASS graph scratch, rank, IO, params, matrix and cancellation bounds");
  return 0;
}
