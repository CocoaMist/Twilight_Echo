#ifndef TWILIGHT_AM_JOB_H
#define TWILIGHT_AM_JOB_H
#include "am_plan.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct ta_am_job ta_am_job;
typedef enum {
  TA_AM_JOB_PREPARING,
  TA_AM_JOB_READY,
  TA_AM_JOB_DEGRADED,
  TA_AM_JOB_CANCELLED,
  TA_AM_JOB_TAKEN
} ta_am_job_state;
typedef struct {
  ta_am_features current, next;
  ta_am_binding binding;
  ta_am_mode mode;
  const ta_am_kernels *kernels;
  unsigned timeout_ms;
  uint64_t minimum_current_start;
  int has_selection;
  ta_am_plan_spec selection;
} ta_am_job_request;
/* IO only: verify/open the authorized sources, decode the specified logical
 * ranges and pre-roll an incoming continuation at spec->next_end. No policy
 * lives in these callbacks. All callbacks run off the audio/control threads. */
typedef struct {
  int (*decode)(void *, const ta_am_plan_spec *, unsigned deck, uint64_t first,
                size_t wanted, const ta_am_cancel *, const float **pcm,
                size_t *frames, char *reason, size_t reason_size);
  int (*continuation)(void *, const ta_am_plan_spec *, const ta_am_cancel *,
                      char *reason, size_t reason_size);
  void (*release_decoded)(void *);
  int (*material_ready)(void *); /* Optional; both decks passed validation. */
} ta_am_job_io;
/* One process-wide worker slot; busy is a reasoned fallback, no job queue. */
ta_am_job *ta_am_job_start(const ta_am_job_request *, const ta_am_job_io *,
                           void *context, char *reason, size_t reason_size);
ta_am_job_state ta_am_job_status(const ta_am_job *);
void ta_am_job_cancel(ta_am_job *);
/* Control-only, once READY. Ownership transfers to host callback-epoch storage.
 */
ta_am_prepared *ta_am_job_take(ta_am_job *);
const char *ta_am_job_reason(const ta_am_job *);
const char *ta_am_job_stage(const ta_am_job *);
uint64_t ta_am_job_elapsed_ms(const ta_am_job *, unsigned stage);
/* Control/worker only. Cancels and joins; context must outlive this call. */
void ta_am_job_destroy(ta_am_job *);
#ifdef __cplusplus
}
#endif
#endif
