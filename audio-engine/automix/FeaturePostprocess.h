#pragma once
#include <vector>

namespace twilight::automix {
inline constexpr int analysisVersion=3;
struct StableRegion {double start,end,bpm,confidence;};
std::vector<StableRegion> stableBeatRegions(const std::vector<double>& beats);
}
