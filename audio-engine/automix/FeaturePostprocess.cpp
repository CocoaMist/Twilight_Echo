#include "FeaturePostprocess.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>

namespace twilight::automix {
std::vector<double> regionalEnergyDbfs(std::span<const float> pcm,unsigned channels,unsigned sampleRate) {
  if(!channels||channels>2||sampleRate<44100||sampleRate>192000||sampleRate%50||pcm.size()%channels)
    throw std::invalid_argument("unsupported_energy_format");
  const size_t frames=pcm.size()/channels,hop=sampleRate/50;
  std::vector<double> result;result.reserve((frames+hop-1)/hop);
  for(size_t first=0;first<frames;first+=hop) {
    const auto end=std::min(frames,first+hop);double energy=0;
    for(unsigned channel=0;channel<channels;++channel) {
      double sum=0;for(size_t i=first;i<end;++i) {
        const double x=pcm[i*channels+channel];if(!std::isfinite(x))throw std::invalid_argument("non_finite_energy");sum+=x*x;
      }
      energy=std::max(energy,sum/(end-first));
    }
    result.push_back(std::max(-120.,10*std::log10(std::max(1e-12,energy))));
  }
  return result;
}
std::vector<StableRegion> stableBeatRegions(const std::vector<double>& beats) {
  std::vector<StableRegion> result;
  if(beats.size()<9||!std::all_of(beats.begin(),beats.end(),[](double t){return std::isfinite(t)&&t>=0;}))return result;
  for(size_t i=1;i<beats.size();++i)if(beats[i]<=beats[i-1])return result;
  const auto append=[&](size_t first) {
    std::array<double,8> intervals{};
    for(size_t i=0;i<8;++i)intervals[i]=beats[first+i+1]-beats[first+i];
    // Fit the observed span, rather than quantizing tempo to one 20 ms
    // inter-beat interval. A 140 BPM grid alternates 420/440 ms on the model's
    // 50 Hz clock even though its musical tempo is constant.
    const double period=(beats[first+8]-beats[first])/8,bpm=60/period;
    if(bpm<40||bpm>300)return;
    double maximumPhaseError=0;
    for(size_t i=0;i<8;++i) {
      // One endpoint frame of quantization is tolerated; actual missed,
      // doubled or irregular beats must still reject the whole window.
      if(std::abs(intervals[i]-period)>.02+.04*period)return;
      maximumPhaseError=std::max(maximumPhaseError,std::abs(beats[first+i+1]-(beats[first]+(i+1)*period)));
    }
    const double deviation=std::max(0.,maximumPhaseError-.02)/period;
    if(deviation>.04)return;
    StableRegion region{beats[first],beats[first+8],bpm,std::clamp(1-deviation/.04,0.,1.)};
    // Merge only touching/overlapping confident intervals. A failed window
    // leaves a gap; tempo changes and low confidence remain separate.
    if(!result.empty()) {
      auto& previous=result.back();
      if(region.start<=previous.end+.02&&region.confidence>=.8&&previous.confidence>=.8&&std::abs(std::log(region.bpm/previous.bpm))<=.01) {
        previous.end=std::max(previous.end,region.end);
        const auto startIndex=static_cast<size_t>(std::lower_bound(beats.begin(),beats.end(),previous.start)-beats.begin());
        previous.bpm=60*double(first+8-startIndex)/(previous.end-previous.start);
        previous.confidence=std::min(previous.confidence,region.confidence);return;
      }
    }
    result.push_back(region);
  };
  // Sliding windows recover valid runs on either side of a faulty event.
  // Fixed eight-beat chunks could discard an entire useful intro/outro.
  for(size_t first=0;first+8<beats.size();++first) {
    append(first);
    if(result.size()>96)return {}; // explicit feature resource ceiling
  }
  return result;
}
}
