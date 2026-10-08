#include "../decoder/FFmpegDecoder.h"
#include "../decoder/FFmpegDecoderUtils.h"
#include "../core/SharedInputFile.h"
#include "../dsp/DspTypes.h"
#include "AudioFixtureLibrary.h"

#include <algorithm>
#include <array>
#include <cassert>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
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
  assert(decoder.open(fixture.string(), &error));

  AudioFormat target = decoder.streamInfo().sourceFormat;
  target.sampleRate = 96000;
  target.bitDepth = 32;
  target.sampleFormat = AudioSampleFormat::Float32Interleaved;
  // Every tier — including the SoX tiers on FFmpeg builds without libsoxr —
  // must initialize a working resampler (graceful fallback, never a failure).
  assert(decoder.setOutputFormat(target, &error));

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

int main() {
  assertSharedFilePreservesReadAndSeekAfterDeletion();
  assertDecoderInt24AppendAvoidsUnalignedInt32Reads();
  assertDecoderContinuesWhenResamplerOutputsNoSamples();
  assertDecoderTailZeroHelperPreservesCopiedFrames();
  assertDecoderDirectPendingHelperShrinksToActualSamples();
#if defined(TAE_HAS_FFMPEG)
  assertDecoderReportsPcm("twilight-fixture-s16.wav", 16);
  assertDecoderReportsPcm("twilight-fixture-s24.wav", 24);
  assertDecoderReportsPcm("twilight-fixture-s32.wav", 32);
  assertDecoderReportsDsdFallbackWhenSupported();
  assertDecoderSoxrTiersProbeAndFallBackGracefully();
  assertDecoderOpensUtf8Path();
  assertOpenDecoderAllowsFileRenameAndDeletion();
  assertFailedDecoderOpenReleasesFile();
  assertDecoderOpensExternalFixturesWhenProvided();
#endif
  return 0;
}
