#ifndef TWILIGHT_AM_CANCEL_H
#define TWILIGHT_AM_CANCEL_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct ta_am_cancel ta_am_cancel;
ta_am_cancel *ta_am_cancel_create(void);
/* Set before handing the token to another thread; zero disables deadline. */
void ta_am_cancel_set_timeout(ta_am_cancel *, unsigned milliseconds);
void ta_am_cancel_request(ta_am_cancel *);
int ta_am_cancelled(const ta_am_cancel *);
/* 1: explicit cancellation, 2: deadline expired, 0: still active. */
uint64_t ta_am_clock_milliseconds(void);
int ta_am_cancel_reason(const ta_am_cancel *);
/* Free only after the owning worker has returned. */
void ta_am_cancel_free(ta_am_cancel *);
#ifdef __cplusplus
}
#endif
#endif
