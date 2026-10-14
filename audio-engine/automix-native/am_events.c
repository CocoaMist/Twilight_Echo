#include "am_events.h"

#include <math.h>
static size_t peaks(const float *logits, size_t frames, double *output) {
  size_t count = 0, group_count = 0;
  double mean = 0;
  for (size_t i = 0; i < frames; i++) {
    if (!isfinite(logits[i]) || logits[i] <= 0) continue;
    int peak = 1;
    size_t start = i > 3 ? i - 3 : 0, end = i + 4 < frames ? i + 4 : frames;
    for (size_t j = start; j < end; j++)
      if (logits[j] > logits[i]) {
        peak = 0;
        break;
      }
    if (!peak) continue;
    if (group_count && (double)i - mean <= 1) {
      group_count++;
      mean += ((double)i - mean) / group_count;
    } else {
      if (group_count) output[count++] = mean / 50;
      mean = (double)i;
      group_count = 1;
    }
  }
  if (group_count) output[count++] = mean / 50;
  return count;
}
int ta_am_beat_events(const float *beat, const float *downbeat, size_t frames, double *beats,
                      size_t *nb, double *downbeats, size_t *nd) {
  if (!beat || !downbeat || !beats || !downbeats || !nb || !nd || frames > 100000) return -1;
  for (size_t i = 0; i < frames; i++)
    if (!isfinite(beat[i]) || !isfinite(downbeat[i])) return -1;
  *nb = peaks(beat, frames, beats);
  size_t raw = peaks(downbeat, frames, downbeats);
  *nd = 0;
  for (size_t i = 0; i < raw; i++) {
    double pos = downbeats[i];
    if (*nb) {
      size_t nearest = 0;
      double distance = fabs(beats[0] - pos);
      for (size_t j = 1; j < *nb; j++) {
        double d = fabs(beats[j] - pos);
        if (d < distance) {
          nearest = j;
          distance = d;
        }
      }
      pos = beats[nearest];
    }
    if (!*nd || pos > downbeats[*nd - 1]) downbeats[(*nd)++] = pos;
  }
  return 0;
}
float ta_am_voice_probability(const float *scores, size_t classes) {
  if (!scores || classes != 521) return -1;
  float probability = 0;
  /* YAMNet's published class indices 0..34 cover speech, singing and human
   * vocalisations. Unknown/bad output remains unknown, never 'no voice'. */
  for (size_t i = 0; i < classes; i++)
    if (!isfinite(scores[i]) || scores[i] < 0 || scores[i] > 1) return -1;
  for (size_t i = 0; i <= 34; i++)
    if (scores[i] > probability) probability = scores[i];
  return probability;
}
