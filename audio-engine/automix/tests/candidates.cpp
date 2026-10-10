#include "CandidatePlanner.h"
#include "FeaturePostprocess.h"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <sstream>
#include <string>
#include <algorithm>
static std::string replace(std::string text,const std::string& old,const std::string& value) {
  const auto at=text.find(old);assert(at!=std::string::npos);text.replace(at,old.size(),value);return text;
}
static std::string energy(std::string text,const std::vector<double>& values) {
  const auto first=text.find("\"energyDbfs\":["),last=text.find(']',first);
  assert(first!=std::string::npos&&last!=std::string::npos);
  std::ostringstream data;data<<"\"energyDbfs\":[";
  for(size_t i=0;i<values.size();++i){if(i)data<<',';data<<values[i];}data<<']';
  text.replace(first,last-first+1,data.str());return text;
}
static size_t beatCount(const twilight::automix::CandidatePool& p) {
  return std::count_if(p.quality.begin(),p.quality.end(),[](const auto& q){return q.tier==3;});
}
static std::string features(bool out,int repeats=1,bool vocal=false,double phase=0,double bpm=120) {
  std::ostringstream j;
  j<<"{\"schemaVersion\":1,\"analysisVersion\":4,\"available\":true,\"durationSeconds\":100,\"provenance\":\"independent-beat-this-yamnet-v1\",\"modelHashes\":{\"beatThis\":\"10b8a43f58ec08dec4cf3c0df3ae4c62b8c51b4d96449c318af7f2aa76dc574f\",\"yamnet\":\"564a1406a3173634aedc049863403e581c1fabf2b0e2c22515d924d3ffb160e5\"},\"windows\":{\""<<(out?"tail":"head")<<"\":{\"sourceStart\":"<<(out?92:0)<<",\"sourceEnd\":"<<(out?100:8)<<",\"beatKnown\":true,\"vocalKnown\":true,\"beats\":[";
  for(int i=0;i<=static_cast<int>((8-phase)/(60/bpm));++i){if(i)j<<',';j<<(out?92:phase)+i*(60/bpm);}
  j<<"],\"downbeats\":[";
  for(int i=0;i<=static_cast<int>((8-phase)/(240/bpm));++i){if(i)j<<',';j<<(out?92:phase)+i*(240/bpm);}
  j<<"],\"key\":null,\"phraseBoundaries\":null,\"energyHopSeconds\":0.02,\"energyDbfs\":[-20],\"stableRegions\":[";
  for(int i=0;i<repeats;++i){if(i)j<<',';j<<"{\"start\":"<<(out?92:phase)<<",\"end\":"<<(out?100:8)<<",\"bpm\":"<<bpm<<",\"confidence\":1}";}
  j<<"],\"vocalWindows\":[{\"start\":"<<(out?92:0)<<",\"end\":"<<(out?100:8)<<",\"probability\":"<<(vocal?1:0)<<"}]}}}";
  return energy(j.str(),std::vector<double>(400,-20));
}
static std::string boundaryFeatures(bool outgoing,bool vocal=false) {
  auto text=features(outgoing,1,vocal);
  std::ostringstream energy;energy<<"\"energyDbfs\":[";
  for(int i=0;i<400;++i) {if(i)energy<<',';energy<<(outgoing?(i>=300?-120:-20):(i<75?-120:-20));}
  energy<<']';const auto first=text.find("\"energyDbfs\":["),last=text.find(']',first);
  text.replace(first,last-first+1,energy.str());return text;
}
int main() {
  std::vector<float> stereo(48000*2);
  for(size_t i=0;i<48000;++i) {stereo[i*2]=.1f;stereo[i*2+1]=-.1f;}
  const auto antiphase=twilight::automix::regionalEnergyDbfs(stereo,2,48000);
  assert(antiphase.size()==50&&std::abs(antiphase.front()+20)<1e-5);
  std::fill(stereo.begin(),stereo.end(),0);
  assert(twilight::automix::regionalEnergyDbfs(stereo,2,48000).front()==-120);
  std::vector<double> beats;for(int i=0;i<20;++i)beats.push_back(i*.5);
  const auto stable=twilight::automix::stableBeatRegions(beats);
  assert(stable.size()==1&&stable[0].start==0&&stable[0].end==9.5&&stable[0].bpm==120);
  assert(twilight::automix::stableBeatRegions({0,.5,1}).empty());
  beats[18]=beats[17];assert(twilight::automix::stableBeatRegions(beats).empty());
  beats.clear();for(int i=0;i<=8;++i)beats.push_back(i*.5);
  for(int i=1;i<=8;++i)beats.push_back(4+i*.6);
  const auto changed=twilight::automix::stableBeatRegions(beats);
  assert(changed.size()==2&&changed[0].bpm==120&&std::abs(changed[1].bpm-100)<1e-10);
  // A constant grid on the model's 20 ms clock must not acquire false tempo
  // changes or low confidence merely because 60/BPM is not a frame multiple.
  beats.clear();for(int i=0;i<80;++i)beats.push_back(std::round(i*60./140/.02)*.02);
  const auto quantized=twilight::automix::stableBeatRegions(beats);
  assert(quantized.size()==1&&quantized[0].confidence>=.8&&std::abs(quantized[0].bpm-140)<.2);
  beats[40]+=.2;
  const auto broken=twilight::automix::stableBeatRegions(beats);
  assert(broken.size()>=2);
  for(const auto& r:broken)assert(!(r.start<beats[39]&&r.end>beats[41]));
  TAE_AM_ConfigV1 config{};TAE_AM_DefaultConfig(&config);
  auto baseline=twilight::automix::generateCandidates(config,100,100,"","");
  assert(baseline.candidates.size()==1&&baseline.candidates[0].scoring.style_id==1);
  auto a=features(true),b=features(false);
  auto pool=twilight::automix::generateCandidates(config,100,100,a,b);
  assert(beatCount(pool)==3&&pool.candidates.size()==7);
  auto repeated=twilight::automix::generateCandidates(config,100,100,features(true,2),b);
  assert(beatCount(repeated)==2*beatCount(pool)); // all duplicate regions remain
  for(double bpm:{60.,240.}) {
    const auto aliases=twilight::automix::generateCandidates(config,100,100,a,features(false,1,false,0,bpm));
    assert(aliases.candidates.size()>1);
    for(size_t i=1;i<aliases.candidates.size();++i) {
      if(aliases.quality[i].tier!=3)continue;
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
  assert(pool.quality[twilight::automix::selectCandidate(pool,UINT64_MAX)].tier==3);
  const auto index=twilight::automix::selectCandidate(pool,UINT64_MAX);
  assert(pool.candidates[index].scoring.style_id==8);
  assert(twilight::automix::candidateForRendering(pool,index).scoring.style_id==7);
  assert(pool.quality[twilight::automix::selectCandidate(pool,UINT64_MAX,2)].tier==2);
  for(const auto& c:pool.candidates) {
    assert(!c.scoring.signals.tonalities_compatible.has_value);
    assert(!c.scoring.signals.incoming_region_loudness.has_value);
    assert(!c.scoring.signals.incoming_loudness_relation_code.has_value);
    assert(c.incoming_start==0&&c.scoring.outgoing_end==100);
    TAE_AM_Plan plan{};assert(TAE_AM_Compile(&config,&c,&plan)==TAE_AM_OK);TAE_AM_DestroyPlan(plan);
  }
  assert(twilight::automix::generateCandidates(config,100,100,a,features(false,1,true)).candidates.size()>1);
  assert(twilight::automix::generateCandidates(config,100,100,features(true,1,true),features(false,1,true)).candidates.size()==1);
  assert(twilight::automix::generateCandidates(config,100,100,"{}",b).candidates.size()==1);
  assert(twilight::automix::generateCandidates(config,100,100,a,std::string(524289,'x')).candidates.size()==1);
  assert(twilight::automix::generateCandidates(config,9,100,a,b).candidates.empty());
  config.max_transition_seconds=2;
  assert(twilight::automix::generateCandidates(config,100,100,a,b).candidates.size()==1);
  auto silence=twilight::automix::generateCandidates(config,100,100,boundaryFeatures(true),boundaryFeatures(false));
  assert(silence.candidates.size()>1);
  for(size_t i=1;i<silence.candidates.size();++i) {
    const auto& c=silence.candidates[i];
    assert(std::abs(c.scoring.outgoing_end-98.1)<1e-10&&std::abs(c.incoming_start-1.4)<1e-10);
    assert(!c.scoring.signals.incoming_region_loudness.has_value);
    TAE_AM_Plan plan{};assert(TAE_AM_Compile(&config,&c,&plan)==TAE_AM_OK);TAE_AM_DestroyPlan(plan);
  }
  config.allow_intelligent_skip=0;
  silence=twilight::automix::generateCandidates(config,100,100,boundaryFeatures(true),boundaryFeatures(false));
  for(const auto& c:silence.candidates)assert(c.scoring.outgoing_end==100&&c.incoming_start==0);
  config.allow_intelligent_skip=1;
  // Both vocal tracks, unknown/incomplete energy and missing model signals do
  // not authorize active-content trimming or invent native loudness categories.
  assert(twilight::automix::generateCandidates(config,100,100,boundaryFeatures(true,true),boundaryFeatures(false,true)).candidates.size()==1);
  auto noBeats=replace(boundaryFeatures(true),"\"beatKnown\":true","\"beatKnown\":false");
  auto acoustic=twilight::automix::generateCandidates(config,100,100,noBeats,boundaryFeatures(false));
  assert(acoustic.candidates.size()==2&&acoustic.candidates[1].scoring.style_id==5);
  assert(acoustic.reason=="independent_silence_boundaries");
  assert(!acoustic.candidates[1].scoring.signals.strict_tempo_compatible.has_value);
  // Without an observed content boundary, an entirely silent window cannot
  // authorize skipping. Missing energy or vocal coverage must also stay unknown.
  std::ostringstream allSilent;allSilent<<"\"energyDbfs\":[";
  for(int i=0;i<400;++i) {if(i)allSilent<<',';allSilent<<-120;}allSilent<<']';
  auto silentWindow=noBeats;
  const auto energyStart=silentWindow.find("\"energyDbfs\":["),energyEnd=silentWindow.find(']',energyStart);
  assert(energyStart!=std::string::npos&&energyEnd!=std::string::npos);
  silentWindow.replace(energyStart,energyEnd-energyStart+1,allSilent.str());
  assert(twilight::automix::generateCandidates(config,100,100,silentWindow,b).candidates.size()==1);
  auto unknownVoice=replace(noBeats,"\"vocalKnown\":true","\"vocalKnown\":false");
  const auto unknown=twilight::automix::generateCandidates(config,100,100,unknownVoice,b);
  for(const auto& c:unknown.candidates)assert(c.scoring.outgoing_end==100);
  // Quiet decay can use soft-skip without deleting the low-level tail. A flat
  // quiet passage cannot establish that the track is fading out.
  const auto decay=[](bool falling) {
    auto text=features(true);std::ostringstream energy;energy<<"\"energyDbfs\":[";
    for(int i=0;i<400;++i) {if(i)energy<<',';energy<<(falling&&i<350?-25:-40);}energy<<']';
    const auto first=text.find("\"energyDbfs\":["),last=text.find(']',first);
    text.replace(first,last-first+1,energy.str());return text;
  };
  auto quiet=twilight::automix::generateCandidates(config,100,100,decay(true),features(false,1,false,0,100));
  assert(quiet.candidates.size()==2&&quiet.candidates[1].scoring.style_id==5&&quiet.reason=="independent_quiet_outro");
  assert(quiet.candidates[1].scoring.outgoing_end==100&&quiet.candidates[1].incoming_start==0);
  assert(twilight::automix::generateCandidates(config,100,100,decay(false),features(false,1,false,0,100)).candidates.size()==1);
  config.max_transition_seconds=12;
  // Reciprocal rate ramps share a horizon and align observed downbeats while
  // preserving the incoming prefix. Aliases never double the actual speed.
  for(double bpm:{114.,126.}) {
    const auto tempos=twilight::automix::generateCandidates(config,100,100,a,features(false,1,false,.2,bpm));
    assert(beatCount(tempos)>0);
    for(size_t i=0;i<tempos.candidates.size();++i)if(tempos.quality[i].tier==3) {
      const auto& c=tempos.candidates[i];const double q=tempos.quality[i].tempoRatio;
      const double lo=c.scoring.outgoing_end-c.outgoing_start,li=c.scoring.incoming_end-c.incoming_start;
      assert(q>=.92&&q<=1.08&&1/q>=.92&&1/q<=1.08);
      assert(std::abs(lo/li-q)<1e-10);
      assert(std::abs(lo*std::log(q)/(q-1)-li*std::log(q)/(1-1/q))<1e-9);
      const double outAnchor=c.outgoing_start+q*.2;
      assert(std::abs((outAnchor-92)/2-std::round((outAnchor-92)/2))<1e-9);
      const auto render=twilight::automix::candidateForRendering(tempos,i);
      assert(render.scoring.style_id==7&&c.scoring.style_id==8);
      TAE_AM_Plan plan{};assert(TAE_AM_Compile(&config,&render,&plan)==TAE_AM_OK);TAE_AM_DestroyPlan(plan);
    }
  }
  const auto mismatched=twilight::automix::generateCandidates(config,100,100,a,features(false,1,false,0,100));
  assert(beatCount(mismatched)==0&&mismatched.quality[twilight::automix::selectCandidate(mismatched,0)].tier==2);
  const auto partial=twilight::automix::generateCandidates(config,100,100,energy(a,{-20}),b);
  assert(partial.candidates.size()==1);
  const auto quietMusic=twilight::automix::generateCandidates(config,100,100,energy(a,std::vector<double>(400,-80)),b);
  for(const auto& q:quietMusic.quality)assert(q.tier<2);
  std::puts("AutoMix independent candidates: unknown signals, duplicates, policy exclusions and recovered selection passed");
}
