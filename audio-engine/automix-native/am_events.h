#ifndef TWILIGHT_AM_EVENTS_H
#define TWILIGHT_AM_EVENTS_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Beat This minimal public postprocessor: +/-3 frames, positive logits,
 * adjacent-peak averaging, downbeat snapping. Caller supplies >=frames slots. */
int ta_am_beat_events(const float *beat, const float *downbeat, size_t frames, double *beats,
                      size_t *beat_count, double *downbeats, size_t *downbeat_count);
float ta_am_voice_probability(const float *yamnet_scores, size_t classes);
#ifdef __cplusplus
}
#endif
#endif
