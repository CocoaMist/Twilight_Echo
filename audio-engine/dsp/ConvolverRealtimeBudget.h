#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>

namespace twilight::audio::convolver {

// Count periodic partition overruns too: cheap callbacks between them do not
// erase evidence. Storage is fixed and observe() never allocates.
class RealtimeBudget {
 public:
  static double milliseconds(size_t frames, int sampleRate) {
    return sampleRate > 0 ? static_cast<double>(frames) * 800.0 / sampleRate : 0.0;
  }

  bool observe(bool exceeded, size_t frames, int sampleRate, uint32_t partitionSize) {
    position_ += frames;
    const uint64_t window = std::max<uint64_t>(4ULL * partitionSize,
        static_cast<uint64_t>(std::max(1, sampleRate)) / 4);
    while (count_ > 0 && position_ - overruns_[head_] > window) {
      head_ = (head_ + 1) % overruns_.size();
      --count_;
    }
    if (!exceeded) return false;
    overruns_[(head_ + count_) % overruns_.size()] = position_;
    if (count_ < overruns_.size()) ++count_;
    return count_ == overruns_.size();
  }

  void reset() { position_ = 0; head_ = 0; count_ = 0; }

 private:
  std::array<uint64_t, 3> overruns_{};
  uint64_t position_ = 0;
  size_t head_ = 0;
  size_t count_ = 0;
};

}  // namespace twilight::audio::convolver
