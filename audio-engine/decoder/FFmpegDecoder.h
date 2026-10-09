#pragma once

#include "../core/AudioTypes.h"

#include <cstddef>
#include <memory>
#include <string>

namespace twilight::audio {

class FFmpegDecoder {
 public:
  enum class ResamplerQuality {
    Native,
    High,
    Ultra,
    // SoX engine tiers (libswresample "resampler=soxr", precision 20 / 28).
    // When the linked FFmpeg lacks libsoxr they fall back to Ultra swr settings.
    SoxrHq,
    SoxrVhq
  };

  FFmpegDecoder();
  ~FFmpegDecoder();

  FFmpegDecoder(const FFmpegDecoder&) = delete;
  FFmpegDecoder& operator=(const FFmpegDecoder&) = delete;

  bool open(const std::string& source, std::string* error);
  void close();

  bool setOutputFormat(const AudioFormat& format, std::string* error);
  void setResamplerQuality(ResamplerQuality quality);
  size_t readFrames(float* output, size_t frameCount, std::string* error);
  size_t readFrames(PcmBlock& output, std::string* error);
  bool seek(double seconds, std::string* error);
  /** Background-only: align decoded/resampled PCM to an absolute output frame.
   * Requires continuous frame timestamps; fails instead of inventing a clock. */
  bool seekOutputFrame(uint64_t frame, std::string* error);
  bool eof() const;

  const AudioStreamInfo& streamInfo() const;
  const AudioFormat& outputFormat() const;

  /**
   * Latest ICY / container StreamTitle (empty when none).
   * Thread-safe; may update during decode of live HTTP(S) streams.
   */
  std::string streamTitle() const;
  /** Refresh StreamTitle from demuxer metadata (call from decode thread). */
  void pollStreamMetadata();

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace twilight::audio
