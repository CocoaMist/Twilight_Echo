#ifdef _WIN32

#include "../vst3/Vst3SharedProtocol.h"

#include <windows.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>

namespace {

using SharedMemory = twilight::vst3::ipc::SharedMemory;
using HostState = twilight::vst3::ipc::HostState;
using SlotState = twilight::vst3::ipc::SlotState;

LONG readAtomic(const volatile int32_t* value) {
  return InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(const_cast<int32_t*>(value)), 0, 0);
}

LONG compareExchange(volatile int32_t* value, LONG desired, LONG expected) {
  return InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(value), desired, expected);
}

void writeAtomic(volatile int32_t* value, LONG next) {
  InterlockedExchange(reinterpret_cast<volatile LONG*>(value), next);
}

bool readServeOption(int argc, wchar_t* argv[], std::wstring_view option, std::wstring* result) {
  for (int index = 2; index + 1 < argc; index += 2) {
    if (std::wstring_view(argv[index]) == option) {
      *result = argv[index + 1];
      return !result->empty();
    }
  }
  return false;
}

int serve(int argc, wchar_t* argv[]) {
  std::wstring mappingName;
  std::wstring inputEventName;
  if (!readServeOption(argc, argv, L"--shared-memory", &mappingName) ||
      !readServeOption(argc, argv, L"--input-event", &inputEventName)) {
    return 64;
  }

  HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, mappingName.c_str());
  if (!mapping) {
    std::fprintf(stderr, "VST3 fixture OpenFileMappingW failed: %lu\n", GetLastError());
    return 2;
  }
  auto* shared = static_cast<SharedMemory*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedMemory)));
  if (!shared) {
    std::fprintf(stderr, "VST3 fixture MapViewOfFile failed: %lu\n", GetLastError());
    CloseHandle(mapping);
    return 2;
  }
  HANDLE inputEvent = OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, inputEventName.c_str());
  if (!inputEvent) {
    std::fprintf(stderr, "VST3 fixture OpenEventW failed: %lu\n", GetLastError());
    UnmapViewOfFile(shared);
    CloseHandle(mapping);
    return 2;
  }
  if (shared->magic != twilight::vst3::ipc::kProtocolMagic ||
      shared->version != twilight::vst3::ipc::kProtocolVersion || shared->sampleRate == 0 ||
      (shared->channels != 1 && shared->channels != 2 && shared->channels != 6 && shared->channels != 8) ||
      shared->maxFrames == 0 || shared->maxFrames > twilight::vst3::ipc::kMaxFrames) {
    writeAtomic(&shared->hostState, static_cast<LONG>(HostState::Failed));
    CloseHandle(inputEvent);
    UnmapViewOfFile(shared);
    CloseHandle(mapping);
    return 2;
  }

  // This fixture deliberately does not load a VST3 module. It validates the
  // bridge's Windows process and shared-memory lifecycle only, while echoing
  // blocks so the realtime path remains runnable.
  writeAtomic(&shared->hostErrorCode, 0);
  MemoryBarrier();
  writeAtomic(&shared->hostState, static_cast<LONG>(HostState::Ready));
  while (readAtomic(&shared->hostState) == static_cast<LONG>(HostState::Ready)) {
    const DWORD wait = WaitForSingleObject(inputEvent, 50);
    if (wait == WAIT_FAILED) {
      writeAtomic(&shared->hostState, static_cast<LONG>(HostState::Failed));
      break;
    }
    InterlockedIncrement(reinterpret_cast<volatile LONG*>(&shared->hostHeartbeat));
    for (auto& slot : shared->slots) {
      if (compareExchange(
              &slot.state,
              static_cast<LONG>(SlotState::Processing),
              static_cast<LONG>(SlotState::Ready)) != static_cast<LONG>(SlotState::Ready)) {
        continue;
      }
      const uint32_t safeFrames = std::min(slot.frames, shared->maxFrames);
      const size_t sampleCount = static_cast<size_t>(safeFrames) * shared->channels;
      std::memcpy(slot.output, slot.input, sampleCount * sizeof(float));
      MemoryBarrier();
      writeAtomic(&slot.state, static_cast<LONG>(SlotState::OutputReady));
    }
  }
  if (readAtomic(&shared->hostState) != static_cast<LONG>(HostState::Failed)) {
    writeAtomic(&shared->hostState, static_cast<LONG>(HostState::Stopped));
  }
  CloseHandle(inputEvent);
  UnmapViewOfFile(shared);
  CloseHandle(mapping);
  return 0;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (argc >= 2 && std::wstring_view(argv[1]) == L"--serve") return serve(argc, argv);
  return 64;
}

#else

int main() {
  return 0;
}

#endif
