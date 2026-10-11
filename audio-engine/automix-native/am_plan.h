#ifndef TWILIGHT_AM_PLAN_H
#define TWILIGHT_AM_PLAN_H
#include "am_analysis.h"
#include "am_stretch.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef enum { TA_AM_OFF = 0, TA_AM_NATURAL = 1, TA_AM_DJ = 2 } ta_am_mode;
typedef enum {
  TA_AM_CLEAN = 0,
  TA_AM_FILTER = 1,
  TA_AM_ECHO = 2,
  TA_AM_REVERB = 3,
  TA_AM_REPEAT = 4
} ta_am_effect;
typedef enum {
  TA_AM_BEAT_ALIGNED = 0,
  TA_AM_CONTENT_BOUNDARY = 1,
  TA_AM_TAIL_OVERLAP = 2,
  TA_AM_RELEASE_BOUNDARY = 3
} ta_am_transition_kind;
const char *ta_am_transition_name(ta_am_transition_kind kind);
typedef struct {
  uint64_t plan_id, queue_revision, playback_generation, format_revision;
  char current_identity[65],
      next_identity[65]; /* host-verified SHA-256 identity */
  unsigned sample_rate, channels;
} ta_am_binding;
typedef struct {
  ta_am_binding binding;
  ta_am_mode mode;
  ta_am_effect effect;
  uint64_t output_frames, current_start, current_end, next_start, next_end;
  float current_rate, next_rate, bpm, confidence, score, next_gain;
  ta_am_transition_kind kind;
  float low_clash, vocal_clash;
  uint32_t stem_enhanced;
} ta_am_plan_spec;
typedef struct ta_am_prepared ta_am_prepared;
/* Returns 1 for intelligent plan, 0 for reasoned fallback, -1 invalid input.
 * Queue/transport identity remains host-owned; all mix policy is native C. */
int ta_am_select(const ta_am_features *current, const ta_am_features *next,
                 ta_am_mode, const ta_am_binding *, ta_am_plan_spec *,
                 char *reason, size_t reason_size);
int ta_am_select_with_kernels(const ta_am_features *, const ta_am_features *,
                              ta_am_mode, const ta_am_binding *,
                              const ta_am_kernels *, ta_am_plan_spec *,
                              char *reason, size_t reason_size);
int ta_am_plan_valid(const ta_am_plan_spec *, const ta_am_kernels *);
int ta_am_select_after(const ta_am_features *, const ta_am_features *, ta_am_mode,
                       const ta_am_binding *, const ta_am_kernels *, uint64_t minimum_start,
                       ta_am_plan_spec *, char *, size_t);
/* Worker reserves peak bytes before decoding. A reserved preparation consumes
 * the reservation on every path; abandon releases an unused reservation. */
size_t ta_am_preparation_reserve(const ta_am_plan_spec *, size_t current_frames,
                                 size_t next_frames);
void ta_am_preparation_abandon(size_t reservation);
void ta_am_prepared_release_scratch_budget(ta_am_prepared *);
ta_am_prepared *ta_am_prepare_reserved(const ta_am_plan_spec *, const float *,
                                       size_t, uint64_t, const float *, size_t,
                                       uint64_t, const ta_am_kernels *,
                                       const ta_am_cancel *, size_t reservation,
                                       char *, size_t);
/* Source buffers are decoded at output format and include real look-behind/
 * look-ahead. Absolute frame origins describe the buffers. Worker-only. */
ta_am_prepared *ta_am_prepare(const ta_am_plan_spec *, const float *current,
                              size_t current_frames, uint64_t current_origin,
                              const float *next, size_t next_frames,
                              uint64_t next_origin, const ta_am_kernels *,
                              char *reason, size_t reason_size);
ta_am_prepared *ta_am_prepare_cancelled(const ta_am_plan_spec *, const float *,
                                        size_t, uint64_t, const float *, size_t,
                                        uint64_t, const ta_am_kernels *,
                                        const ta_am_cancel *, char *, size_t);
void ta_am_prepared_free(ta_am_prepared *);
const ta_am_plan_spec *ta_am_prepared_spec(const ta_am_prepared *);
size_t ta_am_prepared_bytes(const ta_am_prepared *);
/* Immutable arrays. Render callback copies each deck into its existing DSP
 * scratch, runs the deck's DSP chain, then uses mix on the prepared gains. */
const float *ta_am_prepared_lane(const ta_am_prepared *, unsigned deck);
void ta_am_prepared_mix(const ta_am_prepared *, uint64_t frame,
                        const float *processed_current,
                        const float *processed_next, float *destination,
                        size_t frames);
void ta_am_prepared_mix_routed(const ta_am_prepared *, uint64_t frame,
                               const float *, const float *, float *,
                               size_t frames, unsigned output_channels);
uint64_t ta_am_plan_source_frame(const ta_am_plan_spec *, unsigned deck,
                                 double output_frame);
uint64_t ta_am_prepared_source_frame(const ta_am_prepared *, unsigned deck,
                                     double output_frame);
#ifdef __cplusplus
}
#endif
#endif
