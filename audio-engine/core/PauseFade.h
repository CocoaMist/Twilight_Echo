#pragma once

#include "AudioTypes.h"
#include "AudioPipelineRenderUtils.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>

namespace twilight::audio {

// A temporary output envelope, independent of the user's software volume.
// Only the control thread begins/clears it; the callback consumes the frames.
class PauseFade {
 public:
  static constexpr int kDurationMs = 200;

  void begin(int sampleRate) noexcept {
    const uint64_t frames = std::max<uint64_t>(2, static_cast<uint64_t>(std::max(1, sampleRate)) * kDurationMs / 1000);
    totalFrames_.store(frames, std::memory_order_relaxed);
    remainingFrames_.store(frames, std::memory_order_relaxed);
    active_.store(true, std::memory_order_release);
  }

  void clear() noexcept {
    active_.store(false, std::memory_order_release);
    remainingFrames_.store(0, std::memory_order_release);
  }

  bool complete() const noexcept {
    return remainingFrames_.load(std::memory_order_acquire) == 0;
  }

  bool active() const noexcept {
    return active_.load(std::memory_order_acquire);
  }

  void process(float* samples, size_t frames, int channels) noexcept {
    if (!active_.load(std::memory_order_acquire) || !samples || channels <= 0) return;
    uint64_t remaining = remainingFrames_.load(std::memory_order_acquire);
    const uint64_t total = totalFrames_.load(std::memory_order_relaxed);
    for (size_t frame = 0; frame < frames; ++frame) {
      const double gain = gainAt(remaining, total, frame);
      for (int channel = 0; channel < channels; ++channel) {
        const size_t index = frame * static_cast<size_t>(channels) + static_cast<size_t>(channel);
        samples[index] = gain == 0.0 ? 0.0f : static_cast<float>(samples[index] * gain);
      }
    }
    consume(remaining, frames);
  }

  void process(PcmBlock& block) noexcept {
    if (!active_.load(std::memory_order_acquire) || !block.data || block.format.channelCount <= 0 ||
        block.format.dopEncoded || isDsdSampleFormat(block.format.sampleFormat)) return;
    const size_t sampleBytes = audioSampleFormatBytes(block.format.sampleFormat);
    const size_t frameBytes = sampleBytes * static_cast<size_t>(block.format.channelCount);
    if (frameBytes == 0) return;
    const size_t frames = std::min(block.frames, block.byteSize / frameBytes);
    uint64_t remaining = remainingFrames_.load(std::memory_order_acquire);
    const uint64_t total = totalFrames_.load(std::memory_order_relaxed);
    for (size_t frame = 0; frame < frames; ++frame) {
      const double gain = gainAt(remaining, total, frame);
      for (int channel = 0; channel < block.format.channelCount; ++channel) {
        uint8_t* sample = block.data + frame * frameBytes + static_cast<size_t>(channel) * sampleBytes;
        switch (block.format.sampleFormat) {
          case AudioSampleFormat::Float32Interleaved: {
            float value;
            std::memcpy(&value, sample, sizeof(value));
            value = gain == 0.0 ? 0.0f : static_cast<float>(value * gain);
            std::memcpy(sample, &value, sizeof(value));
            break;
          }
          case AudioSampleFormat::Int16Interleaved: {
            const auto value = static_cast<int16_t>(std::lround(render::signed16FromBytes(sample) * gain));
            std::memcpy(sample, &value, sizeof(value));
            break;
          }
          case AudioSampleFormat::Int24Interleaved: {
            const auto value = static_cast<uint32_t>(static_cast<int32_t>(std::lround(
                render::signed24FromBytes(sample[0], sample[1], sample[2]) * gain)));
            sample[0] = static_cast<uint8_t>(value);
            sample[1] = static_cast<uint8_t>(value >> 8);
            sample[2] = static_cast<uint8_t>(value >> 16);
            break;
          }
          case AudioSampleFormat::Int24In32Interleaved: {
            const auto value = static_cast<int32_t>(std::lround((render::signed32FromBytes(sample) >> 8) * gain));
            const uint32_t packed = static_cast<uint32_t>(value) << 8;
            std::memcpy(sample, &packed, sizeof(packed));
            break;
          }
          case AudioSampleFormat::Int32Interleaved: {
            const auto value = static_cast<int32_t>(std::llround(render::signed32FromBytes(sample) * gain));
            std::memcpy(sample, &value, sizeof(value));
            break;
          }
          default: break;
        }
      }
    }
    consume(remaining, frames);
  }

 private:
  static double gainAt(uint64_t remaining, uint64_t total, size_t frame) noexcept {
    // First frame keeps the current level, last frame reaches exact silence.
    return remaining > frame + 1 ? static_cast<double>(remaining - frame - 1) / static_cast<double>(total - 1) : 0.0;
  }

  void consume(uint64_t remaining, size_t frames) noexcept {
    const uint64_t next = remaining > frames ? remaining - frames : 0;
    remainingFrames_.compare_exchange_strong(remaining, next, std::memory_order_release, std::memory_order_relaxed);
  }

  std::atomic<bool> active_{false};
  std::atomic<uint64_t> totalFrames_{2};
  std::atomic<uint64_t> remainingFrames_{0};
};

}  // namespace twilight::audio
