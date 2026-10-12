#include "am_rhythm.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

static int ascending(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return x < y ? -1 : x > y;
}
static void fit(const double *events, unsigned first, unsigned last,
                double seed, const ta_am_kernels *k, ta_am_rhythm *best) {
  unsigned count = last - first + 1;
  if (count < 8 || events[last] - events[first] < 2.5) return;
  float indices[TA_AM_MAX_EVENTS], times[TA_AM_MAX_EVENTS];
  unsigned missing = 0;
  indices[0] = times[0] = 0;
  for (unsigned i = 1; i < count; i++) {
    unsigned step = (unsigned)llround((events[first + i] - events[first + i - 1]) / seed);
    missing += step - 1;
    indices[i] = indices[i - 1] + step;
    times[i] = (float)llround((events[first + i] - events[first]) * 50);
  }
  // A half-period hypothesis must have observed intermediate events. A run
  // consisting mostly of "missing" beats cannot prove twice the tempo.
  if (missing > (count - 1) / 4) return;
  double index_sum = k->sum(indices, count, 1), time_sum = k->sum(times, count, 1);
  double square_sum = 0, cross_sum = 0;
  // Four-element integer dot products remain exactly representable in float.
  // The rational fit is identical on C/SSE2/AVX2 before source-frame rounding.
  for (unsigned i = 0; i < count; i += 4) {
    unsigned n = count - i < 4 ? count - i : 4;
    square_sum += k->dot(indices + i, indices + i, n);
    cross_sum += k->dot(indices + i, times + i, n);
  }
  double denominator = count * square_sum - index_sum * index_sum;
  if (denominator <= 0) return;
  double period = .02 * (count * cross_sum - index_sum * time_sum) / denominator;
  if (period < .2 || period > 60. / 55) return;
  double origin = .02 * time_sum / count - period * index_sum / count;
  double tolerance = fmax(.04, period * .08), residual = 0;
  unsigned consistent = 0;
  for (unsigned i = 0; i < count; i++) {
    double error = fabs(events[first + i] - events[first] - origin - period * indices[i]);
    residual += fmin(error / tolerance, 1);
    consistent += error <= tolerance;
  }
  float confidence = (float)((double)consistent / count *
      fmax(0, 1 - residual / count) * (1 - .5 * missing / (count - 1)));
  if (confidence < .55f) return;
  double span = events[last] - events[first];
  double best_span = best->last - best->first;
  // Prefer substantial stable evidence; an isolated perfect short run must
  // not replace a nearly perfect run covering the whole candidate.
  if (confidence * fmin(span, 12) <= best->confidence * fmin(best_span, 12)) return;
  best->first = events[first]; best->last = events[last];
  best->bpm = (float)(60 / period); best->confidence = confidence;
  best->beats = count;
}
int ta_am_rhythm_region(const ta_am_features *f, double start, double end,
                        const ta_am_kernels *k, ta_am_rhythm *out) {
  if (!f || !k || !out || !isfinite(start) || !isfinite(end) || end <= start ||
      start < f->start_seconds || end > f->end_seconds || f->beat_count > TA_AM_MAX_EVENTS) return 0;
  memset(out, 0, sizeof(*out));
  double events[TA_AM_MAX_EVENTS], intervals[TA_AM_MAX_EVENTS - 1];
  unsigned count = 0, periods = 0;
  for (unsigned i = 0; i < f->beat_count; i++) {
    if (!isfinite(f->beats[i]) || (i && f->beats[i] <= f->beats[i - 1])) return 0;
    if (f->beats[i] < start || f->beats[i] > end) continue;
    events[count++] = f->beats[i];
  }
  if (count < 8) return 0;
  for (unsigned i = 1; i < count; i++) {
    double d = events[i] - events[i - 1];
    if (d >= .2 && d <= 60. / 55) intervals[periods++] = d;
  }
  if (periods < 7) return 0;
  qsort(intervals, periods, sizeof(double), ascending);
  // Quantiles cover minority tempo regions without an unbounded all-pairs
  // search. Refinement uses real timestamps, not the quantised median BPM.
  for (unsigned seed_index = 0; seed_index < 9; seed_index++) {
    double seed = intervals[(size_t)seed_index * (periods - 1) / 8];
    if (seed_index && seed == intervals[(size_t)(seed_index - 1) * (periods - 1) / 8]) continue;
    unsigned first = 0;
    for (unsigned i = 1; i < count; i++) {
      double d = events[i] - events[i - 1];
      double step = round(d / seed);
      if (step < 1 || step > 2 || fabs(d - step * seed) > fmax(.04, seed * .08)) {
        fit(events, first, i - 1, seed, k, out);
        first = i;
      }
    }
    fit(events, first, count - 1, seed, k, out);
  }
  return out->beats >= 8;
}
