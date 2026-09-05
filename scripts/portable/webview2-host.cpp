#include <windows.h>
#include <shellapi.h>

#include <string>

#include <webview/webview.h>

#define IDI_APP_ICON 101

namespace {

std::string utf8_from_wide(const std::wstring &value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
                                       value.data(), static_cast<int>(value.size()),
                                       nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string result(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                      static_cast<int>(value.size()), &result[0], size,
                      nullptr, nullptr);
  return result;
}

std::wstring wide_from_utf8(const char *value) {
  if (!value || !*value) return {};
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value,
                                       -1, nullptr, 0);
  if (size <= 1) return {};
  std::wstring result(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1,
                      &result[0], size);
  result.resize(static_cast<size_t>(size - 1));
  return result;
}

void show_error(const std::wstring &message) {
  MessageBoxW(nullptr, message.c_str(), L"Codex Proxy WebView2", MB_OK | MB_ICONERROR);
}

void show_usage() {
  MessageBoxW(nullptr,
              L"Usage: webview2-host.exe --url URL [--title TITLE] [--width N] [--height N]",
              L"Codex Proxy WebView2", MB_OK | MB_ICONINFORMATION);
}

bool parse_positive_int(const std::wstring &value, int &target) {
  if (value.empty()) return false;
  wchar_t *end = nullptr;
  const long parsed = wcstol(value.c_str(), &end, 10);
  if (end == value.c_str() || *end != L'\0' || parsed < 100 || parsed > 10000) {
    return false;
  }
  target = static_cast<int>(parsed);
  return true;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  int argc = 0;
  LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) {
    show_error(L"Could not parse the command line.");
    return 2;
  }

  std::wstring url;
  std::wstring title = L"Codex Proxy";
  int width = 1280;
  int height = 900;

  for (int i = 1; i < argc; ++i) {
    const std::wstring argument(argv[i]);
    if (argument == L"--help" || argument == L"-h") {
      LocalFree(argv);
      show_usage();
      return 0;
    }
    if (argument == L"--url" || argument == L"--title" ||
        argument == L"--width" || argument == L"--height") {
      if (i + 1 >= argc) {
        LocalFree(argv);
        show_error(L"Missing value for " + argument + L".");
        return 2;
      }
      const std::wstring value(argv[++i]);
      if (argument == L"--url") {
        url = value;
      } else if (argument == L"--title") {
        title = value;
      } else if (argument == L"--width") {
        if (!parse_positive_int(value, width)) {
          LocalFree(argv);
          show_error(L"Invalid --width value.");
          return 2;
        }
      } else if (!parse_positive_int(value, height)) {
        LocalFree(argv);
        show_error(L"Invalid --height value.");
        return 2;
      }
      continue;
    }
    if (argument.rfind(L"--url=", 0) == 0) {
      url = argument.substr(6);
      continue;
    }
    LocalFree(argv);
    show_error(L"Unknown argument: " + argument);
    return 2;
  }
  LocalFree(argv);

  if (url.empty()) {
    show_error(L"A URL is required. Use --url http://127.0.0.1:PORT/.");
    return 2;
  }

  const std::string url_utf8 = utf8_from_wide(url);
  if (url_utf8.empty()) {
    show_error(L"The URL could not be converted to UTF-8.");
    return 2;
  }

  try {
    // webview 0.12 uses the WebView2 backend on Windows. Its built-in loader
    // keeps this host usable with MinGW without a Visual C++ import library.
    webview::webview window(false, nullptr);
    const auto native_window = window.window();
    HICON icon = LoadIconW(instance, MAKEINTRESOURCEW(IDI_APP_ICON));
    if (icon && native_window.ok()) {
      HWND hwnd = static_cast<HWND>(native_window.value());
      SendMessageW(hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(icon));
      SendMessageW(hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(icon));
    }
    window.set_title(utf8_from_wide(title));
    window.set_size(width, height, WEBVIEW_HINT_NONE);
    window.navigate(url_utf8);
    window.run();
  } catch (const webview::exception &error) {
    show_error(L"WebView2 initialization failed: " + wide_from_utf8(error.what()));
    return 1;
  } catch (...) {
    show_error(L"WebView2 initialization failed for an unknown reason.");
    return 1;
  }

  return 0;
}
