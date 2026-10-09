#pragma once
#include "AutoMix.h"
#include <string>
#include <vector>
namespace twilight::automix {
// Independent features stay independent: no native_analysis, Song event index,
// native loudness relation or fabricated tonality is introduced by this adapter.
struct CandidatePool {
  std::vector<TAE_AM_CandidateV1> candidates;
  std::string reason;
};
CandidatePool generateCandidates(const TAE_AM_ConfigV1& config,
  double outgoingDuration,double incomingDuration,
  const std::string& outgoingFeatures,const std::string& incomingFeatures);
}
