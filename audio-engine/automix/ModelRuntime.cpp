#include "ModelRuntime.h"
#include "Hash256.h"
#include "vendor/onnxruntime_c_api.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>
#include <string>
#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif
namespace twilight::automix {
struct ModelRuntime::Impl {
  const OrtApi* api{};OrtEnv* env{};OrtSessionOptions* options{};OrtMemoryInfo* memory{};
  OrtSession* beat{};OrtSession* yamnet{};void* library{};
  void check(OrtStatus* status) {
    if(!status)return;const std::string message=api->GetErrorMessage(status);api->ReleaseStatus(status);throw std::runtime_error(message);
  }
  ~Impl() {
    if(api) {if(beat)api->ReleaseSession(beat);if(yamnet)api->ReleaseSession(yamnet);if(memory)api->ReleaseMemoryInfo(memory);if(options)api->ReleaseSessionOptions(options);if(env)api->ReleaseEnv(env);}
#ifdef _WIN32
    if(library)FreeLibrary(static_cast<HMODULE>(library));
#else
    if(library)dlclose(library);
#endif
  }
  std::vector<std::vector<float>> run(OrtSession* session,const char* name,const std::vector<const char*>& names,std::span<const float> values,std::span<const int64_t> dimensions) {
    OrtValue* input{};std::vector<OrtValue*> outputs(names.size());
    try {
      check(api->CreateTensorWithDataAsOrtValue(memory,const_cast<float*>(values.data()),values.size_bytes(),dimensions.data(),dimensions.size(),ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT,&input));
      check(api->Run(session,nullptr,&name,&input,1,names.data(),names.size(),outputs.data()));
      std::vector<std::vector<float>> result;
      for(auto output:outputs) {
        OrtTensorTypeAndShapeInfo* shape{};check(api->GetTensorTypeAndShape(output,&shape));size_t count{};auto status=api->GetTensorShapeElementCount(shape,&count);api->ReleaseTensorTypeAndShapeInfo(shape);check(status);
        if(count>96*521*2)throw std::length_error("ONNX output exceeds AutoMix feature limit");
        void* data{};check(api->GetTensorMutableData(output,&data));const auto* begin=static_cast<const float*>(data);
        if(!std::all_of(begin,begin+count,[](float x){return std::isfinite(x);}))throw std::runtime_error("Non-finite ONNX output");
        result.emplace_back(begin,begin+count);
      }
      api->ReleaseValue(input);for(auto output:outputs)api->ReleaseValue(output);return result;
    } catch(...) {if(input)api->ReleaseValue(input);for(auto output:outputs)if(output)api->ReleaseValue(output);throw;}
  }
};
ModelRuntime::ModelRuntime(const std::filesystem::path& root):impl_(std::make_unique<Impl>()) {
  auto& r=*impl_;
  if(sha256File(root/"beat-this-small0.onnx")!="10b8a43f58ec08dec4cf3c0df3ae4c62b8c51b4d96449c318af7f2aa76dc574f"||sha256File(root/"yamnet.onnx")!="564a1406a3173634aedc049863403e581c1fabf2b0e2c22515d924d3ffb160e5")
    throw std::runtime_error("AutoMix model SHA-256 validation failed");
#ifdef _WIN32
  const auto runtime=root/"onnxruntime.dll";
  if(sha256File(runtime)!="4cb41e89b8bf30578e1dd95e9c40292d61974a4bfcd666409302c4f0c5aa8ce0")throw std::runtime_error("ONNX Runtime SHA-256 validation failed");
  r.library=LoadLibraryExW(std::filesystem::absolute(runtime).c_str(),nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  auto getBase=r.library?reinterpret_cast<const OrtApiBase* (ORT_API_CALL*)()>(GetProcAddress(static_cast<HMODULE>(r.library),"OrtGetApiBase")):nullptr;
#else
  // Platform distribution must supply an ORT 1.20.1 C ABI; model hashes are
  // identical. Its runtime artifact still needs a per-platform release lock.
  r.library=dlopen((root/"libonnxruntime.so").c_str(),RTLD_NOW|RTLD_LOCAL);
  auto getBase=r.library?reinterpret_cast<const OrtApiBase* (*)()>(dlsym(r.library,"OrtGetApiBase")):nullptr;
#endif
  if(!getBase)throw std::runtime_error("ONNX Runtime C API unavailable");
  r.api=getBase()->GetApi(ORT_API_VERSION);if(!r.api)throw std::runtime_error("ONNX Runtime C API version mismatch");
  r.check(r.api->CreateEnv(ORT_LOGGING_LEVEL_ERROR,"TwilightAutoMix",&r.env));
  r.check(r.api->CreateSessionOptions(&r.options));r.check(r.api->SetIntraOpNumThreads(r.options,1));r.check(r.api->SetInterOpNumThreads(r.options,1));
  r.check(r.api->SetSessionExecutionMode(r.options,ORT_SEQUENTIAL));r.check(r.api->AddSessionConfigEntry(r.options,"session.intra_op.allow_spinning","0"));
  r.check(r.api->CreateCpuMemoryInfo(OrtArenaAllocator,OrtMemTypeDefault,&r.memory));
  r.check(r.api->CreateSession(r.env,(root/"beat-this-small0.onnx").c_str(),r.options,&r.beat));
  r.check(r.api->CreateSession(r.env,(root/"yamnet.onnx").c_str(),r.options,&r.yamnet));
}
ModelRuntime::~ModelRuntime()=default;
std::pair<std::vector<float>,std::vector<float>> ModelRuntime::beatChunk(std::span<const float> mel) {
  if(mel.size()!=1500*128)throw std::invalid_argument("Beat This requires a validated 1500-frame chunk");
  const std::array<int64_t,3> shape={1,1500,128};auto data=impl_->run(impl_->beat,"logmel",{"beat","downbeat"},mel,shape);
  if(data[0].size()!=1500||data[1].size()!=1500)throw std::runtime_error("Invalid beat logit dimensions");return {std::move(data[0]),std::move(data[1])};
}
BeatEvents ModelRuntime::beats(const Spectrogram& mel) {
  if(mel.bins!=128||mel.frames<1488||mel.frames>2251||mel.values.size()!=mel.frames*128)throw std::invalid_argument("Beat window outside validated fixed-chunk contract");
  constexpr std::ptrdiff_t chunk=1500,border=6,step=1488;std::vector<std::ptrdiff_t> starts;
  for(std::ptrdiff_t start=-border;start<static_cast<std::ptrdiff_t>(mel.frames)-border;start+=step)starts.push_back(start);
  if(mel.frames>1488) starts.back()=static_cast<std::ptrdiff_t>(mel.frames)-1494;
  std::vector<float> beat(mel.frames,-1000),downbeat(mel.frames,-1000),input(chunk*128);std::vector<bool> assigned(mel.frames);
  for(auto start:starts) {
    std::fill(input.begin(),input.end(),0);
    for(std::ptrdiff_t i=0;i<chunk;++i)if(start+i>=0&&start+i<static_cast<std::ptrdiff_t>(mel.frames))std::copy_n(mel.values.begin()+(start+i)*128,128,input.begin()+i*128);
    auto logits=beatChunk(input);
    for(std::ptrdiff_t i=border;i<chunk-border;++i)if(start+i>=0&&start+i<static_cast<std::ptrdiff_t>(mel.frames)&&!assigned[start+i]) {
      assigned[start+i]=true;beat[start+i]=logits.first[i];downbeat[start+i]=logits.second[i];
    }
  }
  return beatThisPostprocess(beat,downbeat);
}
std::vector<float> ModelRuntime::musicTags(const Spectrogram& mel) {
  if(mel.bins!=64||mel.frames<96||mel.frames>4512||mel.values.size()!=mel.frames*64)throw std::invalid_argument("Invalid YAMNet input dimensions");
  // Bound each run to one patch, keeping CPU memory independent of clip length.
  std::vector<float> tags;tags.reserve(((mel.frames-96)/48+1)*521);const std::array<int64_t,3> shape={1,96,64};
  for(std::size_t start=0;start+96<=mel.frames;start+=48) {
    const std::span<const float> input(mel.values.data()+start*64,96*64);
    auto scores=impl_->run(impl_->yamnet,"logmel_patches",{"scores"},input,shape);
    if(scores[0].size()!=521)throw std::runtime_error("Invalid YAMNet class dimensions");tags.insert(tags.end(),scores[0].begin(),scores[0].end());
  }
  return tags;
}
}
