#include "../decoder/FFmpegDecoder.h"
#include "../decoder/FFmpegDecoderUtils.h"
#include "../core/SharedInputFile.h"
#include "../dsp/DspTypes.h"
#include "AudioFixtureLibrary.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cassert>
#include <cmath>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iomanip>
#include <memory>
#include <sstream>
#include <string>
#include <system_error>
#include <vector>

using namespace twilight::audio;
using namespace twilight::audio::test;

namespace {

std::string readTextFile(const std::filesystem::path& path) {
  std::ifstream input(path);
  std::ostringstream buffer;
  buffer << input.rdbuf();
  return buffer.str();
}

void assertDecoderInt24AppendAvoidsUnalignedInt32Reads() {
  const std::filesystem::path sourcePath =
      std::filesystem::path(__FILE__).parent_path().parent_path() / "decoder" / "FFmpegDecoderUtils.h";
  const std::string source = readTextFile(sourcePath);
  if (source.empty() || source.find("reinterpret_cast<const int32_t*>(source)") != std::string::npos) {
    std::abort();
  }
}

void assertDecoderContinuesWhenResamplerOutputsNoSamples() {
  const std::filesystem::path sourcePath =
      std::filesystem::path(__FILE__).parent_path().parent_path() / "decoder" / "FFmpegDecoder.cpp";
  const std::string source = readTextFile(sourcePath);
  if (source.empty() || source.find("return ok && !pending.empty();") != std::string::npos ||
      source.find("if (pending.empty())") == std::string::npos) {
    std::abort();
  }
}

void assertWavPackDsdDetectionUsesBlockFlag() {
  std::array<uint8_t, 32> header{};
  std::memcpy(header.data(), "wvpk", 4);
  assert(!ffmpeg::wavPackHeaderIsDsd(header.data(), header.size()));
  header[27] = 0x80;
  assert(ffmpeg::wavPackHeaderIsDsd(header.data(), header.size()));
  assert(!ffmpeg::wavPackHeaderIsDsd(header.data(), 31));
  assert(!ffmpeg::wavPackHeaderIsDsd(nullptr, header.size()));
  header[0] = 'x';
  assert(!ffmpeg::wavPackHeaderIsDsd(header.data(), header.size()));
  header[0] = 'w';
  header[27] = 0;
  header[24] = 0x80; // Not the high DSD flag; unrelated PCM flags remain PCM.
  assert(!ffmpeg::wavPackHeaderIsDsd(header.data(), header.size()));
}

void assertDecoderReportsPcm(const std::string& name, int bitsPerSample) {
  const auto fixture = writePcmWavFixture({name, 48000, 2, bitsPerSample, 32, false});
  FFmpegDecoder decoder;
  std::string error;
  assert(decoder.open(fixture.string(), &error));
  const AudioStreamInfo stream = decoder.streamInfo();
  assert(stream.sourceLossless);
  assert(!stream.isDsd);
  assert(stream.sourceFormat.sampleRate == 48000);
  assert(stream.sourceFormat.channelCount == 2);
  assert(stream.sourceFormat.bitDepth == bitsPerSample);
  assert(stream.decodedFormat.sampleRate == 48000);
  assert(stream.decodedFormat.channelCount == 2);
  assert(stream.decodedFormat.bitDepth == bitsPerSample);
  if (bitsPerSample == 16) {
    assert(stream.decodedFormat.sampleFormat == AudioSampleFormat::Int16Interleaved);
  } else if (bitsPerSample == 24) {
    assert(stream.decodedFormat.sampleFormat == AudioSampleFormat::Int24Interleaved);
  } else {
    assert(stream.decodedFormat.sampleFormat == AudioSampleFormat::Int32Interleaved);
  }
  decoder.close();
}

void assertDecoderCancellationCanBeResetBeforeSeek() {
  const auto fixture = writePcmWavFixture({"twilight-cancel-reset.wav", 48000, 2, 16, 8192, false});
  FFmpegDecoder decoder;
  std::atomic<bool> cancelled{true};
  decoder.setInterrupt([](void* context) -> int {
    return static_cast<std::atomic<bool>*>(context)->load();
  }, &cancelled);
  std::string error;
  assert(!decoder.open(fixture.string(), &error));
  cancelled = false;
  error.clear();
  assert(decoder.open(fixture.string(), &error));
  const auto format = decoder.outputFormat();
  std::vector<uint8_t> samples(256 * audioFormatBytesPerFrame(format));
  PcmBlock block{format, samples.data(), 256, samples.size()};
  assert(decoder.readFrames(block, &error) > 0);
  cancelled = true;
  assert(decoder.readFrames(block, &error) == 0);
  assert(error == "decode_cancelled");
  cancelled = false;
  error.clear();
  assert(decoder.seek(0.0, &error));
  assert(decoder.readFrames(block, &error) > 0);
}

void assertRemoteIoHasDeadline(const std::string& source, bool readStall) {
  FFmpegDecoder decoder;
  std::string error;
  const auto started = std::chrono::steady_clock::now();
  const bool opened = decoder.open(source, &error);
  if (!readStall) {
    assert(!opened);
    assert(std::chrono::steady_clock::now() - started < std::chrono::seconds(18));
    return;
  }
  assert(opened);
  assert(std::chrono::steady_clock::now() - started < std::chrono::seconds(18));
  const auto readStarted = std::chrono::steady_clock::now();
  const auto format = decoder.outputFormat();
  std::vector<uint8_t> bytes(2048 * audioFormatBytesPerFrame(format));
  PcmBlock block{format, bytes.data(), 2048, bytes.size()};
  size_t frames = 0;
  while (error.empty()) {
    const auto read = decoder.readFrames(block, &error);
    frames += read;
    if (read == 0) break;
  }
  assert(frames > 0);
  assert(!error.empty());
  // A timeout is a terminal read failure, not a normal end of the song. The
  // next read must retain its reason rather than silently becoming EOF.
  assert(!decoder.eof());
  const auto failure = error;
  error.clear();
  assert(decoder.readFrames(block, &error) == 0);
  assert(error == failure);
  assert(!decoder.eof());
  assert(std::chrono::steady_clock::now() - readStarted < std::chrono::seconds(13));
}

void assertDecoderTailZeroHelperPreservesCopiedFrames() {
  AudioFormat format;
  format.sampleRate = 48000;
  format.channelCount = 2;
  format.bitDepth = 32;
  format.sampleFormat = AudioSampleFormat::Float32Interleaved;

  std::vector<uint8_t> bytes(3 * audioFormatBytesPerFrame(format), 0x7f);
  PcmBlock block;
  block.format = format;
  block.data = bytes.data();
  block.frames = 3;
  block.byteSize = bytes.size();

  ffmpeg::zeroPcmBlockTail(block, 1);

  const size_t bytesPerFrame = audioFormatBytesPerFrame(format);
  for (size_t i = 0; i < bytesPerFrame; ++i) {
    assert(bytes[i] == 0x7f);
  }
  for (size_t i = bytesPerFrame; i < bytes.size(); ++i) {
    assert(bytes[i] == 0);
  }
}

void assertDecoderDirectPendingHelperShrinksToActualSamples() {
  std::vector<uint8_t> pending = {0xaa, 0xbb};
  const size_t start = pending.size();
  uint8_t* write = ffmpeg::resizePendingForDirectWrite(
      pending,
      4,
      AudioSampleFormat::Float32Interleaved);
  assert(write == pending.data() + start);
  assert(pending.size() == start + 4 * sizeof(float));

  ffmpeg::commitPendingDirectWrite(
      pending,
      start,
      2,
      AudioSampleFormat::Float32Interleaved);
  assert(pending.size() == start + 2 * sizeof(float));
  assert(pending[0] == 0xaa);
  assert(pending[1] == 0xbb);

  assert(ffmpeg::resizePendingForDirectWrite(
             pending,
             4,
             AudioSampleFormat::Int24Interleaved) == nullptr);
}

void assertDecoderReportsDsdFallbackWhenSupported() {
  const auto fixture = writeDsfFixture("twilight-decoder-dsd64.dsf");
  FFmpegDecoder decoder;
  std::string error;
  if (!decoder.open(fixture.string(), &error)) {
    std::cout << "Skipping DSF decoder fixture: " << error << std::endl;
    return;
  }

  const AudioStreamInfo stream = decoder.streamInfo();
  assert(stream.isDsd);
  assert(stream.dsdMode == DsdMode::Pcm);
  assert(stream.dsdRate == 64);
  assert(stream.sourceLossless);
  assert(stream.sourceFormat.sampleRate == 2822400);
  assert(stream.sourceFormat.channelCount == 2);
  assert(stream.sourceFormat.bitDepth == 1);
  assert(stream.decodedFormat.channelCount == 2);
  assert(stream.decodedFormat.bitDepth == 32);
  assert(stream.decodedFormat.sampleFormat == AudioSampleFormat::Float32Interleaved);
  assert(stream.decodedFormat.sampleRate > 0);
  decoder.close();
}

#if defined(TAE_HAS_FFMPEG)
// A 90-byte, stereo/44.1kHz FLAC containing exactly 8820 silent samples.
// Kept inline so the regression needs neither music files nor a CLI encoder.
void assertFlacTailHandling(bool appendInvalidFrame, bool incomplete, bool knownLength) {
  const std::string hex =
      "664c6143000000221200120000000e0000100ac442f00000227442b1eafdf0fc632f"
      "46230ad0497a29bf8400000e0600000066666d70656700000000fff85918006b0000"
      "00000000108afff8791801107364000000000000d405";
  std::vector<uint8_t> bytes;
  for (size_t i = 0; i < hex.size(); i += 2)
    bytes.push_back(static_cast<uint8_t>(std::stoul(hex.substr(i, 2), nullptr, 16)));
  if (!knownLength) { bytes[21] &= 0xf0; bytes[22] = bytes[23] = bytes[24] = bytes[25] = 0; }
  if (incomplete) bytes.resize(74); // Keep only the first 4608-sample frame.
  if (appendInvalidFrame) {
    // A valid frame header with an invalid subframe type causes receive_frame
    // to return INVALIDDATA, just like the tail packets in issue #164.
    const std::array<uint8_t, 14> invalid{0xff, 0xf8, 0x59, 0x18, 0x00, 0x6b, 0x04, 0, 0, 0, 0, 0, 0x10, 0x8a};
    bytes.insert(bytes.end(), invalid.begin(), invalid.end());
  }
  TempAudioFixture fixture(std::filesystem::temp_directory_path() / "twilight-flac-tail-regression.flac");
  { std::ofstream out(fixture.path(), std::ios::binary); out.write(reinterpret_cast<const char*>(bytes.data()), bytes.size()); }
  FFmpegDecoder decoder;
  std::string error;
  assert(decoder.open(fixture.string(), &error));
  AudioFormat target = decoder.outputFormat();
  target.sampleRate = 96000;
  target.sampleFormat = AudioSampleFormat::Float32Interleaved;
  target.bitDepth = 32;
  assert(decoder.setOutputFormat(target, &error));
  size_t total = 0;
  std::vector<float> pcm(512 * 2);
  while (const size_t count = decoder.readFrames(pcm.data(), 512, &error)) total += count;
  std::cerr << "FLAC tail probe: " << appendInvalidFrame << incomplete << knownLength
            << " frames=" << total << " eof=" << decoder.eof() << " error=" << error << '\n';
  if (appendInvalidFrame && (incomplete || !knownLength)) {
    assert(!error.empty());
    assert(!decoder.eof());
  } else {
    assert(error.empty());
    assert(decoder.eof());
    assert(total == 19200); // Includes the resampler's buffered tail.
  }
}

void assertDecoderReportsWavPackDsdBeforePcmConversion() {
  const auto fixture = writeWavPackDsdFixture("twilight-decoder-dsd128.wv");
  FFmpegDecoder decoder;
  std::string error;
  assert(decoder.open(fixture.string(), &error));
  const auto stream = decoder.streamInfo();
  assert(stream.isDsd);
  assert(stream.dsdMode == DsdMode::Pcm);
  assert(stream.dsdRate == 128);
  assert(stream.sourceLossless);
  assert(stream.sourceFormat.sampleRate == 5644800);
  assert(stream.sourceFormat.bitDepth == 1);
  assert(stream.sourceFormat.channelCount == 2);
  assert(stream.decodedFormat.sampleRate == 705600);
  assert(stream.decodedFormat.sampleFormat == AudioSampleFormat::Float32Interleaved);
  assert(std::abs(stream.durationSeconds - 1024.0 / 705600) < 1e-9);
  std::vector<float> samples(64 * 2);
  assert(decoder.readFrames(samples.data(), 64, &error) == 64);
  assert(error.empty());
  for (const float sample : samples) assert(std::isfinite(sample));
}
#endif

std::filesystem::path pathFromUtf8Bytes(const std::string& utf8) {
  return std::filesystem::path(reinterpret_cast<const char8_t*>(utf8.c_str()));
}

void assertSharedFilePreservesReadAndSeekAfterDeletion() {
  const auto path = std::filesystem::temp_directory_path() /
      pathFromUtf8Bytes("twilight-shared-\xe4\xb8\xad\xe6\x96\x87.bin");
  std::vector<char> bytes(70000);
  for (size_t i = 0; i < bytes.size(); ++i) bytes[i] = static_cast<char>(i % 127);
  { std::ofstream file(path, std::ios::binary); file.write(bytes.data(), bytes.size()); }
  SharedInputFile file;
  auto missing = path;
  missing += ".missing";
  file.open(missing);
  assert(!file);
  file.open(path);
  assert(file.is_open());
  std::array<char, 128> read{};
  file.read(read.data(), 5);
  assert(file.tellg() == 5);
  file.seekg(10, std::ios::cur);
  assert(file.tellg() == 15);
  file.read(read.data(), 6);
  assert(std::equal(read.begin(), read.begin() + 6, bytes.begin() + 15));
  file.seekg(-4, std::ios::end);
  file.read(read.data(), 8);
  assert(file.eof());
  assert(file.gcount() == 4);
  file.clear();
  file.seekg(33333, std::ios::beg);
  file.read(read.data(), read.size());
  assert(std::equal(read.begin(), read.end(), bytes.begin() + 33333));
  auto renamed = path;
  renamed += ".renamed";
  std::error_code fsError;
  std::filesystem::rename(path, renamed, fsError);
  assert(!fsError);
  assert(std::filesystem::remove(renamed, fsError));
  assert(!fsError);
  file.seekg(64000, std::ios::beg);
  file.read(read.data(), read.size());
  assert(file.gcount() == static_cast<std::streamsize>(read.size()));
  assert(std::equal(read.begin(), read.end(), bytes.begin() + 64000));
  file.close();
}

void assertDecoderOpensUtf8Path() {
  const std::string chinesePath = "\xe4\xb8\xad\xe6\x96\x87\xe8\xb7\xaf\xe5\xbe\x84";
  const std::filesystem::path unicodeDir =
      std::filesystem::temp_directory_path() / pathFromUtf8Bytes("twilight-" + chinesePath);
  std::error_code fsError;
  std::filesystem::create_directories(unicodeDir, fsError);
  assert(!fsError);

  auto fixture = writePcmWavFixture(
      {(unicodeDir / pathFromUtf8Bytes("twilight-" + chinesePath + "-s16.wav")).string(), 48000, 2, 16, 32, false});
  assert(std::filesystem::exists(fixture.path()));

  FFmpegDecoder decoder;
  std::string error;
  const bool opened = decoder.open(fixture.string(), &error);
  if (!opened) {
    std::fprintf(stderr, "UTF-8 path fixture failed to decode: %s\nerror: %s\n", fixture.string().c_str(), error.c_str());
  }
  assert(opened);
  assert(decoder.streamInfo().source == fixture.string());
  assert(decoder.streamInfo().sourceFormat.sampleRate == 48000);
  assert(decoder.streamInfo().sourceFormat.channelCount == 2);
  decoder.close();

  fixture.cleanup();
  std::filesystem::remove(unicodeDir, fsError);
}

void assertOpenDecoderAllowsFileRenameAndDeletion() {
  const auto fixture = writePcmWavFixture(
      {"twilight-decoder-file-sharing.wav", 48000, 2, 16, 96000, false});
  FFmpegDecoder decoder;
  std::string error;
  assert(decoder.open(fixture.string(), &error));
  AudioFormat output = decoder.streamInfo().decodedFormat;
  output.bitDepth = 32;
  output.sampleFormat = AudioSampleFormat::Float32Interleaved;
  assert(decoder.setOutputFormat(output, &error));
  auto renamed = fixture.path();
  renamed += ".renamed.wav";
  std::error_code fsError;
  std::filesystem::rename(fixture.path(), renamed, fsError);
  if (fsError) std::cerr << "Open decoder blocks rename: " << fsError.message() << std::endl;
  assert(!fsError);
  assert(std::filesystem::remove(renamed, fsError));
  assert(!fsError);
  // Continue through the original handle, including a seek beyond the IO buffer.
  assert(decoder.seek(1.0, &error));
  std::vector<float> samples(1024 * 2);
  assert(decoder.readFrames(samples.data(), 1024, &error) > 0);
  decoder.close();
}

void assertFailedDecoderOpenReleasesFile() {
  const auto path = std::filesystem::temp_directory_path() / "twilight-decoder-invalid.wav";
  { std::ofstream file(path, std::ios::binary); file << "invalid audio"; }
  FFmpegDecoder decoder;
  std::string error;
  assert(!decoder.open(path.string(), &error));
#if defined(_WIN32)
  // Delete sharing alone could hide a leaked handle. An exclusive open proves
  // the failed decoder released its input before returning to the caller.
  const HANDLE exclusive = CreateFileW(path.c_str(), GENERIC_READ, 0, nullptr,
                                       OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  assert(exclusive != INVALID_HANDLE_VALUE);
  CloseHandle(exclusive);
#endif
  assert(std::filesystem::remove(path));
}

#if defined(TAE_HAS_FFMPEG)
void assertPreciseSeekMatchesContinuousPcm() {
  constexpr int sourceRate = 44100;
  constexpr size_t sourceFrames = sourceRate * 3 + 137;
  const auto fixture = writePcmWavFixture({"twilight-precise-seek.wav", sourceRate, 2, 16,
      static_cast<int>(sourceFrames), false});
  for (const int targetRate : {44100, 48000, 88200, 96000, 176400, 192000}) {
    for (const auto quality : {FFmpegDecoder::ResamplerQuality::Native, FFmpegDecoder::ResamplerQuality::Ultra}) {
      FFmpegDecoder decoder;
      std::string error;
      assert(decoder.open(fixture.string(), &error));
      AudioFormat format = decoder.outputFormat();
      format.sampleRate = targetRate; format.bitDepth = 32;
      format.sampleFormat = AudioSampleFormat::Float32Interleaved;
      decoder.setResamplerQuality(quality);
      assert(decoder.setOutputFormat(format, &error));
      std::vector<float> reference((targetRate * 4) * 2);
      const auto count = decoder.readFrames(reference.data(), reference.size()/2, &error);
      assert(count > static_cast<size_t>(targetRate * 3));
      reference.resize(count * 2);
      for (const uint64_t first : {uint64_t(0), uint64_t(1), uint64_t(1023),
          uint64_t(targetRate * 2 + 37), uint64_t(count - 123)}) {
        assert(decoder.seekOutputFrame(first, &error));
        std::vector<float> actual(257 * 2);
        const auto got = decoder.readFrames(actual.data(), 257, &error);
        assert(got == std::min<size_t>(257, count - first));
        for (size_t i = 0; i < got*2; ++i) {
          if (std::abs(actual[i] - reference[first*2+i]) > 1e-5f) {
            std::fprintf(stderr, "precise seek mismatch rate=%d frame=%llu sample=%zu actual=%g expected=%g\n",
                targetRate, (unsigned long long)first, i, actual[i], reference[first*2+i]);
            std::abort();
          }
        }
      }
    }
  }
}

void assertPreciseSeekMatchesExternalPcm(const std::string& source) {
  for (const int rate : {44100, 48000, 88200, 96000, 176400, 192000}) {
    FFmpegDecoder reference, seeked;
    std::string error;
    assert(reference.open(source, &error));
    assert(seeked.open(source, &error));
    AudioFormat format = reference.outputFormat();
    format.sampleRate = rate; format.bitDepth = 32; format.sampleFormat = AudioSampleFormat::Float32Interleaved;
    assert(reference.setOutputFormat(format, &error));
    assert(seeked.setOutputFormat(format, &error));
    const double duration = reference.streamInfo().durationSeconds;
    assert(duration > 10 && format.channelCount <= 2);
    const std::vector<uint64_t> positions{0, 1, static_cast<uint64_t>(2ULL * rate + 37),
        static_cast<uint64_t>(std::floor((duration-4) * rate)) + 17};
    const auto channels = static_cast<size_t>(format.channelCount);
    std::vector<float> scratch(4096 * channels), expected(257 * channels), actual(expected.size());
    uint64_t cursor = 0;
    float maximumError = 0;
    for (const auto first : positions) {
      if (first < cursor) {
        reference.close(); assert(reference.open(source, &error));
        assert(reference.setOutputFormat(format, &error)); cursor = 0;
      }
      while (cursor < first) {
        const auto request = std::min<uint64_t>(4096, first-cursor);
        const auto got = reference.readFrames(scratch.data(),request,&error);
        assert(got == request); cursor += got;
      }
      assert(reference.readFrames(expected.data(),257,&error) == 257); cursor += 257;
      if (!seeked.seekOutputFrame(first,&error)) {
        std::fprintf(stderr,"precise seek failed rate=%d frame=%llu error=%s\n",rate,(unsigned long long)first,error.c_str());std::abort();
      }
      assert(seeked.readFrames(actual.data(),257,&error) == 257);
      for (size_t i=0;i<actual.size();++i) {
        maximumError=std::max(maximumError,std::abs(actual[i]-expected[i]));
        if (std::abs(actual[i]-expected[i])>1e-5f) {
          std::fprintf(stderr,"compressed precise seek mismatch rate=%d frame=%llu sample=%zu actual=%g expected=%g\n",
              rate,(unsigned long long)first,i,actual[i],expected[i]);std::abort();
        }
      }
    }
    std::cout << "{\"rate\":" << rate << ",\"positions\":4,\"maximumPcmError\":" << maximumError << "}" << std::endl;
  }
}

void assertDecoderResamplesWithQualityTier(
    FFmpegDecoder::ResamplerQuality quality,
    const char* fixtureName) {
  // The fixture has to outrun the widest filter we configure: Ultra uses filter_size 64,
  // and swr cannot centre a 64-tap filter on an input shorter than its half-length, so a
  // 32-frame fixture legitimately decodes to nothing on that tier.
  constexpr size_t kInputFrames = 1024;
  const auto fixture =
      writePcmWavFixture({fixtureName, 44100, 2, 16, static_cast<int>(kInputFrames), false});
  FFmpegDecoder decoder;
  decoder.setResamplerQuality(quality);
  std::string error;
  assert(decoder.resamplerEngine() == FFmpegDecoder::ResamplerEngine::Unknown);
  assert(decoder.open(fixture.string(), &error));
  assert(decoder.resamplerEngine() == FFmpegDecoder::ResamplerEngine::None);

  AudioFormat target = decoder.streamInfo().sourceFormat;
  target.sampleRate = 96000;
  target.bitDepth = 32;
  target.sampleFormat = AudioSampleFormat::Float32Interleaved;
  // Every tier — including the SoX tiers on FFmpeg builds without libsoxr —
  // must initialize a working resampler (graceful fallback, never a failure).
  assert(decoder.setOutputFormat(target, &error));
  const bool wantsSoxr = quality == FFmpegDecoder::ResamplerQuality::SoxrHq ||
      quality == FFmpegDecoder::ResamplerQuality::SoxrVhq;
  const bool fallback = wantsSoxr && soxrRuntimeAvailability() == SoxrRuntimeState::Unavailable;
  assert(decoder.resamplerEngine() == (wantsSoxr && !fallback
      ? FFmpegDecoder::ResamplerEngine::Soxr : FFmpegDecoder::ResamplerEngine::Swr));
  assert(decoder.effectiveResamplerQuality() == (fallback ? FFmpegDecoder::ResamplerQuality::Ultra : quality));

  std::vector<float> frames(4096 * 2, 0.0f);
  const size_t decoded = decoder.readFrames(frames.data(), 4096, &error);
  assert(decoded > 0);
  bool nonZero = false;
  for (size_t i = 0; i < decoded * 2; ++i) {
    if (frames[i] != 0.0f) {
      nonZero = true;
      break;
    }
  }
  assert(nonZero);

  // Drain to EOF and check we got the whole stream, not the stream minus the resampler's
  // buffered tail. 1024 frames at 44100 -> 96000 is ~2229 frames; swr holds back roughly
  // a filter length, so skipping the flush lands near 2160 and trips the lower bound.
  size_t total = decoded;
  while (true) {
    std::vector<float> more(4096 * 2, 0.0f);
    const size_t got = decoder.readFrames(more.data(), 4096, &error);
    if (got == 0) break;
    total += got;
  }
  const size_t expected = kInputFrames * 96000 / 44100;
  assert(total > expected - 32);
  assert(total < expected + 64);
  decoder.close();
}

void assertDecoderSoxrTiersProbeAndFallBackGracefully() {
  // Force re-probing so this test exercises the runtime detection path even
  // if another test already touched the resampler.
  soxrRuntimeStateStorage().store(0);
  assert(soxrRuntimeAvailability() == SoxrRuntimeState::Unknown);

  assertDecoderResamplesWithQualityTier(
      FFmpegDecoder::ResamplerQuality::SoxrHq, "twilight-decoder-soxr-hq.wav");
  // The probe must have produced a definitive answer either way.
  const SoxrRuntimeState afterHq = soxrRuntimeAvailability();
  assert(afterHq != SoxrRuntimeState::Unknown);

  assertDecoderResamplesWithQualityTier(
      FFmpegDecoder::ResamplerQuality::SoxrVhq, "twilight-decoder-soxr-vhq.wav");
  assert(soxrRuntimeAvailability() == afterHq);

  // Once soxr is known-unavailable, the decoder must skip re-probing and go
  // straight to the Ultra swr fallback; the classic tiers stay untouched.
  soxrRuntimeStateStorage().store(2);
  assertDecoderResamplesWithQualityTier(
      FFmpegDecoder::ResamplerQuality::SoxrVhq, "twilight-decoder-soxr-fallback.wav");
  assert(soxrRuntimeAvailability() == SoxrRuntimeState::Unavailable);

  assertDecoderResamplesWithQualityTier(
      FFmpegDecoder::ResamplerQuality::Ultra, "twilight-decoder-swr-ultra.wav");
  assertDecoderResamplesWithQualityTier(
      FFmpegDecoder::ResamplerQuality::Native, "twilight-decoder-swr-native.wav");

  // Leave the probe state clean for other suites in this process.
  soxrRuntimeStateStorage().store(0);
}
#endif

void assertDecoderOpensExternalFixturesWhenProvided() {
  const auto fixtures = findExternalAudioFixtures();
  if (fixtures.empty()) return;

  for (const auto& fixture : fixtures) {
    if (fixture.extension() == ".iso" || fixture.extension() == ".ISO") continue;
    FFmpegDecoder decoder;
    std::string error;
    const bool opened = decoder.open(fixture.string(), &error);
    if (!opened) {
      std::fprintf(stderr, "External fixture failed to decode: %s\nerror: %s\n", fixture.string().c_str(), error.c_str());
    }
    assert(opened);
    assert(decoder.streamInfo().source == fixture.string());
    assert(decoder.streamInfo().sourceFormat.sampleRate > 0);
    assert(decoder.streamInfo().sourceFormat.channelCount > 0);
    assert(decoder.streamInfo().decodedFormat.sampleRate > 0);
    assert(decoder.streamInfo().decodedFormat.channelCount > 0);
    decoder.close();
  }
}

}  // namespace

int main(int argc,char** argv) {
#if defined(TAE_HAS_FFMPEG)
  if (argc == 2 && std::string(argv[1]) == "--flac-tail-probe") {
    assertFlacTailHandling(false, false, true);
    assertFlacTailHandling(true, false, true);
    assertFlacTailHandling(true, true, true);
    assertFlacTailHandling(true, false, false);
    return 0;
  }
  if (argc == 3 && std::string(argv[1]) == "--network-open-timeout-probe") {
    assertRemoteIoHasDeadline(argv[2], false); return 0;
  }
  if (argc == 3 && std::string(argv[1]) == "--network-read-timeout-probe") {
    assertRemoteIoHasDeadline(argv[2], true); return 0;
  }
  if(argc==3 && std::string(argv[1])=="--precise-seek-probe") {
    assertPreciseSeekMatchesExternalPcm(argv[2]);return 0;
  }
#else
  if (argc == 3 && std::string(argv[1]).rfind("--network-", 0) == 0) {
    std::cerr << "Network stall probes require a real FFmpeg build\n";
    return 1;
  }
#endif
  assertSharedFilePreservesReadAndSeekAfterDeletion();
  assertDecoderInt24AppendAvoidsUnalignedInt32Reads();
  assertDecoderContinuesWhenResamplerOutputsNoSamples();
  assertWavPackDsdDetectionUsesBlockFlag();
  assertDecoderTailZeroHelperPreservesCopiedFrames();
  assertDecoderDirectPendingHelperShrinksToActualSamples();
#if defined(TAE_HAS_FFMPEG)
  assertDecoderReportsPcm("twilight-fixture-s16.wav", 16);
  assertFlacTailHandling(false, false, true);
  assertFlacTailHandling(true, false, true);
  assertFlacTailHandling(true, true, true);
  assertFlacTailHandling(true, false, false);
  assertDecoderReportsPcm("twilight-fixture-s24.wav", 24);
  assertDecoderReportsPcm("twilight-fixture-s32.wav", 32);
  assertDecoderCancellationCanBeResetBeforeSeek();
  assertDecoderReportsDsdFallbackWhenSupported();
  assertDecoderReportsWavPackDsdBeforePcmConversion();
  assertDecoderSoxrTiersProbeAndFallBackGracefully();
  assertPreciseSeekMatchesContinuousPcm();
  assertDecoderOpensUtf8Path();
  assertOpenDecoderAllowsFileRenameAndDeletion();
  assertFailedDecoderOpenReleasesFile();
  assertDecoderOpensExternalFixturesWhenProvided();
#endif
  return 0;
}
