#include <stdio.h>
#include <stdlib.h>
#include "am_events.h"
#include "am_file.h"
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  float logits[3000];
  double beats[1500], downbeats[1500];
  size_t nb, nd;
  FILE *f = ta_am_open_read(argv[1]);
  if (!f || fread(logits, sizeof(float), 3000, f) != 3000) return 1;
  fclose(f);
  if (ta_am_beat_events(logits, logits + 1500, 1500, beats, &nb, downbeats, &nd)) return 1;
  f = fopen(argv[2], "wb");
  if (!f) return 1;
  fprintf(f, "{\"beats\":[");
  for (size_t i = 0; i < nb; i++) fprintf(f, "%s%.12g", i ? "," : "", beats[i]);
  fprintf(f, "],\"downbeats\":[");
  for (size_t i = 0; i < nd; i++) fprintf(f, "%s%.12g", i ? "," : "", downbeats[i]);
  fprintf(f, "]}\n");
  return fclose(f) != 0;
}
