#ifndef TWILIGHT_AM_HANDOFF_H
#define TWILIGHT_AM_HANDOFF_H
#include "am_plan.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Render-owned state. The host retains the immutable prepared plan through its
 * callback ACK epoch. These functions never allocate, lock, access files or
 * IPC. */
typedef struct {
  const ta_am_prepared *prepared;
  uint64_t output_frame, source_frame[2];
  unsigned promotion_delivered;
} ta_am_handoff;
typedef struct {
  uint64_t output_frame, source_begin[2], source_end[2];
  size_t frames;
  const float *lane[2];
} ta_am_handoff_span;
int ta_am_binding_matches(const ta_am_binding *, const ta_am_binding *);
int ta_am_handoff_begin(ta_am_handoff *, const ta_am_prepared *,
                        const ta_am_binding *, uint64_t current_source_frame);
/* A paused or stale binding yields no span and consumes no source/output
 * frames. */
size_t ta_am_handoff_peek(const ta_am_handoff *, const ta_am_binding *,
                          size_t wanted, unsigned paused, ta_am_handoff_span *);
/* Only commit after both prepared decks were processed/mixed and the host has
 * discarded the mapped outgoing source frames. Returns promotion once only. */
int ta_am_handoff_commit(ta_am_handoff *, const ta_am_handoff_span *);
void ta_am_handoff_cancel(ta_am_handoff *);
#ifdef __cplusplus
}
#endif
#endif
