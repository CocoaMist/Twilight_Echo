#pragma once
#include <cstddef>
#include <span>
#include <vector>

namespace twilight::automix {
struct Spectrogram {
  std::size_t frames{}, bins{};
  std::vector<float> values; // frame-major; no Apple native indexes
};
struct BeatEvents {
  std::vector<double> beats, downbeats; // seconds relative to analyzed window
};
// Preparation/analysis thread only. Input is already mono at the exact model rate.
Spectrogram beatThisFrontend(std::span<const float> mono22050);
Spectrogram yamnetFrontend(std::span<const float> mono16000);
BeatEvents beatThisPostprocess(std::span<const float> beats, std::span<const float> downbeats);
} // namespace twilight::automix
