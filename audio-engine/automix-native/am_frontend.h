#ifndef TWILIGHT_AM_FRONTEND_H
#define TWILIGHT_AM_FRONTEND_H
#include "am_kernels.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef enum { TA_AM_BEAT_THIS = 1, TA_AM_YAMNET = 2 } ta_am_model_kind;
typedef struct ta_am_frontend ta_am_frontend;
ta_am_frontend *ta_am_frontend_create(ta_am_model_kind, const ta_am_kernels *);
void ta_am_frontend_free(ta_am_frontend *);
/* Mono at 22050 Hz (Beat This) / 16000 Hz (YAMNet). Output is frame-major.
 * Beat This uses centered reflect padding; YAMNet uses end zero padding.
 * Source offset is measured in samples. Allocate frames * 128/64 floats. */
int ta_am_frontend_process(ta_am_frontend *, const float *, size_t samples, size_t offset,
                           size_t frames, float *mel);
#ifdef __cplusplus
}
#endif
#endif
