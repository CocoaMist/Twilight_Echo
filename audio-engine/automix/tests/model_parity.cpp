#include "ModelRuntime.h"
#include "Hash256.h"
#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <string>
#include <vector>
template<class T> static std::vector<T> read(const std::string& path) {
  std::ifstream f(path,std::ios::binary|std::ios::ate);assert(f);auto bytes=f.tellg();assert(bytes>=0&&bytes%sizeof(T)==0);
  std::vector<T> data(static_cast<std::size_t>(bytes)/sizeof(T));f.seekg(0);f.read(reinterpret_cast<char*>(data.data()),bytes);assert(f);return data;
}
template<class T> static double compare(const std::vector<T>& a,const std::vector<T>& b,double tolerance) {
  assert(a.size()==b.size());double max=0;
  for(size_t i=0;i<a.size();++i) {max=std::max(max,std::abs(double(a[i])-b[i]));assert(std::isfinite(a[i])&&std::abs(a[i]-b[i])<=tolerance);}
  return max;
}
int main(int argc,char** argv) {
  assert(argc==3);using namespace twilight::automix;
  assert(sha256({})=="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const std::string abc="abc";assert(sha256({reinterpret_cast<const uint8_t*>(abc.data()),abc.size()})=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  ModelRuntime runtime(argv[1]);
  for(const char* name:{"silence","noise","tone"}) {
    const std::string beat=std::string(argv[1])+"/"+name,yamnet=std::string(argv[2])+"/"+name;
    const auto input=read<float>(beat+"-mel.f32");const auto logits=runtime.beatChunk(input);
    const auto error=std::max(compare(logits.first,read<float>(beat+"-beat.f32"),2e-4),compare(logits.second,read<float>(beat+"-downbeat.f32"),2e-4));
    const auto events=beatThisPostprocess(logits.first,logits.second);
    compare(events.beats,read<double>(beat+"-beats.f64"),1./50);compare(events.downbeats,read<double>(beat+"-downbeats.f64"),1./50);
    const auto scores=runtime.musicTags(yamnetFrontend(read<float>(yamnet+"-pcm.f32")));
    const auto tagError=compare(scores,read<float>(yamnet+"-scores.f32"),2e-4);
    std::printf("%s: native C API beat max_abs=%g; native frontend + YAMNet scores max_abs=%g; event parity passed\n",name,error,tagError);
  }
}
