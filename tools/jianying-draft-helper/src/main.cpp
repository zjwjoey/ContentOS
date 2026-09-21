// ContentOS Jianying encrypted draft helper.
// SPDX-License-Identifier: MIT
//
// This is a small Windows-only process boundary around the public
// EncryptUtils exports used by the user's installed Jianying videoeditor.dll.
// It deliberately does not ship, embed, or modify that proprietary DLL.

#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace fs = std::filesystem;

namespace {

constexpr int kProtocolVersion = 1;
constexpr const char *kHelperVersion = "1.0.0";
constexpr const char *kDecryptExport = "?decrypt@EncryptUtils@lvve@@QEAA?AV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@AEBV34@0AEA_N@Z";

struct MsvcString {
  union {
    char small[16];
    char *ptr;
  } data{};
  std::uint64_t size = 0;
  std::uint64_t capacity = 15;
};

using DecryptFn = MsvcString *(*)(void *, MsvcString *, const MsvcString *, const MsvcString *, bool *);

class HelperError : public std::runtime_error {
 public:
  HelperError(std::string code, std::string message)
      : std::runtime_error(std::move(message)), code_(std::move(code)) {}

  const std::string &code() const { return code_; }

 private:
  std::string code_;
};

std::string jsonEscape(const std::string &value) {
  std::ostringstream out;
  for (const unsigned char ch : value) {
    switch (ch) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (ch < 0x20) {
          out << "\\u00" << "0123456789abcdef"[(ch >> 4) & 0x0f] << "0123456789abcdef"[ch & 0x0f];
        } else {
          out << static_cast<char>(ch);
        }
    }
  }
  return out.str();
}

std::string narrow(const std::wstring &value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string result(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
  return result;
}

std::wstring widen(const std::string &value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) throw HelperError("INVALID_ARGUMENT", "path is not valid UTF-8");
  std::wstring result(static_cast<std::size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size);
  return result;
}

std::string readFile(const fs::path &path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) throw HelperError("INPUT_NOT_READABLE", "cannot read input: " + narrow(path.wstring()));
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

void writeFile(const fs::path &path, const std::string &value) {
  std::ofstream output(path, std::ios::binary);
  if (!output) throw HelperError("OUTPUT_NOT_WRITABLE", "cannot write output: " + narrow(path.wstring()));
  output.write(value.data(), static_cast<std::streamsize>(value.size()));
  if (!output) throw HelperError("OUTPUT_NOT_WRITABLE", "failed writing output: " + narrow(path.wstring()));
}

struct MsvcStringArg {
  std::string storage;
  MsvcString value;

  explicit MsvcStringArg(std::string input) : storage(std::move(input)) {
    value.size = storage.size();
    if (storage.size() < sizeof(value.data.small)) {
      std::copy(storage.begin(), storage.end(), value.data.small);
      value.capacity = 15;
    } else {
      value.data.ptr = storage.data();
      value.capacity = storage.size();
    }
  }
};

std::string takeMsvcString(const MsvcString &value) {
  const char *data = value.capacity < sizeof(value.data.small) ? value.data.small : value.data.ptr;
  if (!data || value.size > (1ull << 32)) throw HelperError("DLL_OUTPUT_INVALID", "videoeditor.dll returned an invalid string");
  return {data, data + value.size};
}

class JianyingDll {
 public:
  explicit JianyingDll(const fs::path &dllPath) {
    const fs::path directory = dllPath.parent_path();
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX);
    SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS);
    AddDllDirectory(directory.wstring().c_str());
    handle_ = LoadLibraryExW(dllPath.wstring().c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS);
    if (!handle_) throw HelperError("DLL_LOAD_FAILED", "LoadLibraryExW failed for videoeditor.dll");
    auto symbol = GetProcAddress(handle_, kDecryptExport);
    if (!symbol) throw HelperError("DLL_EXPORT_MISSING", "EncryptUtils::decrypt export was not found");
    static_assert(sizeof(DecryptFn) == sizeof(symbol));
    std::memcpy(&decrypt_, &symbol, sizeof(decrypt_));
  }

  ~JianyingDll() {
    if (handle_) FreeLibrary(handle_);
  }

  std::string decrypt(const std::string &encrypted) const {
    MsvcStringArg input(encrypted);
    MsvcStringArg params("{}");
    MsvcString output;
    bool ok = false;
    decrypt_(nullptr, &output, &input.value, &params.value, &ok);
    const std::string plain = takeMsvcString(output);
    if (!ok || plain.empty()) throw HelperError("UNSUPPORTED_DRAFT_VERSION", "videoeditor.dll could not decrypt this draft");
    return plain;
  }

 private:
  HMODULE handle_ = nullptr;
  DecryptFn decrypt_ = nullptr;
};

