#pragma once
#include <string>
#include <vector>

#include "../core/AudioTypes.h"
#include "../dsp/DspTypes.h"
#include "am_analysis.h"
#include "am_plan.h"

namespace twilight::audio {
// Thin FFmpeg/JSON adapter. Timing, analysis and transition policy live in C.
std::string analyzeAutoMixJson(const std::string& source, const std::string& optionsJson);
std::string autoMixFeaturesJson(const ta_am_features& features, const std::string& identity);
bool parseAutoMixFeatures(const std::string& json, ta_am_features* features, std::string* error);
bool parseAutoMixWindows(const std::string& request, const char* windows,
                         const char* legacy, ta_am_features*, std::string* error);
bool decodeAutoMixFrames(const QueueItem& item, const AudioFormat& format,
                         uint64_t firstLogicalFrame, size_t frames, std::vector<float>* pcm,
                         std::string* error, const ta_am_cancel* cancel = nullptr,
                         DspResamplerQuality quality = DspResamplerQuality::High);
}  // namespace twilight::audio
