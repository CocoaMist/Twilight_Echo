#pragma once

#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <string>

namespace twilight::audio::ffmpeg {

inline bool isNetworkSource(const std::string& source) {
  const auto separator = source.find("://");
  if (separator == std::string::npos) return false;
  std::string scheme = source.substr(0, separator);
  for (char& ch : scheme) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  return scheme != "file";
}

// One deadline covers an operation including all of FFmpeg's reconnect attempts.
// The callback reads only atomics and the monotonic clock; it never locks.
class IoDeadline {
 public:
  void arm(int milliseconds) {
    deadline_.store(milliseconds > 0 ? now() + milliseconds : 0, std::memory_order_relaxed);
  }
  void clear() { deadline_.store(0, std::memory_order_relaxed); }
  bool expired() const {
    const auto deadline = deadline_.load(std::memory_order_relaxed);
    return deadline != 0 && now() >= deadline;
  }
 private:
  static int64_t now() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
  }
  std::atomic<int64_t> deadline_{0};
};

}  // namespace twilight::audio::ffmpeg
