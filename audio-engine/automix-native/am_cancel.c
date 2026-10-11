#include "am_cancel.h"

#include <stdatomic.h>
#include <stdlib.h>
#if defined(_WIN32)
#include <windows.h>
#else
#include <time.h>
#endif
struct ta_am_cancel {
  _Atomic int value;
  uint64_t deadline;
};
uint64_t ta_am_clock_milliseconds(void) {
#if defined(_WIN32)
  return GetTickCount64();
#else
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000;
#endif
}
ta_am_cancel *ta_am_cancel_create(void) {
  ta_am_cancel *c = malloc(sizeof(*c));
  if (c) {
    atomic_init(&c->value, 0);
    c->deadline = 0;
  }
  return c;
}
void ta_am_cancel_request(ta_am_cancel *c) {
  if (c)
    atomic_store_explicit(&c->value, 1, memory_order_relaxed);
}
int ta_am_cancelled(const ta_am_cancel *c) {
  return c && (atomic_load_explicit(&c->value, memory_order_relaxed) ||
               (c->deadline && ta_am_clock_milliseconds() >= c->deadline));
}
int ta_am_cancel_reason(const ta_am_cancel *c) {
  if (!c) return 0;
  if (atomic_load_explicit(&c->value, memory_order_relaxed)) return 1;
  return c->deadline && ta_am_clock_milliseconds() >= c->deadline ? 2 : 0;
}
void ta_am_cancel_set_timeout(ta_am_cancel *c, unsigned ms) {
  if (c)
    c->deadline = ms ? ta_am_clock_milliseconds() + ms : 0;
}
void ta_am_cancel_free(ta_am_cancel *c) { free(c); }
