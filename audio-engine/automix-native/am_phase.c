/* Complete C11 oracle for linked phase transport. MIT Signalsmith adaptation;
 * production dispatch uses the separately handwritten NASM implementation. */
#include "am_kernels.h"
#include <math.h>
#include <stddef.h>
#include <stdint.h>
#if defined(_WIN64)
_Static_assert(offsetof(ta_am_phase_state, current) == 24, "phase ABI");
_Static_assert(offsetof(ta_am_phase_state, previous_energies) == 64,
               "phase ABI");
#endif
static ta_am_complex mul(ta_am_complex a, ta_am_complex b, unsigned conjugate) {
  if (conjugate)
    b.i = -b.i;
  return (ta_am_complex){a.r * b.r - a.i * b.i, a.r * b.i + a.i * b.r};
}
static ta_am_complex scale(ta_am_complex a, float gain) {
  return (ta_am_complex){a.r * gain, a.i * gain};
}
static ta_am_complex add(ta_am_complex a, ta_am_complex b) {
  return (ta_am_complex){a.r + b.r, a.i + b.i};
}
static float energy(ta_am_complex a) { return a.r * a.r + a.i * a.i; }
static ta_am_complex normalise(ta_am_complex phase, ta_am_complex input,
                               float e) {
  float norm = energy(phase);
  if (norm <= 1e-15f) {
    phase = input;
    norm = energy(input) + 1e-15f;
  }
  return scale(phase, sqrtf(e / norm));
}
static ta_am_complex fractional(const ta_am_complex *input, size_t bins,
                                double pos) {
  int64_t low = (int64_t)floor(pos);
  float f = (float)(pos - low);
  ta_am_complex a = {0}, b = {0};
  if (low >= 0 && (uint64_t)low < bins)
    a = input[low];
  if (low + 1 >= 0 && (uint64_t)(low + 1) < bins)
    b = input[low + 1];
  return add(a, scale((ta_am_complex){b.r - a.r, b.i - a.i}, f));
}
void ta_am_c_phase(ta_am_phase_state *s) {
  size_t bins = s->bins;
  for (unsigned c = 0; c < s->channels; c++)
    for (size_t b = 0; b < bins; b++) {
      size_t i = c * bins + b;
      float e = energy(s->current[i]);
      s->energies[i] = e;
      ta_am_complex previous = mul(s->previous[i], s->rotation[b], 0),
                    out = mul(s->output[i], s->rotation[b], 0),
                    twist = mul(s->current[i], previous, 1);
      s->output[i] = scale(mul(out, twist, 0),
                           1 / (fmaxf(e, s->previous_energies[i]) + 1e-15f));
    }
  for (size_t b = 0; b < bins; b++) {
    unsigned max = 0;
    for (unsigned c = 1; c < s->channels; c++)
      if (s->energies[c * bins + b] > s->energies[max * bins + b])
        max = c;
    const ta_am_complex *input = s->current + max * bins;
    ta_am_complex *out = s->output + max * bins, phase = {0};
    if (b > 0)
      phase =
          add(phase,
              mul(out[b - 1],
                  mul(input[b],
                      fractional(input, bins, (double)b - s->time_factor), 1),
                  0));
    if (b >= s->long_step)
      phase = add(phase,
                  mul(out[b - s->long_step],
                      mul(input[b],
                          fractional(input, bins,
                                     (double)b - s->long_step * s->time_factor),
                          1),
                      0));
    if (b + 1 < bins)
      phase = add(
          phase,
          mul(out[b + 1],
              mul(input[b + 1],
                  fractional(input, bins, (double)b + 1 - s->time_factor), 1),
              1));
    if (b + s->long_step < bins)
      phase = add(phase, mul(out[b + s->long_step],
                             mul(input[b + s->long_step],
                                 fractional(input, bins,
                                            (double)b + s->long_step -
                                                s->long_step * s->time_factor),
                                 1),
                             1));
    out[b] = normalise(phase, input[b], s->energies[max * bins + b]);
    for (unsigned c = 0; c < s->channels; c++)
      if (c != max) {
        size_t j = c * bins + b;
        ta_am_complex value = s->current[j];
        if (value.r == input[b].r && value.i == input[b].i)
          s->output[j] = out[b];
        else if (value.r == -input[b].r && value.i == -input[b].i)
          s->output[j] = scale(out[b], -1);
        else
          s->output[j] = normalise(mul(out[b], mul(value, input[b], 1), 0),
                                   value, s->energies[j]);
      }
  }
}
