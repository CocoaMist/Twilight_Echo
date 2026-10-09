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
    std::vector<am_score_result> scores(pool.candidates.size());
    TAE_AM_SelectionV1 choice{sizeof choice,TAE_AM_ABI_VERSION};
    if(pool.candidates.empty()||TAE_AM_Select(pool.candidates.data(),pool.candidates.size(),0,1,scores.data(),&choice)!=TAE_AM_OK||!choice.has_chosen)throw std::runtime_error("no_chosen_candidate");
    const auto& candidate=pool.candidates[choice.chosen_index];
    std::cout<<std::setprecision(15)<<"{\"candidateCount\":"<<pool.candidates.size()<<",\"styleId\":"<<candidate.scoring.style_id
      <<",\"outgoingStart\":"<<candidate.outgoing_start<<",\"outgoingEnd\":"<<candidate.scoring.outgoing_end
      <<",\"incomingStart\":"<<candidate.incoming_start<<",\"incomingEnd\":"<<candidate.scoring.incoming_end;
    if(argc==7) {
      const int iterations=std::stoi(argv[6]);
      if(std::string(argv[5])!="--benchmark"||iterations<1000||iterations>100000)throw std::runtime_error("invalid_benchmark_iterations");
      const auto plan=[&](uint64_t seed) {
        const auto candidates=twilight::automix::generateCandidates(config,outDuration,inDuration,outgoing,incoming);
        std::vector<am_score_result> values(candidates.candidates.size());
        TAE_AM_SelectionV1 selected{sizeof selected,TAE_AM_ABI_VERSION};
        if(TAE_AM_Select(candidates.candidates.data(),candidates.candidates.size(),seed,1,values.data(),&selected)!=TAE_AM_OK||!selected.has_chosen)throw std::runtime_error("benchmark_selection_failed");
        TAE_AM_Plan compiled{};
        if(TAE_AM_Compile(&config,&candidates.candidates[selected.chosen_index],&compiled)!=TAE_AM_OK)throw std::runtime_error("benchmark_compile_failed");
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
