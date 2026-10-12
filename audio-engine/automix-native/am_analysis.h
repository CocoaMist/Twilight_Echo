#ifndef TWILIGHT_AM_ANALYSIS_H
#define TWILIGHT_AM_ANALYSIS_H
#include <stdint.h>

#include "am_frontend.h"
#include "am_graph.h"
#ifdef __cplusplus
extern "C" {
#endif
#define TA_AM_MAX_EVENTS 6000
#define TA_AM_MAX_VOICE 1024
#define TA_AM_MAX_FRAMES 6000
typedef struct {
  double start_seconds, end_seconds, duration_seconds;
  uint32_t complete, beat_count, downbeat_count, voice_count;
  float bpm, tempo_confidence, rms_db, peak, key_confidence;
  int32_t key; /* 0..11 major, 12..23 minor, -1 unknown */
  double beats[TA_AM_MAX_EVENTS], downbeats[TA_AM_MAX_EVENTS];
  float voice[TA_AM_MAX_VOICE], music[TA_AM_MAX_VOICE];
  double voice_start[TA_AM_MAX_VOICE], voice_end[TA_AM_MAX_VOICE];
  float frame_db[TA_AM_MAX_FRAMES], frame_peak[TA_AM_MAX_FRAMES];
  uint32_t frame_count;
  float frame_onset[TA_AM_MAX_FRAMES], frame_low_db[TA_AM_MAX_FRAMES];
  uint32_t spectral_count;
} ta_am_features;
typedef struct ta_am_analyser ta_am_analyser;
/* Hash-checked asset paths are supplied by the host. One analyser per worker. */
ta_am_analyser *ta_am_analyser_create(const char *beat_graph, const char *voice_graph,
                                      const ta_am_kernels *, char *error, size_t error_size);
void ta_am_analyser_free(ta_am_analyser *);
/* Shared validation for cached/IPC features and the native selector. */
int ta_am_features_valid(const ta_am_features *);
int ta_am_analyse_window(ta_am_analyser *, const float *mono22050, size_t beat_samples,
                         const float *mono16000, size_t voice_samples, double range_start,
                         double duration, ta_am_features *, const ta_am_cancel *cancel);
/* Known voice upper bound over absolute source times; -1 outside valid coverage. */
float ta_am_voice_between(const ta_am_features *, double start, double end, int require_music);
#ifdef __cplusplus
}
#endif
#endif
