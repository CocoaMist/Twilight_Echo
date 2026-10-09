#include "../decoder/FFmpegDecoder.h"
#include "../decoder/FFmpegDecoderUtils.h"
#include "../core/SharedInputFile.h"
#include "../dsp/DspTypes.h"
#include "AudioFixtureLibrary.h"
#include "../automix/AutoMix.h"
#include "../automix/CandidatePlanner.h"
extern "C" {
#include "../automix/recovered/am_json.h"
}

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
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

void assertAutoMixDecodeAndContinuation(const std::string& source, bool includeTail) {
  for(const unsigned rate:{44100u,48000u,88200u,96000u,176400u,192000u}) {
    FFmpegDecoder continuous;
    std::string error;
    assert(continuous.open(source,&error));
    auto format=continuous.outputFormat();
    format.sampleRate=rate;format.bitDepth=32;format.sampleFormat=AudioSampleFormat::Float32Interleaved;
    assert(format.channelCount>=1&&format.channelCount<=2);
    assert(continuous.setOutputFormat(format,&error));
    const unsigned channels=format.channelCount;
    const double duration=continuous.streamInfo().durationSeconds;
    std::vector<uint64_t> bases{0};
    if(includeTail) {assert(duration>6);bases.push_back(static_cast<uint64_t>(std::floor((duration-3.1)*rate)));}
    uint64_t cursor=0;
    float maximumPcmError=0,maximumPreparedError=0;
    std::vector<float> scratch(4096*channels);
    for(const auto base:bases) {
      while(cursor<base) {
        const auto count=std::min<uint64_t>(4096,base-cursor);
        assert(continuous.readFrames(scratch.data(),count,&error)==count);cursor+=count;
      }
      std::vector<float> reference(3*rate*channels);
      assert(continuous.readFrames(reference.data(),3*rate,&error)==3*rate);cursor+=3*rate;
      for(const int64_t style:{0,1,8,17}) {
        TAE_AM_ConfigV1 config{};TAE_AM_DefaultConfig(&config);
        TAE_AM_CandidateV1 candidate{};candidate.size=sizeof candidate;candidate.abi_version=TAE_AM_ABI_VERSION;
        candidate.outgoing_start=(base+rate/2+.37)/rate;candidate.incoming_start=(base+rate*2/5+.73)/rate;
        candidate.alias_index=1;candidate.outgoing_bars=candidate.incoming_bars=8;candidate.bpm=120;
        am_candidate_input_init(&candidate.scoring);candidate.scoring.style_id=style;
        candidate.scoring.path=am_default_route(style).path;
        candidate.scoring.outgoing_end=candidate.outgoing_start+2;
        candidate.scoring.incoming_end=candidate.incoming_start+(style==17?2.05:2);
        TAE_AM_Plan plan{};assert(TAE_AM_Compile(&config,&candidate,&plan)==TAE_AM_OK);
        TAE_AM_PcmViewV1 full{sizeof full,TAE_AM_ABI_VERSION,reference.data(),3*rate,base,rate,channels};
        TAE_AM_PcmViewV1 views[2];std::vector<float> decoded[2];
        for(unsigned side=0;side<2;++side) {
          TAE_AM_SourceWindowV1 window{sizeof window,TAE_AM_ABI_VERSION};
          assert(TAE_AM_GetSourceWindow(plan,side,rate,&window)==TAE_AM_OK);
          assert(window.source_first_frame>=base&&window.source_first_frame+window.frames<=base+3*rate);
          FFmpegDecoder positioned;assert(positioned.open(source,&error));assert(positioned.setOutputFormat(format,&error));
          assert(positioned.seekOutputFrame(window.source_first_frame,&error));
          decoded[side].resize(window.frames*channels);
          assert(positioned.readFrames(decoded[side].data(),window.frames,&error)==window.frames);
          for(size_t i=0;i<decoded[side].size();++i) {
            const auto difference=std::abs(decoded[side][i]-reference[(window.source_first_frame-base)*channels+i]);
            maximumPcmError=std::max(maximumPcmError,difference);assert(difference<=1e-5f);
          }
          views[side]={sizeof(TAE_AM_PcmViewV1),TAE_AM_ABI_VERSION,decoded[side].data(),window.frames,window.source_first_frame,rate,channels};
        }
        TAE_AM_Prepared expected{},actual{};
        TAE_AM_PreparedInfoV1 expectedInfo{sizeof expectedInfo,TAE_AM_ABI_VERSION},actualInfo{sizeof actualInfo,TAE_AM_ABI_VERSION};
        assert(TAE_AM_Prepare(plan,&full,&full,1,1,&expected,&expectedInfo)==TAE_AM_OK);
        assert(TAE_AM_Prepare(plan,&views[0],&views[1],1,1,&actual,&actualInfo)==TAE_AM_OK);
        assert(actualInfo.frames==expectedInfo.frames&&actualInfo.incoming_resume_frame==expectedInfo.incoming_resume_frame);
        assert(actualInfo.incoming_resume_frame==static_cast<uint64_t>(std::floor(candidate.scoring.incoming_end*rate)));
        std::vector<float> expectedPcm(257*channels),actualPcm(expectedPcm.size());
        for(uint64_t frame=0;frame<actualInfo.frames;frame+=257) {
          const auto count=std::min<uint64_t>(257,actualInfo.frames-frame);
          assert(TAE_AM_MixPrepared(expected,frame,expectedPcm.data(),count)==count);
          assert(TAE_AM_MixPrepared(actual,frame,actualPcm.data(),count)==count);
          for(size_t i=0;i<count*channels;++i) {
            const auto difference=std::abs(expectedPcm[i]-actualPcm[i]);
            maximumPreparedError=std::max(maximumPreparedError,difference);assert(difference<=1e-5f);
          }
        }
        FFmpegDecoder continuation;assert(continuation.open(source,&error));assert(continuation.setOutputFormat(format,&error));
        assert(continuation.seekOutputFrame(actualInfo.incoming_resume_frame,&error));
        assert(continuation.readFrames(actualPcm.data(),257,&error)==257);
        for(size_t i=0;i<actualPcm.size();++i)
          assert(std::abs(actualPcm[i]-reference[(actualInfo.incoming_resume_frame-base)*channels+i])<=1e-5f);
        if(style==0) {
          // Unity processing reaches the last half-open source sample and
          // resumes at the next one, with neither a repeated nor lost frame.
          const auto last=actualInfo.incoming_resume_frame-1;
          assert(TAE_AM_ReadPreparedSide(actual,1,actualInfo.frames-1,expectedPcm.data(),1)==1);
          for(unsigned channel=0;channel<channels;++channel)
            assert(std::abs(expectedPcm[channel]-reference[(last-base)*channels+channel])<=1e-5f);
        }
        TAE_AM_DestroyPrepared(actual);TAE_AM_DestroyPrepared(expected);TAE_AM_DestroyPlan(plan);
      }
    }
    std::cout<<"{\"boundaryRate\":"<<rate<<",\"sourceWindows\":"<<bases.size()
      <<",\"styles\":4,\"maximumDecodedError\":"<<maximumPcmError
      <<",\"maximumPreparedError\":"<<maximumPreparedError<<"}"<<std::endl;
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

#if defined(TAE_HAS_FFMPEG)
#include "../automix/tests/rendered_pair_probe.inc"
#endif
}  // namespace

int main(int argc,char** argv) {
#if defined(TAE_HAS_FFMPEG)
  if((argc==3||argc==5) && std::string(argv[1])=="--automix-pair-probe") {
    try {
      if(argc==5&&std::string(argv[3])!="--wav")throw std::runtime_error("expected --wav");
      inspectAutoMixMusicPair(argv[2],argc==5?argv[4]:"");return 0;
    } catch(const std::exception& e) {std::cerr<<e.what()<<'\n';return 1;}
  }
  if(argc==3 && std::string(argv[1])=="--precise-seek-probe") {
    assertPreciseSeekMatchesExternalPcm(argv[2]);return 0;
  }
  if(argc==3 && std::string(argv[1])=="--automix-boundary-probe") {
    assertAutoMixDecodeAndContinuation(argv[2],true);return 0;
  }
#endif
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
  assertPreciseSeekMatchesContinuousPcm();
  {
    const auto fixture=writePcmWavFixture({"twilight-automix-boundaries.wav",44100,2,16,44100*3+137,false});
    assertAutoMixDecodeAndContinuation(fixture.string(),false);
  }
  assertDecoderOpensUtf8Path();
  assertOpenDecoderAllowsFileRenameAndDeletion();
  assertFailedDecoderOpenReleasesFile();
  assertDecoderOpensExternalFixturesWhenProvided();
#endif
  return 0;
}
