#pragma once

#include "DspTypes.h"

#include <cstddef>
#include <vector>

namespace twilight::audio {

class IAudioProcessor {
 public:
  virtual ~IAudioProcessor() = default;

  virtual void configure(const DspConfig& config) = 0;
  virtual void prepare(const AudioFormat& format) = 0;
  virtual void setTrackContext(const DspTrackContext& context) = 0;
  virtual void process(float* samples, size_t frameCount) = 0;

  /**
   * 64-bit Float (double) internal DSP pipeline entry point.
   * Built-in audiophile processors override this to avoid intermediate 32-bit
   * float quantization; float-only bridges (e.g. VST3) fall back to the default
   * conversion wrapper.
   */
  virtual void processDouble(double* samples, size_t frameCount) {
    if (!samples || frameCount == 0 || !isActive()) return;
    // Conservative default bridge for float32-only processors (up to 8 channels).
    constexpr size_t kMaxChannels = 8;
    const size_t totalSamples = frameCount * kMaxChannels;
    std::vector<float> temp(totalSamples);
    for (size_t i = 0; i < totalSamples; ++i) {
      temp[i] = static_cast<float>(samples[i]);
    }
    process(temp.data(), frameCount);
    for (size_t i = 0; i < totalSamples; ++i) {
      samples[i] = static_cast<double>(temp[i]);
    }
  }

  virtual void reset() = 0;
  virtual bool isActive() const = 0;
};

}  // namespace twilight::audio
