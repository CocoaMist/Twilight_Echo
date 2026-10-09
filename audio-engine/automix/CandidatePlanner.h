#pragma once
#include "AutoMix.h"
#include <string>
#include <vector>
namespace twilight::automix {
// Independent features stay independent: no native_analysis, Song event index,
// native loudness relation or fabricated tonality is introduced by this adapter.
struct CandidatePool {
  std::vector<TAE_AM_CandidateV1> candidates;
  struct Quality {unsigned tier{};double estimatedOverlapSeconds{},tempoRatio{1};const char* reason{};int64_t renderStyle{};};
  std::vector<Quality> quality;
  std::string reason;
};
// Independent product eligibility precedes the unchanged recovered selector:
// beat mix, audible musical overlap, boundary cleanup, conservative fallback.
size_t selectCandidate(const CandidatePool& pool,uint64_t seed,unsigned maximumTier=3);
// Rendering may use an independent natural-mode catalogue choice. It never
// changes the style/path supplied to the recovered scorer and selector.
TAE_AM_CandidateV1 candidateForRendering(const CandidatePool& pool,size_t index);
CandidatePool generateCandidates(const TAE_AM_ConfigV1& config,
  double outgoingDuration,double incomingDuration,
  const std::string& outgoingFeatures,const std::string& incomingFeatures);
}
