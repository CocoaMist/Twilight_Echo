#pragma once

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <algorithm>
#include <atomic>
#include <cassert>
#include <chrono>
#include <string>
#include <thread>
#include <vector>

namespace twilight::audio::test {

// Ephemeral loopback server; it never contacts a provider or opens an audio device.
class HttpFixtureServer {
 public:
  enum class Mode { StallHeaders, StallBody, Complete, Truncated, HeldHeaders };
  explicit HttpFixtureServer(Mode mode, std::vector<char> body = {}) {
    WSADATA data{};
    assert(WSAStartup(MAKEWORD(2, 2), &data) == 0);
    listen_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    assert(listen_ != INVALID_SOCKET);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    assert(bind(listen_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0);
    int size = sizeof(address);
    assert(getsockname(listen_, reinterpret_cast<sockaddr*>(&address), &size) == 0);
    port_ = ntohs(address.sin_port);
    assert(listen(listen_, 4) == 0);
    worker_ = std::thread([this, mode, body = std::move(body)] {
      while (!stopping_.load()) {
        const SOCKET client = accept(listen_, nullptr, nullptr);
        if (client == INVALID_SOCKET) return;
        client_.store(client);
        connected_.store(true);
        connections_.fetch_add(1);
        char request[4096];
        recv(client, request, sizeof(request), 0);
        if (mode == Mode::HeldHeaders) {
          while (!released_.load() && !stopping_.load())
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
        if (mode != Mode::StallHeaders) {
          const size_t length = body.size();
          const std::string header = "HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: " +
              std::to_string(length) + "\r\nConnection: close\r\n\r\n";
          sendAll(client, header.data(), header.size());
          const size_t prefix = body.size() > 44 ? 44 + ((body.size() - 44) / 8) * 4 : body.size();
          sendAll(client, body.data(), mode == Mode::StallBody || mode == Mode::Truncated
              ? prefix : body.size());
        }
        if (mode == Mode::StallHeaders || mode == Mode::StallBody) {
          while (!stopping_.load()) std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
        client_.store(INVALID_SOCKET);
        shutdown(client, SD_BOTH);
        closesocket(client);
        if (mode == Mode::Truncated) {
          while (!stopping_.load()) std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
      }
    });
  }
  ~HttpFixtureServer() {
    stopping_.store(true);
    const SOCKET client = client_.load();
    if (client != INVALID_SOCKET) shutdown(client, SD_BOTH);
    closesocket(listen_);
    if (worker_.joinable()) worker_.join();
    WSACleanup();
  }
  std::string url() const { return "http://127.0.0.1:" + std::to_string(port_) + "/fixture.wav"; }
  int connections() const { return connections_.load(); }
  void releaseHeaders() { released_.store(true); }
  bool waitForConnection() const {
    for (int retry = 0; retry < 200 && !connected_.load(); ++retry)
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    return connected_.load();
  }
 private:
  void sendAll(SOCKET client, const char* bytes, size_t size) {
    while (size && !stopping_.load()) {
      const int sent = send(client, bytes, static_cast<int>(std::min<size_t>(size, 65536)), 0);
      if (sent <= 0) return;
      bytes += sent;
      size -= sent;
    }
  }
  SOCKET listen_ = INVALID_SOCKET;
  unsigned short port_ = 0;
  std::atomic<SOCKET> client_{INVALID_SOCKET};
  std::atomic<bool> connected_{false}, stopping_{false};
  std::atomic<bool> released_{false};
  std::atomic<int> connections_{0};
  std::thread worker_;
};
}  // namespace twilight::audio::test
#endif
