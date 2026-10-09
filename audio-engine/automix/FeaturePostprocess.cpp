#include "FeaturePostprocess.h"
#include <algorithm>
#include <array>
#include <cmath>

namespace twilight::automix {
namespace {
double median(std::array<double,8> values) {
  std::sort(values.begin(),values.end());return (values[3]+values[4])*.5;
}
}
std::vector<StableRegion> stableBeatRegions(const std::vector<double>& beats) {
  std::vector<StableRegion> result;
  if(beats.size()<9||!std::all_of(beats.begin(),beats.end(),[](double t){return std::isfinite(t)&&t>=0;}))return result;
  for(size_t i=1;i<beats.size();++i)if(beats[i]<=beats[i-1])return result;
  const auto append=[&](size_t first) {
    std::array<double,8> intervals{},deviations{};
    for(size_t i=0;i<8;++i)intervals[i]=beats[first+i+1]-beats[first+i];
    const double period=median(intervals),bpm=60/period;
    if(bpm<40||bpm>300)return;
    for(size_t i=0;i<8;++i)deviations[i]=std::abs(intervals[i]-period)/period;
    const double deviation=median(deviations);
    if(deviation>.04)return;
    StableRegion region{beats[first],beats[first+8],bpm,std::clamp(1-deviation/.04,0.,1.)};
    // Merge only touching/overlapping confident intervals. A failed window
    // leaves a gap; tempo changes and low confidence remain separate.
    if(!result.empty()) {
      auto& previous=result.back();
      if(region.start<=previous.end+.02&&region.confidence>=.8&&previous.confidence>=.8&&std::abs(std::log(region.bpm/previous.bpm))<=.01) {
        previous.end=std::max(previous.end,region.end);
        previous.confidence=std::min(previous.confidence,region.confidence);return;
      }
    }
    result.push_back(region);
  };
  for(size_t first=0;first+8<beats.size();first+=8)append(first);
  // Retain the final complete eight-interval window even when the number of
  // events is not a multiple of eight. Never invent events after the last beat.
  const size_t last=beats.size()-9;
  if(last%8)append(last);
  return result;
}
}
