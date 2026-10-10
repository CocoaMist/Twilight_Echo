#pragma once
#include <vector>
#include <span>

namespace twilight::automix {
inline constexpr int analysisVersion=4;
struct StableRegion {double start,end,bpm,confidence;};
std::vector<StableRegion> stableBeatRegions(const std::vector<double>& beats);
std::vector<double> regionalEnergyDbfs(std::span<const float> pcm,unsigned channels,unsigned sampleRate);
}
