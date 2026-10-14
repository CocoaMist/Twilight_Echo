#include "am_handoff.h"
#include <string.h>

int ta_am_binding_matches(const ta_am_binding *a, const ta_am_binding *b) {
  return a && b && a->plan_id == b->plan_id &&
         a->queue_revision == b->queue_revision &&
         a->playback_generation == b->playback_generation &&
         a->format_revision == b->format_revision &&
         a->sample_rate == b->sample_rate && a->channels == b->channels &&
         !memcmp(a->current_identity, b->current_identity, 65) &&
         !memcmp(a->next_identity, b->next_identity, 65);
}
int ta_am_handoff_begin(ta_am_handoff *s, const ta_am_prepared *p,
                        const ta_am_binding *binding, uint64_t source) {
  const ta_am_plan_spec *spec = ta_am_prepared_spec(p);
  if (!s || !spec || s->prepared ||
      !ta_am_binding_matches(&spec->binding, binding) ||
      source != spec->current_start)
    return 0;
  memset(s, 0, sizeof(*s));
  s->prepared = p;
  s->source_frame[0] = spec->current_start;
  s->source_frame[1] = spec->next_start;
  return 1;
}
size_t ta_am_handoff_peek(const ta_am_handoff *s, const ta_am_binding *binding,
                          size_t wanted, unsigned paused,
                          ta_am_handoff_span *span) {
  if (span)
    memset(span, 0, sizeof(*span));
  const ta_am_plan_spec *spec = s ? ta_am_prepared_spec(s->prepared) : NULL;
  if (!span || !spec || paused || !wanted ||
      !ta_am_binding_matches(&spec->binding, binding) ||
      s->output_frame >= spec->output_frames)
    return 0;
  uint64_t remaining = spec->output_frames - s->output_frame;
  span->frames = wanted < remaining ? wanted : (size_t)remaining;
  span->output_frame = s->output_frame;
  for (unsigned deck = 0; deck < 2; deck++) {
    span->source_begin[deck] = s->source_frame[deck];
    span->source_end[deck] = ta_am_prepared_source_frame(
        s->prepared, deck, (double)(s->output_frame + span->frames));
    span->lane[deck] = ta_am_prepared_lane(s->prepared, deck) +
                       (size_t)s->output_frame * spec->binding.channels;
  }
  return span->frames;
}
int ta_am_handoff_commit(ta_am_handoff *s, const ta_am_handoff_span *span) {
  const ta_am_plan_spec *spec = s ? ta_am_prepared_spec(s->prepared) : NULL;
  if (!spec || !span || !span->frames ||
      span->output_frame != s->output_frame ||
      s->output_frame > spec->output_frames ||
      span->frames > spec->output_frames - s->output_frame)
    return 0;
  for (unsigned deck = 0; deck < 2; deck++)
    if (span->source_begin[deck] != s->source_frame[deck] ||
        span->source_end[deck] !=
            ta_am_prepared_source_frame(s->prepared, deck,
                                    (double)(s->output_frame + span->frames)))
      return 0;
  s->output_frame += span->frames;
  s->source_frame[0] = span->source_end[0];
  s->source_frame[1] = span->source_end[1];
  if (s->output_frame == spec->output_frames && !s->promotion_delivered) {
    s->promotion_delivered = 1;
    return 1;
  }
  return 0;
}
void ta_am_handoff_cancel(ta_am_handoff *s) {
  if (s) {
    /* Preserve consumed source clocks so cancellation resumes the active deck
     * from the same mapped position reported for lyrics and progress. */
    s->prepared = NULL;
    s->output_frame = 0;
    s->promotion_delivered = 0;
  }
}
