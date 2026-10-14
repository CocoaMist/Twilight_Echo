#include "am_hash.h"
#include "am_job.h"
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(_WIN32)
#include <windows.h>
#else
#include <time.h>
#endif
static void sleep_ms(void) {
#if defined(_WIN32)
  Sleep(1);
#else
  struct timespec t = {0, 1000000};
  nanosleep(&t, NULL);
#endif
}
static void check(int ok, const char *why) {
  if (!ok) {
    fprintf(stderr, "FAIL: %s\n", why);
    exit(1);
  }
}
typedef struct {
  _Atomic int entered, block;
  float *pcm[2];
  unsigned releases, continuations;
} context;
static int decode(void *p, const ta_am_plan_spec *s, unsigned deck,
                  uint64_t first, size_t wanted, const ta_am_cancel *cancel,
                  const float **pcm, size_t *frames, char *reason, size_t n) {
  (void)first;
  (void)reason;
  (void)n;
  context *c = p;
  atomic_store(&c->entered, 1);
  while (atomic_load(&c->block) && !ta_am_cancelled(cancel))
    sleep_ms();
  if (ta_am_cancelled(cancel))
    return 0;
  c->pcm[deck] = calloc(wanted * s->binding.channels, sizeof(float));
  *pcm = c->pcm[deck];
  *frames = wanted;
  return *pcm != NULL;
}
static int continuation(void *p, const ta_am_plan_spec *s,
                        const ta_am_cancel *cancel, char *why, size_t n) {
  (void)why;
  (void)n;
  (void)s;
  ((context *)p)->continuations++;
  return !ta_am_cancelled(cancel);
}
static void release(void *p) {
  context *c = p;
  for (unsigned i = 0; i < 2; i++) {
    free(c->pcm[i]);
    c->pcm[i] = NULL;
  }
  c->releases++;
}
static void features(ta_am_features *f, int tail) {
  memset(f, 0, sizeof(*f));
  f->duration_seconds = 90;
  f->start_seconds = tail ? 60 : 0;
  f->end_seconds = f->start_seconds + 30;
  f->bpm = 120;
  f->tempo_confidence = .9f;
  f->rms_db = -12;
  f->peak = .4f;
  f->key = -1;
  for (unsigned i = 0; i < 60; i++)
    f->beats[f->beat_count++] = f->start_seconds + .5 * i;
  f->frame_count = 1500;
  for (unsigned i = 0; i < 1500; i++) {
    f->frame_db[i] = -12;
    f->frame_peak[i] = .4f;
  }
}
int main(void) {
  ta_am_job_request *r = calloc(1, sizeof(*r));
  check(r != NULL, "request allocation");
  features(&r->current, 1);
  features(&r->next, 0);
  r->mode = TA_AM_NATURAL;
  r->kernels = ta_am_get_kernels(TA_AM_SSE2);
  r->binding.sample_rate = 8000;
  r->binding.channels = 2;
  r->binding.plan_id = 5;
  memset(r->binding.current_identity, 'a', 64);
  memset(r->binding.next_identity, 'b', 64);
  ta_am_job_io io = {decode, continuation, release};
  char why[128];
  context c = {0};
  atomic_store(&c.block, 1);
  ta_am_job *j = ta_am_job_start(r, &io, &c, why, sizeof(why));
  check(j != NULL, why);
  for (unsigned t = 0; t < 2000 && !atomic_load(&c.entered); t++)
    sleep_ms();
  check(atomic_load(&c.entered), "worker entered decode");
  check(!ta_am_job_start(r, &io, &c, why, sizeof(why)) &&
            !strcmp(why, "preparation_worker_busy"),
        "single worker budget");
  ta_am_job_cancel(j);
  ta_am_job_destroy(j);
  check(c.releases == 1 && c.continuations == 0,
        "cancel releases decoded resources and never publishes continuation");
  memset(&c, 0, sizeof(c));
  atomic_init(&c.block, 0);
  atomic_init(&c.entered, 0);
  j = ta_am_job_start(r, &io, &c, why, sizeof(why));
  check(j != NULL, why);
  for (unsigned t = 0; t < 5000 && ta_am_job_status(j) == TA_AM_JOB_PREPARING;
       t++)
    sleep_ms();
  check(ta_am_job_status(j) == TA_AM_JOB_READY, ta_am_job_reason(j));
  ta_am_prepared *p = ta_am_job_take(j);
  check(p && !ta_am_job_take(j), "take transfers ownership once");
  ta_am_job_destroy(j);
  check(c.releases == 1 && c.continuations == 1 &&
            ta_am_prepared_spec(p)->binding.plan_id == 5,
        "prepared audio survives joined worker");
  ta_am_prepared_free(p);
  memset(&c, 0, sizeof(c));
  atomic_init(&c.block, 1);
  atomic_init(&c.entered, 0);
  r->timeout_ms = 30;
  j = ta_am_job_start(r, &io, &c, why, sizeof(why));
  check(j != NULL, why);
  for (unsigned t = 0; t < 2000 && ta_am_job_status(j) == TA_AM_JOB_PREPARING;
       t++)
    sleep_ms();
  check(ta_am_job_status(j) == TA_AM_JOB_CANCELLED && !ta_am_job_take(j),
        "deadline interrupts decode without publication");
  ta_am_job_destroy(j);
  check(c.releases == 1, "deadline releases resources");
#if defined(_WIN32)
  const char *path = "automix-source-identity-test.bin";
  FILE *file = fopen(path, "wb");
  check(file != NULL, "source fixture");
  fwrite("abc", 1, 3, file);
  fclose(file);
  ta_am_source_stamp stamp;
  check(ta_am_source_snapshot(path, &stamp), "source stamp");
  char hash[65];
  ta_am_sha256("abc", 3, hash);
  ta_am_source_lease *lease = ta_am_source_acquire(path, &stamp, hash, NULL);
  check(lease != NULL, "hash matches actual locked source");
  HANDLE writer =
      CreateFileA(path, GENERIC_WRITE,
                  FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                  OPEN_EXISTING, 0, NULL);
  check(writer == INVALID_HANDLE_VALUE && !DeleteFileA(path),
        "lease denies modification/replacement");
  ta_am_source_release(lease);
  file = fopen(path, "wb");
  check(file != NULL, "source writable after lease");
  fwrite("changed", 1, 7, file);
  fclose(file);
  check(!ta_am_source_acquire(path, &stamp, hash, NULL),
        "changed source rejected");
  check(DeleteFileA(path), "source fixture cleanup");
#endif
  free(r);
  puts("PASS C worker concurrency, cancellation, deadline, ownership and "
       "actual source leases");
  return 0;
}
