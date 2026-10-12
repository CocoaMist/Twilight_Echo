#pragma once
#include <cctype>
#include <set>
#include <string>

namespace twilight::audio {
// Cached features cross a process boundary. Validate the entire bounded JSON
// before using the engine's field helpers, which intentionally accept prefixes.
class AutoMixJsonValidation {
  const std::string &text;
  size_t pos = 0;
  void whitespace() {
    while (pos < text.size() && (text[pos] == ' ' || text[pos] == '\n' ||
                                 text[pos] == '\r' || text[pos] == '\t'))
      ++pos;
  }
  bool string(std::string *key = nullptr) {
    if (pos >= text.size() || text[pos++] != '"')
      return false;
    while (pos < text.size()) {
      unsigned char c = text[pos++];
      if (c == '"')
        return true;
      if (c < 0x20)
        return false;
      if (c == '\\') {
        if (pos >= text.size())
          return false;
        char escape = text[pos++];
        if (escape == 'u') {
          unsigned code = 0;
          for (unsigned j = 0; j < 4; ++j) {
            if (pos >= text.size())
              return false;
            char digit = text[pos++];
            unsigned v = digit >= '0' && digit <= '9'   ? digit - '0'
                         : digit >= 'a' && digit <= 'f' ? digit - 'a' + 10
                         : digit >= 'A' && digit <= 'F' ? digit - 'A' + 10
                                                        : 16;
            if (v == 16)
              return false;
            code = code * 16 + v;
          }
          // Protocol field names are ASCII; reject escaped non-ASCII keys.
          if (key && code > 127)
            return false;
          if (key)
            key->push_back(static_cast<char>(code));
        } else {
          if (std::string("\"\\/bfnrt").find(escape) == std::string::npos)
            return false;
          if (key)
            key->push_back(escape);
        }
      } else if (key)
        key->push_back(static_cast<char>(c));
    }
    return false;
  }
  bool number() {
    if (pos < text.size() && text[pos] == '-')
      ++pos;
    if (pos >= text.size())
      return false;
    if (text[pos] == '0')
      ++pos;
    else {
      if (text[pos] < '1' || text[pos] > '9')
        return false;
      while (pos < text.size() &&
             std::isdigit(static_cast<unsigned char>(text[pos])))
        ++pos;
    }
    if (pos < text.size() && text[pos] == '.') {
      size_t start = ++pos;
      while (pos < text.size() &&
             std::isdigit(static_cast<unsigned char>(text[pos])))
        ++pos;
      if (pos == start)
        return false;
    }
    if (pos < text.size() && (text[pos] == 'e' || text[pos] == 'E')) {
      ++pos;
      if (pos < text.size() && (text[pos] == '+' || text[pos] == '-'))
        ++pos;
      size_t start = pos;
      while (pos < text.size() &&
             std::isdigit(static_cast<unsigned char>(text[pos])))
        ++pos;
      if (pos == start)
        return false;
    }
    return true;
  }
  bool value(unsigned depth) {
    whitespace();
    if (pos >= text.size() || depth > 8)
      return false;
    char c = text[pos];
    if (c == '"')
      return string();
    if (c == '{' || c == '[') {
      char end = c == '{' ? '}' : ']';
      ++pos;
      whitespace();
      if (pos < text.size() && text[pos] == end) {
        ++pos;
        return true;
      }
      std::set<std::string> keys;
      while (pos < text.size()) {
        if (c == '{') {
          std::string key;
          if (!string(&key) || !keys.insert(key).second)
            return false;
          whitespace();
          if (pos >= text.size() || text[pos++] != ':')
            return false;
        }
        if (!value(depth + 1))
          return false;
        whitespace();
        if (pos >= text.size())
          return false;
        if (text[pos] == end) {
          ++pos;
          return true;
        }
        if (text[pos++] != ',')
          return false;
        whitespace();
      }
      return false;
    }
    for (const char *literal : {"true", "false", "null"}) {
      size_t length = std::char_traits<char>::length(literal);
      if (text.compare(pos, length, literal) == 0) {
        pos += length;
        return true;
      }
    }
    return number();
  }

public:
  explicit AutoMixJsonValidation(const std::string &input) : text(input) {}
  bool valid() {
    whitespace();
    if (pos >= text.size() || text[pos] != '{' || !value(0))
      return false;
    whitespace();
    return pos == text.size();
  }
};
} // namespace twilight::audio
