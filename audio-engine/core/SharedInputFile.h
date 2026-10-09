#pragma once

#include <array>
#include <filesystem>
#include <fstream>
#include <istream>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace twilight::audio {

#if defined(_WIN32)
// Keep a readable handle to the original file while allowing Explorer/tag editors
// to rename, replace or delete its directory entry during playback and preload.
class SharedInputFile : public std::istream {
  class Buffer : public std::streambuf {
   public:
    ~Buffer() override { close(); }

    bool open(const std::filesystem::path& path) {
      close();
      handle_ = CreateFileW(path.c_str(), GENERIC_READ,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
      return isOpen();
    }

    void close() {
      if (isOpen()) CloseHandle(handle_);
      handle_ = INVALID_HANDLE_VALUE;
      setg(nullptr, nullptr, nullptr);
    }

    bool isOpen() const { return handle_ != INVALID_HANDLE_VALUE; }

   protected:
    int_type underflow() override {
      if (gptr() && gptr() < egptr()) return traits_type::to_int_type(*gptr());
      DWORD count = 0;
      if (!isOpen() || !ReadFile(handle_, bytes_.data(), static_cast<DWORD>(bytes_.size()), &count, nullptr) || count == 0)
        return traits_type::eof();
      setg(bytes_.data(), bytes_.data(), bytes_.data() + count);
      return traits_type::to_int_type(*gptr());
    }

    pos_type seekoff(off_type offset, std::ios::seekdir direction,
                     std::ios::openmode mode) override {
      if (!isOpen() || !(mode & std::ios::in)) return pos_type(off_type(-1));
      DWORD origin;
      if (direction == std::ios::beg) origin = FILE_BEGIN;
      else if (direction == std::ios::end) origin = FILE_END;
      else if (direction == std::ios::cur) {
        origin = FILE_CURRENT;
        if (gptr()) offset -= egptr() - gptr();
      } else return pos_type(off_type(-1));
      LARGE_INTEGER distance;
      distance.QuadPart = offset;
      LARGE_INTEGER position;
      if (!SetFilePointerEx(handle_, distance, &position, origin)) return pos_type(off_type(-1));
      setg(nullptr, nullptr, nullptr);
      return pos_type(position.QuadPart);
    }

    pos_type seekpos(pos_type position, std::ios::openmode mode) override {
      return seekoff(static_cast<off_type>(position), std::ios::beg, mode);
    }

   private:
    HANDLE handle_ = INVALID_HANDLE_VALUE;
    std::array<char, 32768> bytes_;
  } buffer_;

 public:
  SharedInputFile() : std::istream(nullptr) { rdbuf(&buffer_); }
  explicit SharedInputFile(const std::filesystem::path& path,
                           std::ios::openmode mode = std::ios::binary)
      : SharedInputFile() { open(path, mode); }

  void open(const std::filesystem::path& path, std::ios::openmode = std::ios::binary) {
    clear();
    if (!buffer_.open(path)) setstate(std::ios::failbit);
  }
  void close() { buffer_.close(); }
  bool is_open() const { return buffer_.isOpen(); }
};
#else
using SharedInputFile = std::ifstream;
#endif

}  // namespace twilight::audio
