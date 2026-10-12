#ifndef TWILIGHT_AM_RHYTHM_H
#define TWILIGHT_AM_RHYTHM_H
#include "am_analysis.h"
typedef struct {
  double first, last;
  float bpm, confidence;
  unsigned beats;
} ta_am_rhythm;
/* Evidence is restricted to real model events inside this source interval.
 * No extrapolated beats or global confidence overwrite are produced. */
int ta_am_rhythm_region(const ta_am_features *, double start, double end,
                        const ta_am_kernels *, ta_am_rhythm *);
#endif
