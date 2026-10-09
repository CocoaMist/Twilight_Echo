#pragma once
#include <memory>
extern "C" {
#include "recovered/am_timing.h"
}
namespace twilight::automix {
// Independent effects; no Apple AU state, and no user DSP settings.
class TransitionEffects {
public:
  TransitionEffects(unsigned sampleRate,unsigned channels,const am_side* automations);
  ~TransitionEffects();
  TransitionEffects(const TransitionEffects&)=delete;
  void process(float* frame,double sourceTime,double bpm);
  std::size_t memoryBytes() const noexcept;
  static std::size_t maximumMemoryBytes(unsigned sampleRate,unsigned channels,const am_side* automations) noexcept;
private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}
