#pragma once
#include "FeatureFrontend.h"
#include <filesystem>
#include <memory>
#include <span>
#include <vector>
namespace twilight::automix {
class ModelRuntime {
public:
  // Files must match pinned artifact hashes. Creating sessions and inferencing
  // are restricted to the isolated analysis worker, never the audio callback.
  explicit ModelRuntime(const std::filesystem::path& artifacts);
  ~ModelRuntime();
  ModelRuntime(const ModelRuntime&)=delete;
  std::pair<std::vector<float>,std::vector<float>> beatChunk(std::span<const float> mel1500x128);
  BeatEvents beats(const Spectrogram& mel);
  std::vector<float> musicTags(const Spectrogram& mel); // patches x 521
private:
  struct Impl;std::unique_ptr<Impl> impl_;
};
}
