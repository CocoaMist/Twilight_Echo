#include "dsp/ConvolverProcessor.h"
#include "dsp/FftSpectrumAnalyzer.h"
#include "playlist/QueueManager.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

using namespace twilight::audio;
using Clock = std::chrono::steady_clock;
double milliseconds(Clock::time_point start) {
  return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
void u16(std::ofstream& file, unsigned value) {
  char bytes[] = {static_cast<char>(value), static_cast<char>(value >> 8)};
  file.write(bytes, 2);
}
void u32(std::ofstream& file, unsigned value) {
  char bytes[] = {static_cast<char>(value), static_cast<char>(value >> 8), static_cast<char>(value >> 16), static_cast<char>(value >> 24)};
  file.write(bytes, 4);
}
void impulse(const std::string& path, int sr, double duration) {
  const unsigned frames = static_cast<unsigned>(duration * sr);
  std::ofstream file(path, std::ios::binary);
  file.write("RIFF", 4); u32(file, 36 + frames * 4); file.write("WAVEfmt ", 8);
  u32(file, 16); u16(file, 3); u16(file, 1); u32(file, sr); u32(file, sr * 4);
  u16(file, 4); u16(file, 32); file.write("data", 4); u32(file, frames * 4);
  for (unsigned i = 0; i < frames; ++i) {
    float value = i == 0 ? 1.0f : static_cast<float>(0.001 * std::exp(-5.0 * i / frames) * std::sin(i * 0.77));
    file.write(reinterpret_cast<const char*>(&value), 4);
  }
}
int main(int argc, char** argv) {
  const std::string folder = argc > 1 ? argv[1] : ".";
  for (int sr : {48000, 96000, 192000}) for (int channels : {2, 8}) for (double seconds : {0.125, 2.0, 8.0}) {
    const std::string path = folder + "/impulse.wav";
    impulse(path, sr, seconds);
    ConvolverProcessor processor;
    AudioFormat format; format.sampleRate = sr; format.channelCount = channels;
    processor.prepare(format);
    DspConfig config; config.enabled = true; config.convolverEnabled = true;
    processor.configure(config);
    std::string error;
    if (!processor.loadImpulseResponse(path, &error) || !processor.isActive()) { std::fprintf(stderr, "%s\n", error.c_str()); return 1; }
    std::vector<float> output(256 * channels, 0.2f);
    // Fill all IR history before measurement. Never report bypass timings as
    // active convolution performance; record warmup bypass explicitly.
    const size_t warmupCalls = static_cast<size_t>(std::ceil(seconds * sr / 256)) + 64;
    size_t warmed = 0;
    double warmupPeakMs = 0;
    size_t warmupMisses = 0;
    for (; warmed < warmupCalls && processor.isActive(); ++warmed) {
      std::fill(output.begin(), output.end(), 0.2f);
      const auto start = Clock::now(); processor.process(output.data(), 256);
      const double elapsed = milliseconds(start);
      warmupPeakMs = std::max(warmupPeakMs, elapsed);
      if (elapsed > 256000.0 / sr) ++warmupMisses;
    }
    std::vector<double> times;
    size_t misses = 0;
    size_t activeCalls = 0;
    const double deadline = 256000.0 / sr;
    const auto initial = processor.info();
    for (int call = 0; call < 512; ++call) {
      std::fill(output.begin(), output.end(), 0.2f);
      if (processor.isActive()) ++activeCalls;
      const auto start = Clock::now(); processor.process(output.data(), 256);
      const double time = milliseconds(start); times.push_back(time);
      if (time > deadline) ++misses;
    }
    std::sort(times.begin(), times.end());
    const auto info = processor.info();
    std::printf("{\"kind\":\"convolver\",\"sr\":%d,\"channels\":%d,\"irSeconds\":%.3f,\"partition\":%u,\"deadlineMs\":%.6f,\"p95Ms\":%.6f,\"p999Ms\":%.6f,\"peakMs\":%.6f,\"deadlineMisses\":%zu,\"overruns\":%llu,\"active\":%s,\"bypassed\":%s,\"memoryBytes\":%llu,\"warmupCalls\":%zu,\"warmupRequired\":%zu,\"activeCalls\":%zu,\"warmupOverruns\":%llu,\"warmupPeakMs\":%.6f,\"warmupDeadlineMisses\":%zu}\n",
      sr, channels, seconds, info.partitionSize, deadline, times[486], times.back(), times.back(), misses,
      static_cast<unsigned long long>(info.overrunCount - initial.overrunCount), processor.isActive() ? "true" : "false",
      info.bypassed ? "true" : "false", static_cast<unsigned long long>(info.memoryBytes), warmed, warmupCalls, activeCalls,
      static_cast<unsigned long long>(initial.overrunCount), warmupPeakMs, warmupMisses);
  }
  for (int mode = 0; mode < 5; ++mode) {
    FftSpectrumAnalyzer analyzer;
    AudioFormat format; format.sampleRate = 192000; format.channelCount = 8;
    analyzer.prepare(format, 8192);
    std::vector<float> audio(256 * 8);
    for (size_t i = 0; i < audio.size(); ++i) audio[i] = static_cast<float>(std::sin(i * 0.012) * 0.4);
    const size_t points = mode == 0 ? 64 : mode == 1 ? 2048 : 4096;
    const size_t frames = mode == 3 ? 96 : 0;
    const size_t bars = mode == 4 ? 140 : 0;
    for (int warmup = 0; warmup < 128; ++warmup) {
      analyzer.capture(audio.data(), 256, 8);
      analyzer.readVisualizationJson(points, 256, frames, 0, bars);
    }
    std::vector<double> times; size_t characters = 0;
    for (int sample = 0; sample < 64; ++sample) {
      analyzer.capture(audio.data(), 256, 8);
      const auto start = Clock::now(); const auto json = analyzer.readVisualizationJson(points, mode == 0 ? 48 : 256, frames, 0, bars);
      times.push_back(milliseconds(start)); characters = json.size();
    }
    std::sort(times.begin(), times.end());
    std::printf("{\"kind\":\"visualization\",\"spectrumPoints\":%zu,\"spectrogramFrames\":%zu,\"bars\":%zu,\"medianMs\":%.6f,\"p95Ms\":%.6f,\"peakMs\":%.6f,\"characters\":%zu}\n", points, frames, bars, times[32], times[60], times.back(), characters);
  }
  for (int count : {5000, 20000}) {
    std::string json = "[";
    for (int index = 0; index < count; ++index) {
      if (index) json += ',';
      json += "{\"id\":\"local:" + std::to_string(index) + "\",\"source\":\"E:/Music/Track" + std::to_string(index) + ".flac\",\"duration\":240,\"format\":\"FLAC\",\"sampleRate\":96000,\"bitDepth\":24}";
    }
    json += ']';
    QueueManager queue; std::string error; std::vector<double> times;
    for (int call = 0; call < 8; ++call) {
      const auto start = Clock::now(); if (!queue.loadFromJson(json, call, &error)) return 2;
      times.push_back(milliseconds(start));
    }
    std::sort(times.begin(), times.end());
    std::printf("{\"kind\":\"queueLoad\",\"items\":%d,\"characters\":%zu,\"medianMs\":%.6f,\"peakMs\":%.6f}\n", count, json.size(), times[4], times.back());
    times.clear();
    for (int call = 0; call < 1000; ++call) {
      const auto start = Clock::now(); queue.setCurrentIndex(call % count);
      times.push_back(milliseconds(start));
    }
    std::sort(times.begin(), times.end());
    std::printf("{\"kind\":\"queueCursor\",\"items\":%d,\"medianMs\":%.6f,\"peakMs\":%.6f}\n", count, times[500], times.back());
  }
}
