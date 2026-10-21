#pragma once

#include "../core/AudioTypes.h"

#include <algorithm>
#include <cstddef>
#include <cstring>
#include <cstdint>
#include <vector>

namespace twilight::audio::ffmpeg {

// The WavPack block flag distinguishes DSD from both integer and floating PCM.
// FFmpeg decodes WavPack DSD to PCM but keeps AV_CODEC_ID_WAVPACK for the source.
inline bool wavPackHeaderIsDsd(const uint8_t* header, size_t size) {
  return header && size >= 32 && std::memcmp(header, "wvpk", 4) == 0 &&
         (header[27] & 0x80) != 0;
}

inline void zeroPcmBlock(PcmBlock& block) {
  if (!block.data || block.byteSize == 0) return;
  std::memset(block.data, 0, block.byteSize);
}

inline void zeroPcmBlockTail(PcmBlock& block, size_t copiedFrames) {
  if (!block.data || block.byteSize == 0 || block.frames == 0) return;
  const size_t bytesPerFrame = audioFormatBytesPerFrame(block.format);
  if (bytesPerFrame == 0) {
    zeroPcmBlock(block);
    return;
  }

  const size_t preservedFrames = std::min(copiedFrames, block.frames);
  const size_t offset = preservedFrames * bytesPerFrame;
  if (offset >= block.byteSize) return;

  const size_t requestedTailBytes = (block.frames - preservedFrames) * bytesPerFrame;
  const size_t byteCount = std::min(requestedTailBytes, block.byteSize - offset);
  std::memset(block.data + offset, 0, byteCount);
}

inline bool canDirectWriteConvertedSamples(AudioSampleFormat format) {
  return format != AudioSampleFormat::Int24Interleaved && audioSampleFormatBytes(format) > 0;
}

inline uint8_t* resizePendingForDirectWrite(
    std::vector<uint8_t>& pending,
    size_t sampleCount,
    AudioSampleFormat format) {
  if (sampleCount == 0 || !canDirectWriteConvertedSamples(format)) return nullptr;
  const size_t bytesPerSample = audioSampleFormatBytes(format);
  const size_t start = pending.size();
  pending.resize(start + sampleCount * bytesPerSample);
  return pending.data() + start;
}

inline void commitPendingDirectWrite(
    std::vector<uint8_t>& pending,
    size_t start,
    size_t actualSampleCount,
    AudioSampleFormat format) {
  if (start > pending.size()) return;
  const size_t bytesPerSample = audioSampleFormatBytes(format);
  pending.resize(start + actualSampleCount * bytesPerSample);
}

inline void appendConvertedSamples(
    const uint8_t* source,
    size_t sampleCount,
    AudioSampleFormat outputFormat,
    std::vector<uint8_t>* pending) {
  if (!source || !pending || sampleCount == 0) return;
  if (outputFormat == AudioSampleFormat::Int24Interleaved) {
    const size_t start = pending->size();
    pending->resize(start + sampleCount * 3);
    for (size_t i = 0; i < sampleCount; ++i) {
      uint32_t value = 0;
      std::memcpy(&value, source + i * sizeof(uint32_t), sizeof(value));
      (*pending)[start + i * 3 + 0] = static_cast<uint8_t>((value >> 8) & 0xff);
      (*pending)[start + i * 3 + 1] = static_cast<uint8_t>((value >> 16) & 0xff);
      (*pending)[start + i * 3 + 2] = static_cast<uint8_t>((value >> 24) & 0xff);
    }
    return;
  }

  const size_t bytesPerSample = audioSampleFormatBytes(outputFormat);
  const size_t byteCount = sampleCount * bytesPerSample;
  pending->insert(pending->end(), source, source + byteCount);
}

}  // namespace twilight::audio::ffmpeg
