#include "twilight_audio_engine.h"
#include "output/OutputBackendFactory.h"

#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

namespace {

std::string callString(TAE_EngineHandle engine, TAE_Result (*fn)(TAE_EngineHandle, char*, size_t, size_t*)) {
  size_t required = 0;
  if (fn(engine, nullptr, 0, &required) != TAE_RESULT_OK || required <= 1) {
    return {};
  }
  std::vector<char> buffer(required);
  if (fn(engine, buffer.data(), buffer.size(), &required) != TAE_RESULT_OK) {
    return {};
  }
  return buffer.data();
}

std::string stringField(const std::string& json, const std::string& key) {
  const std::string marker = "\"" + key + "\":\"";
  const size_t start = json.find(marker);
  if (start == std::string::npos) return {};
  const size_t valueStart = start + marker.size();
  const size_t valueEnd = json.find('"', valueStart);
  if (valueEnd == std::string::npos) return {};
  return json.substr(valueStart, valueEnd - valueStart);
}

bool setProviderEnvironment(const char* value) {
#if defined(_WIN32)
  return _putenv_s("TWILIGHT_AUDIO_PCM_PROVIDER", value) == 0;
#else
  return setenv("TWILIGHT_AUDIO_PCM_PROVIDER", value, 1) == 0;
#endif
}

}  // namespace

namespace twilight::audio {
void runOutputProviderSelectorTests();
}

int main(int argc, char** argv) {
  const std::string mode = argc > 1 ? argv[1] : "--provider-legacy";
  if (mode == "--provider-default") {
    if (!setProviderEnvironment("")) {
      std::cerr << "Failed to clear provider test environment\n";
      return 1;
    }
    const auto& selection = twilight::audio::configuredPcmOutputProvider();
    const std::string compiledDefault = twilight::audio::compiledDefaultPcmProviderControlValue();
    if (compiledDefault == "legacy") {
      if (selection.status != twilight::audio::PcmOutputProviderStatus::Ready ||
          selection.provider != twilight::audio::PcmOutputProvider::Legacy) {
        std::cerr << "The unset provider did not preserve the compiled legacy default\n";
        return 1;
      }
    } else {
#if TAE_TEST_MINIAUDIO_AVAILABLE
      if (selection.status != twilight::audio::PcmOutputProviderStatus::Ready ||
          selection.provider != twilight::audio::PcmOutputProvider::Miniaudio) {
        std::cerr << "The unset provider did not select the compiled miniaudio default\n";
        return 1;
      }
#else
      if (selection.status != twilight::audio::PcmOutputProviderStatus::ProviderUnavailable ||
          selection.provider != twilight::audio::PcmOutputProvider::Miniaudio) {
        std::cerr << "A build-disabled compiled miniaudio default was not rejected\n";
        return 1;
      }
#endif
    }
    return 0;
  }
  const char* providerValue =
      mode == "--provider-miniaudio" ? "miniaudio" : (mode == "--provider-legacy" ? "legacy" : "automatic");
  if (!setProviderEnvironment(providerValue)) {
    std::cerr << "Failed to configure provider test environment\n";
    return 1;
  }
  twilight::audio::runOutputProviderSelectorTests();
  TAE_EngineHandle engine = nullptr;
  if (TAE_CreateEngine(&engine) != TAE_RESULT_OK || !engine) {
    std::cerr << "TAE_CreateEngine failed\n";
    return 1;
  }

  std::string backend = "wasapi";
  const std::string initialBackend = stringField(callString(engine, TAE_GetPlaybackInfo), "outputBackend");
  const std::string initialBackends = callString(engine, TAE_EnumerateBackends);
  const std::string platformDefault = initialBackend == "none" ? "" : initialBackend;
  if (mode == "--provider-legacy") backend = platformDefault;
  if (mode == "--provider-special") {
    backend = initialBackends.find("\"id\":\"wasapi-exclusive\"") != std::string::npos
                  ? "wasapi-exclusive"
                  : (initialBackends.find("\"id\":\"coreaudio-exclusive\"") != std::string::npos
                         ? "coreaudio-exclusive"
                         : platformDefault);
  }
  const TAE_Result providerResult =
      backend.empty() ? TAE_RESULT_BACKEND_UNAVAILABLE : TAE_SetOutputBackend(engine, backend.c_str());
  if (mode == "--provider-invalid") {
    if (providerResult != TAE_RESULT_INVALID_ARGUMENT) {
      std::cerr << "An invalid provider value was not rejected\n";
      TAE_DestroyEngine(engine);
      return 1;
    }
    const std::string providerError = callString(engine, TAE_GetLastError);
    if (providerError.find("automatic") == std::string::npos) {
      std::cerr << "Invalid provider error was not actionable: " << providerError << "\n";
      TAE_DestroyEngine(engine);
      return 1;
    }
  } else if (mode == "--provider-special") {
    if (providerResult != (backend.empty() ? TAE_RESULT_BACKEND_UNAVAILABLE : TAE_RESULT_OK)) {
      std::cerr << "The PCM provider selector affected a non-provider backend: "
                << callString(engine, TAE_GetLastError) << "\n";
      TAE_DestroyEngine(engine);
      return 1;
    }
  } else if (mode == "--provider-miniaudio") {
#if TAE_TEST_MINIAUDIO_AVAILABLE
    if (providerResult != TAE_RESULT_OK) {
      std::cerr << "Feature-enabled miniaudio provider selection failed: "
                << callString(engine, TAE_GetLastError) << "\n";
      TAE_DestroyEngine(engine);
      return 1;
    }
#else
    if (providerResult != TAE_RESULT_BACKEND_UNAVAILABLE) {
      std::cerr << "A build without miniaudio silently accepted that provider\n";
      TAE_DestroyEngine(engine);
      return 1;
    }
    const std::string providerError = callString(engine, TAE_GetLastError);
    if (providerError.find("TAE_ENABLE_MINIAUDIO=OFF") == std::string::npos) {
      std::cerr << "Build-disabled provider error was not actionable: " << providerError << "\n";
      TAE_DestroyEngine(engine);
      return 1;
    }
#endif
  } else if (providerResult != (backend.empty() ? TAE_RESULT_BACKEND_UNAVAILABLE : TAE_RESULT_OK)) {
    std::cerr << "Legacy provider selection failed: " << callString(engine, TAE_GetLastError) << "\n";
    TAE_DestroyEngine(engine);
    return 1;
  }

  const std::string backendsJson = callString(engine, TAE_EnumerateBackends);
  const std::string playbackJson = callString(engine, TAE_GetPlaybackInfo);
  const std::string defaultId = stringField(playbackJson, "outputBackend");
  if (twilight::audio::isOutputBackendAvailable("unknown-backend") ||
      TAE_SetOutputBackend(engine, "unknown-backend") != TAE_RESULT_BACKEND_UNAVAILABLE ||
      stringField(callString(engine, TAE_GetPlaybackInfo), "outputBackend") != defaultId) {
    std::cerr << "An unavailable backend was accepted or changed the committed route\n";
    TAE_DestroyEngine(engine);
    return 1;
  }
  TAE_DestroyEngine(engine);

  if (defaultId.empty() || defaultId == "none") {
    if (backendsJson != "[]") {
      std::cerr << "Expected no backend for empty default, got: " << backendsJson << "\n";
      return 1;
    }
  } else {
    const std::string expected = "\"id\":\"" + defaultId + "\"";
    if (backendsJson.find(expected) == std::string::npos) {
      std::cerr << "Default backend " << defaultId << " missing from: " << backendsJson << "\n";
      return 1;
    }
  }

  return 0;
}
