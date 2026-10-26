#pragma once

#include "IAudioProcessor.h"

#include <vector>

namespace twilight::audio {

class CrossfeedProcessor final : public IAudioProcessor {
 public:
  void configure(const DspConfig& config) override;
  void prepare(const AudioFormat& format) override;
  void setTrackContext(const DspTrackContext& context) override;
  void process(float* samples, size_t frameCount) override;
  void processDouble(double* samples, size_t frameCount) override;
  void reset() override;
  bool isActive() const override;

  double strength() const;

 private:
  void rebuildDelay();

  DspConfig config_;
  AudioFormat format_;
  std::vector<float> delayLeft_;
  std::vector<float> delayRight_;
  size_t delayIndex_ = 0;
  double lowpassLeft_ = 0.0;
  double lowpassRight_ = 0.0;
  double alpha_ = 0.0;
  bool active_ = false;
};

}  // namespace twilight::audio
