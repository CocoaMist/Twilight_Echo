#include "am_job.h"
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(_WIN32)
#include <process.h>
#include <windows.h>
#else
#include <pthread.h>
#endif
struct ta_am_job {
  ta_am_job_request request;
  ta_am_job_io io;
  void *context;
  ta_am_cancel *cancel;
  ta_am_prepared *prepared;
  _Atomic int state;
  _Atomic int stage;
  _Atomic uint64_t started, elapsed[5];
  char reason[128];
#if defined(_WIN32)
  HANDLE thread;
#else
  pthread_t thread;
#endif
};
static atomic_flag worker_busy = ATOMIC_FLAG_INIT;
static void next_stage(ta_am_job* j, int stage) {
  uint64_t now = ta_am_clock_milliseconds();
  int previous = atomic_load(&j->stage);
  if (previous < 5) atomic_store(&j->elapsed[previous], now - atomic_load(&j->started));
  atomic_store(&j->started, now); atomic_store(&j->stage, stage);
}
static void run(ta_am_job *j) {
  ta_am_plan_spec spec;
  const float *pcm[2] = {NULL, NULL};
  size_t frames[2] = {0, 0};
  size_t wanted[2] = {0, 0}, reservation = 0;
  uint64_t first[2];
  atomic_store(&j->started, ta_am_clock_milliseconds());
  int result;
  if (j->request.has_selection) {
    spec = j->request.selection;
    result = ta_am_plan_valid(&spec, j->request.kernels) ? 1 : -1;
    if (result != 1) snprintf(j->reason, sizeof(j->reason), "invalid_selection_ticket");
  } else result = ta_am_select_after(&j->request.current, &j->request.next,
                                         j->request.mode, &j->request.binding,
                                         j->request.kernels, j->request.minimum_current_start, &spec, j->reason,
                                         sizeof(j->reason));
  if (result != 1)
    goto done;
  const ta_am_features *features[2] = {&j->request.current, &j->request.next};
  /* FFT look-behind/look-ahead is real decoded context; zero padding is allowed
   * only at a verified track boundary. */
  uint64_t context = (uint64_t)spec.binding.sample_rate * 2;
  for (unsigned deck = 0; deck < 2; deck++) {
    uint64_t start = deck ? spec.next_start : spec.current_start;
    uint64_t end = deck ? spec.next_end : spec.current_end;
    uint64_t boundary = (uint64_t)llround(features[deck]->duration_seconds *
                                          spec.binding.sample_rate);
    first[deck] = start > context ? start - context : 0;
    end = end + context < boundary ? end + context : boundary;
    wanted[deck] = (size_t)(end - first[deck]);
  }
  reservation = ta_am_preparation_reserve(&spec, wanted[0], wanted[1]);
  if (!reservation && spec.stem_enhanced) {
    spec.stem_enhanced = 0;
    reservation = ta_am_preparation_reserve(&spec, wanted[0], wanted[1]);
  }
  if (!reservation) {
    snprintf(j->reason, sizeof(j->reason), "preparation_memory_budget");
    goto done;
  }
  for (unsigned deck = 0; deck < 2; deck++) {
    next_stage(j, (int)deck + 1);
    if (ta_am_cancelled(j->cancel) || !wanted[deck] ||
        !j->io.decode(j->context, &spec, deck, first[deck], wanted[deck],
                      j->cancel, &pcm[deck], &frames[deck], j->reason,
                      sizeof(j->reason)))
      goto done;
    if (!pcm[deck] || frames[deck] != wanted[deck]) {
      snprintf(j->reason, sizeof(j->reason), "incomplete_decoded_boundary");
      goto done;
    }
  }
  if (spec.stem_enhanced && j->io.material_ready && !j->io.material_ready(j->context)) spec.stem_enhanced = 0;
  next_stage(j, 3);
  j->prepared = ta_am_prepare_reserved(
      &spec, pcm[0], frames[0], first[0], pcm[1], frames[1], first[1],
      j->request.kernels, j->cancel, reservation, j->reason, sizeof(j->reason));
  reservation = 0;
  next_stage(j, 4);
  if (j->prepared && !ta_am_cancelled(j->cancel) &&
      !j->io.continuation(j->context, &spec, j->cancel, j->reason,
                          sizeof(j->reason))) {
    ta_am_prepared_free(j->prepared);
    j->prepared = NULL;
  }
done:
  next_stage(j, 5);
  j->io.release_decoded(j->context);
  ta_am_preparation_abandon(reservation);
  ta_am_prepared_release_scratch_budget(j->prepared);
  if (ta_am_cancelled(j->cancel)) {
    ta_am_prepared_free(j->prepared);
    j->prepared = NULL;
    snprintf(j->reason, sizeof(j->reason),
             ta_am_cancel_reason(j->cancel) == 2 ? "preparation_timeout" : "preparation_cancelled");
    atomic_store_explicit(&j->state, TA_AM_JOB_CANCELLED, memory_order_release);
  } else {
    if (!j->prepared && !j->reason[0])
      snprintf(j->reason, sizeof(j->reason), "audio_preparation_failed");
    atomic_store_explicit(&j->state,
                          j->prepared ? TA_AM_JOB_READY : TA_AM_JOB_DEGRADED,
                          memory_order_release);
  }
  atomic_flag_clear_explicit(&worker_busy, memory_order_release);
}
#if defined(_WIN32)
static unsigned __stdcall entry(void *p) {
  run(p);
  return 0;
}
#else
static void *entry(void *p) {
  run(p);
  return NULL;
}
#endif
ta_am_job *ta_am_job_start(const ta_am_job_request *r, const ta_am_job_io *io,
                           void *ctx, char *reason, size_t n) {
  if (reason && n)
    reason[0] = 0;
  if (!r || !io || !io->decode || !io->continuation || !io->release_decoded ||
      !r->kernels || !ta_am_features_valid(&r->current) ||
      !ta_am_features_valid(&r->next)) {
    if (reason && n)
      snprintf(reason, n, "invalid_prepare_request");
    return NULL;
  }
  if (atomic_flag_test_and_set_explicit(&worker_busy, memory_order_acquire)) {
    if (reason && n)
      snprintf(reason, n, "preparation_worker_busy");
    return NULL;
  }
  ta_am_job *j = calloc(1, sizeof(*j));
  if (j)
    j->cancel = ta_am_cancel_create();
  if (!j || !j->cancel)
    goto fail;
  j->request = *r;
  j->io = *io;
  j->context = ctx;
  atomic_init(&j->state, TA_AM_JOB_PREPARING);
  atomic_init(&j->stage, 0);
  atomic_init(&j->started, 0);
  for (unsigned i = 0; i < 5; i++) atomic_init(&j->elapsed[i], 0);
  ta_am_cancel_set_timeout(j->cancel, r->timeout_ms);
#if defined(_WIN32)
  j->thread = (HANDLE)_beginthreadex(NULL, 0, entry, j, 0, NULL);
  if (!j->thread)
    goto fail;
#else
  if (pthread_create(&j->thread, NULL, entry, j))
    goto fail;
#endif
  return j;
fail:
  if (j) {
    ta_am_cancel_free(j->cancel);
    free(j);
  }
  atomic_flag_clear_explicit(&worker_busy, memory_order_release);
  if (reason && n)
    snprintf(reason, n, "preparation_worker_unavailable");
  return NULL;
}
ta_am_job_state ta_am_job_status(const ta_am_job *j) {
  return j ? (ta_am_job_state)atomic_load_explicit(&j->state,
                                                   memory_order_acquire)
           : TA_AM_JOB_CANCELLED;
}
void ta_am_job_cancel(ta_am_job *j) {
  if (j)
    ta_am_cancel_request(j->cancel);
}
ta_am_prepared *ta_am_job_take(ta_am_job *j) {
  if (!j)
    return NULL;
  int expected = TA_AM_JOB_READY;
  if (!atomic_compare_exchange_strong_explicit(
          &j->state, &expected, TA_AM_JOB_TAKEN, memory_order_acq_rel,
          memory_order_acquire))
    return NULL;
  if (ta_am_cancelled(j->cancel))
    return NULL;
  ta_am_prepared *p = j->prepared;
  j->prepared = NULL;
  return p;
}
const char *ta_am_job_reason(const ta_am_job *j) {
  return !j || ta_am_job_status(j) == TA_AM_JOB_PREPARING ? "" : j->reason;
}
const char *ta_am_job_stage(const ta_am_job *j) {
  static const char *stages[] = {"selection", "decode_current", "decode_next", "prepare", "continuation"};
  int stage = j ? atomic_load(&j->stage) : 0;
  return stages[stage >= 0 && stage < 5 ? stage : 0];
}
void ta_am_job_destroy(ta_am_job *j) {
  if (!j)
    return;
  ta_am_job_cancel(j);
#if defined(_WIN32)
  WaitForSingleObject(j->thread, INFINITE);
  CloseHandle(j->thread);
#else
  pthread_join(j->thread, NULL);
#endif
  ta_am_prepared_free(j->prepared);
  ta_am_cancel_free(j->cancel);
  free(j);
}

uint64_t ta_am_job_elapsed_ms(const ta_am_job* j, unsigned stage) {
  if (!j || stage >= 5) return 0;
  if ((unsigned)atomic_load(&j->stage) == stage && atomic_load(&j->started))
    return ta_am_clock_milliseconds() - atomic_load(&j->started);
  return atomic_load(&j->elapsed[stage]);
}
