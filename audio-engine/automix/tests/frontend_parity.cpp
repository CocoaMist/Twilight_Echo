#include "FeatureFrontend.h"
#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <string>
#include <vector>
static std::vector<float> read(const std::string& path) {
  std::ifstream file(path,std::ios::binary|std::ios::ate);if(!file) return {};
  const auto bytes=file.tellg();assert(bytes>=0&&bytes%4==0);
  std::vector<float> data(static_cast<std::size_t>(bytes)/4);file.seekg(0);file.read(reinterpret_cast<char*>(data.data()),bytes);assert(file);return data;
}
int main(int argc,char** argv) {
  assert(argc==3);bool beat=std::string(argv[1])=="beat-this";
  for(const char* name:{"silence","noise","tone"}) {
    auto pcm=read(std::string(argv[2])+"/"+name+"-pcm.f32");auto oracle=read(std::string(argv[2])+"/"+name+"-mel.f32");assert(!pcm.empty()&&!oracle.empty());
    auto actual=beat?twilight::automix::beatThisFrontend(pcm):twilight::automix::yamnetFrontend(pcm);
    assert(actual.values.size()>=oracle.size());double max=0;size_t failures=0;
    for(std::size_t i=0;i<oracle.size();++i) {
      const double error=std::abs(actual.values[i]-oracle[i]);max=std::max(error,max);
      if(error>3e-4+2e-4*std::abs(oracle[i])) ++failures;
    }
    std::printf("%s frontend max_abs=%g failures=%zu\n",name,max,failures);assert(failures==0);
  }
}
