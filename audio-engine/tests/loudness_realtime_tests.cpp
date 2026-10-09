#include "../dsp/DspWorkspaceProcessors.h"
#include <ebur128.h>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

using namespace twilight::audio;
#if defined(TAE_TEST_WRAP_ALLOCATORS)
static bool tracking = false;
static size_t allocations = 0, releases = 0;
extern "C" void* __real_malloc(size_t);
extern "C" void* __real_calloc(size_t, size_t);
extern "C" void __real_free(void*);
extern "C" void* __wrap_malloc(size_t n) { if (tracking) ++allocations; return __real_malloc(n); }
extern "C" void* __wrap_calloc(size_t n, size_t size) { if (tracking) ++allocations; return __real_calloc(n, size); }
extern "C" void __wrap_free(void* pointer) { if (tracking && pointer) ++releases; __real_free(pointer); }
#endif

int main() {
  LoudnessMeterProcessor meter;
  DspConfig config; config.enabled = true; config.meterEnabled = true;
  AudioFormat format; format.sampleRate = 48000; format.channelCount = 2;
  meter.configure(config); meter.prepare(format);
  const int modes = EBUR128_MODE_I | EBUR128_MODE_LRA | EBUR128_MODE_M | EBUR128_MODE_S;
  auto* reference = ebur128_init(2, 48000, modes);
  assert(reference);
  std::vector<float> signal(512);
  for (size_t block = 0; block < 180 * 48000 / 256; ++block) {
    const float amplitude = (block / 1875) % 3 == 0 ? .04f : .2f;
    for (size_t frame = 0; frame < 256; ++frame) {
      const auto value = amplitude * std::sin((block * 256 + frame) * .13);
      signal[2 * frame] = signal[2 * frame + 1] = value;
    }
    meter.process(signal.data(), 256);
    assert(ebur128_add_frames_float(reference, signal.data(), 256) == 0);
  }
  double integrated = 0, range = 0, momentary = 0, shortTerm = 0;
  assert(ebur128_loudness_global(reference, &integrated) == 0);
  assert(ebur128_loudness_range(reference, &range) == 0);
  assert(ebur128_loudness_momentary(reference, &momentary) == 0);
  assert(ebur128_loudness_shortterm(reference, &shortTerm) == 0);
  assert(std::abs(meter.integratedLufs() - integrated) <= .1);
  assert(std::abs(meter.loudnessRangeLu() - range) <= .2);
  assert(std::abs(meter.momentaryLufs() - momentary) <= .00001);
  assert(std::abs(meter.shortTermLufs() - shortTerm) <= .00001);
  ebur128_destroy(&reference);
  meter.reset();
  assert(!std::isfinite(meter.integratedLufs()));
#if defined(TAE_TEST_WRAP_ALLOCATORS)
  tracking = true;
#endif
  for (size_t block = 0; block < 600 * 48000 / 256; ++block) {
    meter.process(signal.data(), 256);
    if (block % 1875 == 0) {
      (void)meter.integratedLufs(); (void)meter.loudnessRangeLu();
    }
  }
#if defined(TAE_TEST_WRAP_ALLOCATORS)
  tracking = false;
  assert(allocations == 0 && releases == 0);
#endif
  std::printf("loudness reference tolerances and ten-minute allocation test passed\n");
}
