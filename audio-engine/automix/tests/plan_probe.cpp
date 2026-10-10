// Development-only inspection of the actual candidate generator and selector.
#include "CandidatePlanner.h"
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <vector>

int main(int argc,char** argv) {
  if(argc!=5&&argc!=7) {std::cerr<<"Usage: plan_probe <out-duration> <in-duration> <tail-json> <head-json> [--benchmark <iterations>]\n";return 2;}
  try {
    const auto read=[](const char* file) {
      const std::u8string utf8(reinterpret_cast<const char8_t*>(file));
      std::ifstream stream(std::filesystem::path(utf8),std::ios::binary);
      if(!stream)throw std::runtime_error("feature_file_unavailable");
      return std::string(std::istreambuf_iterator<char>(stream),{});
    };
    TAE_AM_ConfigV1 config{};TAE_AM_DefaultConfig(&config);
    const auto outgoing=read(argv[3]),incoming=read(argv[4]);
    const double outDuration=std::stod(argv[1]),inDuration=std::stod(argv[2]);
    const auto pool=twilight::automix::generateCandidates(config,outDuration,inDuration,outgoing,incoming);
    const auto chosen=twilight::automix::selectCandidate(pool,0);const auto& quality=pool.quality[chosen];
    const auto candidate=twilight::automix::candidateForRendering(pool,chosen);
    std::cout<<std::setprecision(15)<<"{\"reason\":\""<<(quality.reason?quality.reason:pool.reason.c_str())<<"\",\"mixTier\":"<<quality.tier
      <<",\"estimatedOverlapSeconds\":"<<quality.estimatedOverlapSeconds<<",\"tempoRatio\":"<<quality.tempoRatio<<",\"candidateCount\":"<<pool.candidates.size()<<",\"scoringStyleId\":"<<pool.candidates[chosen].scoring.style_id<<",\"styleId\":"<<candidate.scoring.style_id
      <<",\"outgoingStart\":"<<candidate.outgoing_start<<",\"outgoingEnd\":"<<candidate.scoring.outgoing_end
      <<",\"incomingStart\":"<<candidate.incoming_start<<",\"incomingEnd\":"<<candidate.scoring.incoming_end;
    if(argc==7) {
      const int iterations=std::stoi(argv[6]);
      if(std::string(argv[5])!="--benchmark"||iterations<1000||iterations>100000)throw std::runtime_error("invalid_benchmark_iterations");
      const auto plan=[&](uint64_t seed) {
        const auto candidates=twilight::automix::generateCandidates(config,outDuration,inDuration,outgoing,incoming);
        const auto selected=twilight::automix::selectCandidate(candidates,seed);
        TAE_AM_Plan compiled{};
        const auto render=twilight::automix::candidateForRendering(candidates,selected);
        if(TAE_AM_Compile(&config,&render,&compiled)!=TAE_AM_OK)throw std::runtime_error("benchmark_compile_failed");
        TAE_AM_DestroyPlan(compiled);
      };
      for(int i=0;i<20;++i)plan(i);
      std::vector<double> times;times.reserve(iterations);
      for(int i=0;i<iterations;++i) {
        const auto start=std::chrono::steady_clock::now();plan(i);
        times.push_back(std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count());
      }
      std::sort(times.begin(),times.end());
      const auto p99=times[(iterations*99+99)/100-1];
      std::cout<<",\"cachedNativePlanning\":{\"iterations\":"<<iterations<<",\"p99Milliseconds\":"<<p99
        <<",\"maximumMilliseconds\":"<<times.back()<<",\"targetMet\":"<<(p99<=50?"true":"false")
        <<",\"hostCacheIoIncluded\":false,\"audioPreparationIncluded\":false}";
    }
    std::cout<<"}\n";
    return 0;
  } catch(const std::exception& error) {std::cerr<<error.what()<<'\n';return 1;}
}
