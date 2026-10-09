#include "CandidatePlanner.h"
#include "FeaturePostprocess.h"
#include <cassert>
#include <cstdio>
#include <sstream>
#include <string>
static std::string features(bool out,int repeats=1,bool vocal=false,double phase=0,double bpm=120) {
  std::ostringstream j;
  j<<"{\"schemaVersion\":1,\"analysisVersion\":3,\"available\":true,\"durationSeconds\":100,\"provenance\":\"independent-beat-this-yamnet-v1\",\"modelHashes\":{\"beatThis\":\"10b8a43f58ec08dec4cf3c0df3ae4c62b8c51b4d96449c318af7f2aa76dc574f\",\"yamnet\":\"564a1406a3173634aedc049863403e581c1fabf2b0e2c22515d924d3ffb160e5\"},\"windows\":{\""<<(out?"tail":"head")<<"\":{\"sourceStart\":"<<(out?92:0)<<",\"sourceEnd\":"<<(out?100:8)<<",\"beatKnown\":true,\"vocalKnown\":true,\"beats\":[";
  for(int i=0;i<=static_cast<int>((8-phase)/(60/bpm));++i){if(i)j<<',';j<<(out?92:phase)+i*(60/bpm);}
  j<<"],\"downbeats\":[";
  for(int i=0;i<=static_cast<int>((8-phase)/(240/bpm));++i){if(i)j<<',';j<<(out?92:phase)+i*(240/bpm);}
  j<<"],\"key\":null,\"phraseBoundaries\":null,\"energyHopSeconds\":0.02,\"energyDbfs\":[-20],\"stableRegions\":[";
  for(int i=0;i<repeats;++i){if(i)j<<',';j<<"{\"start\":"<<(out?92:phase)<<",\"end\":"<<(out?100:8)<<",\"bpm\":"<<bpm<<",\"confidence\":1}";}
  j<<"],\"vocalWindows\":[{\"start\":"<<(out?92:0)<<",\"end\":"<<(out?100:8)<<",\"probability\":"<<(vocal?1:0)<<"}]}}}";
  return j.str();
}
int main() {
  std::vector<double> beats;for(int i=0;i<20;++i)beats.push_back(i*.5);
  const auto stable=twilight::automix::stableBeatRegions(beats);
  assert(stable.size()==1&&stable[0].start==0&&stable[0].end==9.5&&stable[0].bpm==120);
  assert(twilight::automix::stableBeatRegions({0,.5,1}).empty());
  beats[18]=beats[17];assert(twilight::automix::stableBeatRegions(beats).empty());
  beats.clear();for(int i=0;i<=8;++i)beats.push_back(i*.5);
  for(int i=1;i<=8;++i)beats.push_back(4+i*.6);
  const auto changed=twilight::automix::stableBeatRegions(beats);
  assert(changed.size()==2&&changed[0].bpm==120&&std::abs(changed[1].bpm-100)<1e-10);
  TAE_AM_ConfigV1 config{};TAE_AM_DefaultConfig(&config);
  auto baseline=twilight::automix::generateCandidates(config,100,100,"","");
  assert(baseline.candidates.size()==1&&baseline.candidates[0].scoring.style_id==1);
  auto a=features(true),b=features(false);
  auto pool=twilight::automix::generateCandidates(config,100,100,a,b);
  assert(pool.candidates.size()==5);
  auto repeated=twilight::automix::generateCandidates(config,100,100,features(true,2),b);
  assert(repeated.candidates.size()==9); // all duplicate regions remain
  for(double bpm:{60.,240.}) {
    const auto aliases=twilight::automix::generateCandidates(config,100,100,a,features(false,1,false,0,bpm));
    assert(aliases.candidates.size()>1);
    for(size_t i=1;i<aliases.candidates.size();++i) {
      const auto& c=aliases.candidates[i];assert(c.scoring.signals.tempo_alias.value==(bpm==60?2:.5));
      assert(c.scoring.incoming_end-c.incoming_start==c.scoring.outgoing_end-c.outgoing_start);
      TAE_AM_Plan plan{};assert(TAE_AM_Compile(&config,&c,&plan)==TAE_AM_OK);TAE_AM_DestroyPlan(plan);
    }
  }
  auto phased=twilight::automix::generateCandidates(config,100,100,a,features(false,1,false,.2));
  assert(phased.candidates.size()>1);
  for(size_t i=1;i<phased.candidates.size();++i)assert(phased.candidates[i].incoming_start==0&&phased.candidates[i].scoring.outgoing_end==100);
  std::vector<am_score_result> scores(pool.candidates.size());TAE_AM_SelectionV1 selection{sizeof selection,TAE_AM_ABI_VERSION};
  assert(TAE_AM_Select(pool.candidates.data(),pool.candidates.size(),UINT64_MAX,1,scores.data(),&selection)==TAE_AM_OK);
  assert(selection.has_chosen&&pool.candidates[selection.chosen_index].scoring.style_id==8);
  for(const auto& c:pool.candidates) {
    assert(!c.scoring.signals.tonalities_compatible.has_value);
    assert(!c.scoring.signals.incoming_region_loudness.has_value);
    assert(!c.scoring.signals.incoming_loudness_relation_code.has_value);
    assert(c.incoming_start==0&&c.scoring.outgoing_end==100);
    TAE_AM_Plan plan{};assert(TAE_AM_Compile(&config,&c,&plan)==TAE_AM_OK);TAE_AM_DestroyPlan(plan);
  }
  assert(twilight::automix::generateCandidates(config,100,100,a,features(false,1,true)).candidates.size()==1);
  assert(twilight::automix::generateCandidates(config,100,100,"{}",b).candidates.size()==1);
  assert(twilight::automix::generateCandidates(config,100,100,a,std::string(524289,'x')).candidates.size()==1);
  assert(twilight::automix::generateCandidates(config,9,100,a,b).candidates.empty());
  config.max_transition_seconds=2;
  assert(twilight::automix::generateCandidates(config,100,100,a,b).candidates.size()==2);
  std::puts("AutoMix independent candidates: unknown signals, duplicates, policy exclusions and recovered selection passed");
}