struct Arguments {
  fs::path input;
  fs::path output;
  fs::path dll;
};

Arguments parseArguments(int argc, wchar_t **argv) {
  Arguments result;
  for (int index = 1; index < argc; ++index) {
    const std::wstring key(argv[index]);
    if (key == L"--input" || key == L"--output" || key == L"--dll") {
      if (++index >= argc) throw HelperError("INVALID_ARGUMENT", "missing value for " + narrow(key));
      const fs::path value(argv[index]);
      if (key == L"--input") result.input = value;
      if (key == L"--output") result.output = value;
      if (key == L"--dll") result.dll = value;
      continue;
    }
    if (key == L"--version") {
      std::wcout << L"{\"status\":\"ok\",\"protocolVersion\":1,\"version\":\"1.0.0\"}\n";
      std::exit(0);
    }
    throw HelperError("INVALID_ARGUMENT", "unknown argument: " + narrow(key));
  }
  if (result.input.empty() || result.output.empty() || result.dll.empty()) throw HelperError("INVALID_ARGUMENT", "--input, --output and --dll are required");
  return result;
}

std::vector<fs::path> inputFiles(const fs::path &input) {
  std::error_code error;
  if (fs::is_regular_file(input, error)) return {input};
  if (!fs::is_directory(input, error)) throw HelperError("INPUT_NOT_READABLE", "input is not a file or directory");
  std::vector<fs::path> files;
  for (const auto &entry : fs::directory_iterator(input)) {
    if (!entry.is_regular_file()) continue;
    const std::string name = entry.path().filename().string();
    if (name == "draft_content.json" || name == "draft_info.json" || name == "draft_meta_info.json") files.push_back(entry.path());
  }
  if (files.empty()) throw HelperError("INPUT_NOT_READABLE", "input directory contains no supported Jianying metadata");
  return files;
}

int run(int argc, wchar_t **argv) {
  const Arguments args = parseArguments(argc, argv);
  fs::create_directories(args.output);
  JianyingDll dll(args.dll);
  std::vector<std::string> files;
  for (const fs::path &input : inputFiles(args.input)) {
    const fs::path output = args.output / input.filename();
    const std::string plain = dll.decrypt(readFile(input));
    writeFile(output, plain);
    files.push_back(output.filename().string());
  }
  std::cout << "{\"status\":\"ok\",\"protocolVersion\":1,\"files\":[";
  for (std::size_t index = 0; index < files.size(); ++index) {
    if (index) std::cout << ',';
    std::cout << "\"" << jsonEscape(files[index]) << "\"";
  }
  std::cout << "]}\n";
  return 0;
}

}  // namespace

int wmain(int argc, wchar_t **argv) {
  try {
    return run(argc, argv);
  } catch (const HelperError &error) {
    std::cerr << error.what() << "\n";
    std::cout << "{\"status\":\"error\",\"protocolVersion\":1,\"code\":\"" << error.code() << "\",\"message\":\"" << jsonEscape(error.what()) << "\"}\n";
    return 1;
  } catch (const std::exception &error) {
    std::cerr << error.what() << "\n";
    std::cout << "{\"status\":\"error\",\"protocolVersion\":1,\"code\":\"HELPER_FAILED\",\"message\":\"" << jsonEscape(error.what()) << "\"}\n";
    return 1;
  }
}
