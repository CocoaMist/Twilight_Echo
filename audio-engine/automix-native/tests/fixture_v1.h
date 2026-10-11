/* Explicit conversion of the frozen v1 development corpus. Never reinterpret bytes. */
#ifndef TA_AM_FIXTURE_V1_H
#define TA_AM_FIXTURE_V1_H
typedef struct {
  double start_seconds, end_seconds, duration_seconds;
  uint32_t complete, beat_count, downbeat_count, voice_count;
  float bpm, tempo_confidence, rms_db, peak, key_confidence;
  int32_t key;
  double beats[1500], downbeats[1500];
  float voice[64], music[64];
  double voice_start[64], voice_end[64];
  float frame_db[1500], frame_peak[1500];
  uint32_t frame_count;
} ta_am_fixture_v1;
_Static_assert(sizeof(ta_am_fixture_v1) == 37608, "frozen v1 fixture ABI");
static int read_feature_fixture(FILE* in, ta_am_features* f) {
  fseek(in, 0, SEEK_END); long n = ftell(in); rewind(in);
  memset(f, 0, sizeof(*f));
  if (n == (long)sizeof(*f)) return fread(f, sizeof(*f), 1, in) == 1;
  if (n != (long)sizeof(ta_am_fixture_v1)) return 0;
  ta_am_fixture_v1* old = malloc(sizeof(*old));
  if (!old || fread(old, sizeof(*old), 1, in) != 1) { free(old); return 0; }
  if (old->beat_count > 1500 || old->downbeat_count > 1500 || old->voice_count > 64 || old->frame_count > 1500) { free(old); return 0; }
  memcpy(f, old, 64);
  memcpy(f->beats, old->beats, old->beat_count * sizeof(double));
  memcpy(f->downbeats, old->downbeats, old->downbeat_count * sizeof(double));
  memcpy(f->voice, old->voice, old->voice_count * sizeof(float));
  memcpy(f->music, old->music, old->voice_count * sizeof(float));
  memcpy(f->voice_start, old->voice_start, old->voice_count * sizeof(double));
  memcpy(f->voice_end, old->voice_end, old->voice_count * sizeof(double));
  memcpy(f->frame_db, old->frame_db, old->frame_count * sizeof(float));
  memcpy(f->frame_peak, old->frame_peak, old->frame_count * sizeof(float));
  f->frame_count = old->frame_count;
  free(old); return 1;
}
#endif
