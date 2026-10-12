#ifndef TWILIGHT_AM_HASH_H
#define TWILIGHT_AM_HASH_H
#include "am_cancel.h"
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
void ta_am_sha256(const void *bytes, size_t count, char hex[65]);
int ta_am_sha256_file(const char *utf8_path, char hex[65]);
typedef struct {
  uint64_t size, modified, created, file_index;
  uint32_t volume;
} ta_am_source_stamp;
typedef struct ta_am_source_lease ta_am_source_lease;
int ta_am_source_snapshot(const char *, ta_am_source_stamp *);
int ta_am_source_stamp_equal(const ta_am_source_stamp *,
                             const ta_am_source_stamp *);
/* Windows: deny writes/replacement while a verified plan is retained. Acquire
 * on worker, release after callback ACK. Remote URLs are never treated as
 * files. */
ta_am_source_lease *ta_am_source_acquire(const char *,
                                         const ta_am_source_stamp *,
                                         const char expected_sha256[65],
                                         const ta_am_cancel *);
void ta_am_source_release(ta_am_source_lease *);
#ifdef __cplusplus
}
#endif
#endif
