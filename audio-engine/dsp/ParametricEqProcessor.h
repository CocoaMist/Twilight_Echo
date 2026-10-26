#pragma once

#include "IAudioProcessor.h"

#include <vector>

namespace twilight::audio {

class ParametricEqProcessor final : public IAudioProcessor {
 public:
  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext& context) override;
  void process(float* samples, size_t frameCount) override;
  void processDouble(double* samples, size_t frameCount) override;
  void reset() override;
  bool isActive() const override;

  struct Biquad {
    double b0 = 1.0;
    double b1 = 0.0;
    double b2 = 0.0;
    double a1 = 0.0;
    double a2 = 0.0;
  };

  struct BiquadState {
    double z1 = 0.0;
    double z2 = 0.0;

    float process(float input, const Biquad& coeffs);
    double processDouble(double input, const Biquad& coeffs);
    void reset();
  };

  struct FilterBand {
    Biquad coeffs;
    std::vector<BiquadState> channelStates;
    uint32_t channelMask = 0xffffffffu;
  };

 private:
  void rebuildFilters();
  DspConfig config_;
  AudioFormat format_;
  std::vector<FilterBand> filters_;
  double preampLinear_ = 1.0;
  bool active_ = false;
};

}  // namespace twilight::audio
