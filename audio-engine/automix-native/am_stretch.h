#ifndef TWILIGHT_AM_STRETCH_H
#define TWILIGHT_AM_STRETCH_H
#include "am_cancel.h"
#include "am_kernels.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct ta_am_stretch ta_am_stretch;
ta_am_stretch *ta_am_stretch_create(unsigned sample_rate, unsigned channels,
                                    const ta_am_kernels *);
void ta_am_stretch_free(ta_am_stretch *);
/* Offline preparation only. Time-only adaptation of MIT Signalsmith's linked
 * horizontal/vertical phase prediction. Caller supplies real context before
 * source_start and after the rendered interval; no invented latency offset.
 * A linear speed return over the last 20% preserves the normal-rate handoff. */
int ta_am_stretch_render(ta_am_stretch *, const float *input,
                         size_t input_frames, double source_start,
                         float initial_rate, float final_rate, float *output,
                         size_t output_frames);
int ta_am_stretch_render_cancelled(ta_am_stretch *, const float *, size_t,
                                   double, float, float, float *, size_t,
                                   const ta_am_cancel *);
double ta_am_stretch_source_at(double source_start, float initial_rate,
                               float final_rate, size_t output_frames,
                               double output_frame);
#ifdef __cplusplus
}
#endif
#endif
