#pragma once

#include "../decoder/DsdReader.h"
#include "../decoder/DopPackerUtils.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

namespace twilight::audio::render {

inline uint8_t reverseDsdBits(uint8_t value) {
  value = static_cast<uint8_t>(((value & 0xf0) >> 4) | ((value & 0x0f) << 4));
  value = static_cast<uint8_t>(((value & 0xcc) >> 2) | ((value & 0x33) << 2));
  value = static_cast<uint8_t>(((value & 0xaa) >> 1) | ((value & 0x55) << 1));
  return value;
}

inline uint8_t convertDsdByte(uint8_t value, DsdBitOrder sourceOrder, AudioSampleFormat targetFormat) {
  if (targetFormat == AudioSampleFormat::DsdInt8Ner8) {
    return sourceOrder == DsdBitOrder::LsbFirst ? value : reverseDsdBits(value);
  }
  const bool targetMsb = targetFormat == AudioSampleFormat::DsdInt8Msb1;
  const bool sourceMsb = sourceOrder == DsdBitOrder::MsbFirst;
  return targetMsb == sourceMsb ? value : reverseDsdBits(value);
}

// Generated DSD planes may have reserved strides larger than the current
// block. Use their pointers rather than inferring a stride from byteCount.
// Pack directly into the backend buffer: the callback needs no resize/copy.
inline size_t packGeneratedDsd(
    uint8_t* const* planes, size_t bytesPerChannel, size_t channels,
    DsdBitOrder bitOrder, AudioSampleFormat format, uint8_t* output,
    size_t outputBytes, size_t outputFrames, size_t markerIndex) {
  if (!planes || !output || channels == 0) return 0;
  for (size_t channel = 0; channel < channels; ++channel)
    if (!planes[channel]) return 0;
  if (isDsdSampleFormat(format)) {
    const size_t frames = std::min({bytesPerChannel, outputFrames, outputBytes / channels});
    for (size_t frame = 0; frame < frames; ++frame)
      for (size_t channel = 0; channel < channels; ++channel)
        output[frame * channels + channel] = convertDsdByte(planes[channel][frame], bitOrder, format);
    return frames;
  }
  const size_t bytesPerSample = dop::dopCarrierBytesPerSample(format);
  if (bytesPerSample == 0) return 0;
  const size_t frames = std::min({bytesPerChannel / 2, outputFrames, outputBytes / channels / bytesPerSample});
  for (size_t frame = 0; frame < frames; ++frame)
    for (size_t channel = 0; channel < channels; ++channel)
      dop::writeDopSample(output, frame * channels + channel, bytesPerSample,
          dop::normalizeDsdByte(planes[channel][frame * 2], bitOrder),
          dop::normalizeDsdByte(planes[channel][frame * 2 + 1], bitOrder),
          dop::dopMarkerForFrame(markerIndex + frame));
  return frames;
}

inline bool dsdBitOrderMatchesTarget(DsdBitOrder sourceOrder, AudioSampleFormat targetFormat) {
  if (targetFormat == AudioSampleFormat::DsdInt8Ner8) {
    return sourceOrder == DsdBitOrder::LsbFirst;
  }
  if (targetFormat == AudioSampleFormat::DsdInt8Msb1) return sourceOrder == DsdBitOrder::MsbFirst;
  if (targetFormat == AudioSampleFormat::DsdInt8Lsb1) return sourceOrder == DsdBitOrder::LsbFirst;
  return false;
}

inline bool canCopyDsdBytesToInterleaved(const DsdStreamInfo& info, AudioSampleFormat targetFormat) {
  return info.channelCount > 0 && dsdBitOrderMatchesTarget(info.bitOrder, targetFormat) &&
         (info.packing == DsdPacking::DffInterleaved || info.channelCount == 1);
}

inline size_t dsdBytesToInterleavedResizeOnly(
    const uint8_t* dsdBytes,
    size_t byteCount,
    const DsdStreamInfo& info,
    AudioSampleFormat targetFormat,
    std::vector<uint8_t>* output) {
  if (!dsdBytes || !output || info.channelCount <= 0) return 0;
  const size_t channels = static_cast<size_t>(info.channelCount);

  const size_t frames = byteCount / channels;
  if (frames == 0) return 0;

  if (canCopyDsdBytesToInterleaved(info, targetFormat)) {
    const size_t outputBytes = frames * channels;
    output->resize(outputBytes);
    std::memcpy(output->data(), dsdBytes, outputBytes);
    return frames;
  }

  if (info.packing == DsdPacking::DsfPlanarBlocks) {
    const size_t channelBlock = byteCount / channels;
    const size_t usableFrames = channelBlock;
    output->resize(usableFrames * channels);
    for (size_t frame = 0; frame < usableFrames; ++frame) {
      for (size_t channel = 0; channel < channels; ++channel) {
        const size_t sourceIndex = channel * channelBlock + frame;
        (*output)[frame * channels + channel] = convertDsdByte(dsdBytes[sourceIndex], info.bitOrder, targetFormat);
      }
    }
    return usableFrames;
  }

  output->resize(frames * channels);
  for (size_t frame = 0; frame < frames; ++frame) {
    for (size_t channel = 0; channel < channels; ++channel) {
      const size_t index = frame * channels + channel;
      (*output)[index] = convertDsdByte(dsdBytes[index], info.bitOrder, targetFormat);
    }
  }
  return frames;
}

}  // namespace twilight::audio::render
