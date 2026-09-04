#define UNICODE
#define _UNICODE

#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>

#define NODE_DOWNLOAD_URL L"https://nodejs.org/en/download/"
#define RELEASES_URL L"https://github.com/icebear0828/codex-proxy/releases/latest"
#define NODE_PROMPT_TIMEOUT_MS 15000
#define TRAY_CALLBACK_MESSAGE (WM_APP + 1)
#define TRAY_OPEN_DASHBOARD 1001
#define TRAY_QUIT 1002
#define TRAY_OPEN_RELEASES 1003
#define TRAY_ACTIVATE_INSTANCE (WM_APP + 2)
#define IDI_APP_ICON 101
#define TRAY_CLASS_NAME L"CodexProxyPortableTrayWindow"
#define SINGLE_INSTANCE_MUTEX L"Local\\CodexProxyPortable"
#define MAX_CAPTURED_OUTPUT 32768
#define MAX_DASHBOARD_URL 2048
#define MAX_WEBVIEW2_HOST_PATH (MAX_PATH * 4)

typedef int (WINAPI *message_box_timeout_w_proc)(
    HWND, LPCWSTR, LPCWSTR, UINT, WORD, DWORD);

static HWND tray_window;
static NOTIFYICONDATAW tray_icon;
static HANDLE child_process;
static HANDLE child_job;
static HANDLE webview2_process;
static HANDLE output_read;
static HANDLE single_instance_mutex;
static int quit_requested;
static char captured_output[MAX_CAPTURED_OUTPUT];
static size_t captured_output_length;
static wchar_t dashboard_url[MAX_DASHBOARD_URL];
static wchar_t package_root[MAX_PATH * 4];
static wchar_t webview2_host_path[MAX_WEBVIEW2_HOST_PATH];
static int webview2_initial_start_attempted;

static void append_char(wchar_t *buffer, size_t capacity, size_t *length, wchar_t value) {
    if (*length + 1 >= capacity) return;
    buffer[(*length)++] = value;
    buffer[*length] = L'\0';
}

static void append_text(wchar_t *buffer, size_t capacity, size_t *length, const wchar_t *text) {
    while (*text) append_char(buffer, capacity, length, *text++);
}

/* Quote one Windows command-line argument using CommandLineToArgvW rules. */
static void append_arg(wchar_t *buffer, size_t capacity, size_t *length, const wchar_t *arg) {
    size_t slashes = 0;
    append_char(buffer, capacity, length, L'"');
    for (const wchar_t *p = arg; *p; ++p) {
        if (*p == L'\\') {
            ++slashes;
            continue;
        }
        if (*p == L'"') {
            for (size_t i = 0; i < slashes * 2 + 1; ++i) append_char(buffer, capacity, length, L'\\');
            append_char(buffer, capacity, length, L'"');
            slashes = 0;
            continue;
        }
        while (slashes--) append_char(buffer, capacity, length, L'\\');
        slashes = 0;
        append_char(buffer, capacity, length, *p);
    }
    for (size_t i = 0; i < slashes * 2; ++i) append_char(buffer, capacity, length, L'\\');
    append_char(buffer, capacity, length, L'"');
}

static int is_node_path_arg(const wchar_t *arg) {
    return wcsncmp(arg, L"--node-path=", 12) == 0 || wcscmp(arg, L"--node-path") == 0 ||
           wcsncmp(arg, L"-n=", 3) == 0 || wcscmp(arg, L"-n") == 0;
}

static int show_timeout_message(const wchar_t *message, const wchar_t *title, UINT type) {
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    int loaded = 0;
    if (!user32) {
        user32 = LoadLibraryW(L"user32.dll");
        loaded = user32 != NULL;
    }
    message_box_timeout_w_proc message_box_timeout = NULL;
    if (user32) {
        message_box_timeout = (message_box_timeout_w_proc)GetProcAddress(user32, "MessageBoxTimeoutW");
    }
    int result = message_box_timeout
        ? message_box_timeout(NULL, message, title, type, 0, NODE_PROMPT_TIMEOUT_MS)
        : MessageBoxW(NULL, message, title, type);
    if (loaded && user32) FreeLibrary(user32);
    return result;
}

static void show_node_help(DWORD error_code) {
    wchar_t message[4096];
    _snwprintf_s(
        message, sizeof(message) / sizeof(message[0]), _TRUNCATE,
        L"Codex Proxy could not start Node.js (Windows error %lu).\n\n"
        L"This portable package does not include Node.js. Install Node.js 20 or newer,\n"
        L"or select an existing executable with:\n\n"
        L"  set CODEX_PROXY_NODE=C:\\Path\\to\\node.exe\n"
        L"  codex-proxy.exe -n C:\\Path\\to\\node.exe -m auto\n\n"
        L"The command used by this launcher is:\n"
        L"  node app\\server.mjs --mode auto\n\n"
        L"Open the official Node.js download page now? (15 seconds)",
        error_code);
    if (show_timeout_message(message, L"Codex Proxy - Node.js required", MB_YESNO | MB_ICONWARNING) == IDYES) {
        ShellExecuteW(NULL, L"open", NODE_DOWNLOAD_URL, NULL, NULL, SW_SHOWNORMAL);
    }
}

static void print_usage(void) {
    fwprintf(
        stdout,
        L"Usage: codex-proxy.exe [options]\n\n"
        L"Options:\n"
        L"  --mode, -m <mode>          server, browser, auto, or webview2\n"
        L"  --portable, -p             Store runtime data in the package's data directory\n"
        L"  --host, -H <host>          Override the listen host\n"
        L"  --port, -P <port>          Override the listen port\n"
        L"  --node-path, -n <path>    Use a specific Node.js executable\n"
        L"  --help, -h                 Show this help\n");
}

static int has_help_arg(int argc, wchar_t **argv) {
    for (int i = 1; i < argc; ++i) {
        if (wcscmp(argv[i], L"--help") == 0 || wcscmp(argv[i], L"-h") == 0) return 1;
    }
    return 0;
}

static void capture_output(const char *data, size_t length) {
    if (!length) return;
    if (length >= MAX_CAPTURED_OUTPUT) {
        memcpy(captured_output, data + length - MAX_CAPTURED_OUTPUT + 1, MAX_CAPTURED_OUTPUT - 1);
        captured_output_length = MAX_CAPTURED_OUTPUT - 1;
        captured_output[captured_output_length] = '\0';
        return;
    }
    if (captured_output_length + length >= MAX_CAPTURED_OUTPUT) {
        size_t keep = MAX_CAPTURED_OUTPUT - length - 1;
        if (keep > captured_output_length) keep = captured_output_length;
        memmove(captured_output, captured_output + captured_output_length - keep, keep);
        captured_output_length = keep;
    }
    memcpy(captured_output + captured_output_length, data, length);
    captured_output_length += length;
    captured_output[captured_output_length] = '\0';
}

static void update_dashboard_url(void) {
    const char *marker = "CODEX_PROXY_READY=";
    const char *start = strstr(captured_output, marker);
    if (!start) return;
    start += strlen(marker);
    const char *end = start;
    while (*end && *end != '\r' && *end != '\n') ++end;
    size_t length = (size_t)(end - start);
    if (length == 0 || length >= MAX_DASHBOARD_URL) return;
    int converted = MultiByteToWideChar(CP_UTF8, 0, start, (int)length, dashboard_url, MAX_DASHBOARD_URL - 1);
    if (converted <= 0) converted = MultiByteToWideChar(CP_ACP, 0, start, (int)length, dashboard_url, MAX_DASHBOARD_URL - 1);
    if (converted > 0) dashboard_url[converted] = L'\0';
}

static void update_webview2_host_path(void) {
    const char *marker = "CODEX_PROXY_WEBVIEW2_HOST=";
    const char *start = strstr(captured_output, marker);
    if (!start) return;
    start += strlen(marker);
    const char *end = start;
    while (*end && *end != '\r' && *end != '\n') ++end;
    size_t length = (size_t)(end - start);
    if (length == 0 || length >= MAX_WEBVIEW2_HOST_PATH) return;
    int converted = MultiByteToWideChar(CP_UTF8, 0, start, (int)length,
                                        webview2_host_path, MAX_WEBVIEW2_HOST_PATH - 1);
    if (converted <= 0) converted = MultiByteToWideChar(
        CP_ACP, 0, start, (int)length, webview2_host_path, MAX_WEBVIEW2_HOST_PATH - 1);
    if (converted > 0) webview2_host_path[converted] = L'\0';
}

static int start_webview2_host(void);

static void drain_child_output(void) {
    if (!output_read) return;
    for (;;) {
        DWORD available = 0;
        if (!PeekNamedPipe(output_read, NULL, 0, NULL, &available, NULL) || available == 0) return;
        char buffer[4096];
        DWORD to_read = available < sizeof(buffer) ? available : (DWORD)sizeof(buffer);
        DWORD read_count = 0;
        if (!ReadFile(output_read, buffer, to_read, &read_count, NULL) || read_count == 0) return;
        capture_output(buffer, read_count);
        update_dashboard_url();
        update_webview2_host_path();
        if (dashboard_url[0] && webview2_host_path[0] && !webview2_initial_start_attempted) {
            webview2_initial_start_attempted = 1;
            start_webview2_host();
        }
    }
}

typedef struct {
    DWORD process_id;
    HWND window;
} process_window_search;

static BOOL CALLBACK find_process_window(HWND window, LPARAM parameter) {
    process_window_search *search = (process_window_search *)parameter;
    DWORD process_id = 0;
    GetWindowThreadProcessId(window, &process_id);
    if (process_id == search->process_id && IsWindowVisible(window) && !GetWindow(window, GW_OWNER)) {
        search->window = window;
        return FALSE;
    }
    return TRUE;
}

static int focus_webview2_window(void) {
    if (!webview2_process || WaitForSingleObject(webview2_process, 0) == WAIT_OBJECT_0) {
        if (webview2_process) CloseHandle(webview2_process);
        webview2_process = NULL;
        return 0;
    }
    process_window_search search = {0};
    search.process_id = GetProcessId(webview2_process);
    EnumWindows(find_process_window, (LPARAM)&search);
    if (search.window) {
        ShowWindow(search.window, SW_SHOWNORMAL);
        SetForegroundWindow(search.window);
    }
    // Keep the existing process even when its window is still initializing.
    return 1;
}

static int start_webview2_host(void) {
    if (!webview2_host_path[0] || !dashboard_url[0]) return 0;
    if (focus_webview2_window()) return 1;

    wchar_t command[MAX_WEBVIEW2_HOST_PATH + MAX_DASHBOARD_URL + 32];
    size_t command_length = 0;
    append_arg(command, sizeof(command) / sizeof(command[0]), &command_length, webview2_host_path);
    append_text(command, sizeof(command) / sizeof(command[0]), &command_length, L" --url ");
    append_arg(command, sizeof(command) / sizeof(command[0]), &command_length, dashboard_url);

    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process = {0};
    startup.cb = sizeof(startup);
    if (!CreateProcessW(
            webview2_host_path, command, NULL, NULL, FALSE,
            CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            NULL, package_root, &startup, &process)) {
        wchar_t message[1024];
        _snwprintf_s(message, sizeof(message) / sizeof(message[0]), _TRUNCATE,
                     L"The packaged WebView2 host could not be started (Windows error %lu).",
                     GetLastError());
        show_timeout_message(message, L"Codex Proxy - WebView2 Error", MB_OK | MB_ICONERROR);
        return 0;
    }
    webview2_process = process.hProcess;
    CloseHandle(process.hThread);
    if (child_job && !AssignProcessToJobObject(child_job, webview2_process)) {
        TerminateProcess(webview2_process, 1);
        CloseHandle(webview2_process);
        webview2_process = NULL;
        show_timeout_message(
            L"The WebView2 host could not be attached to the portable process group.",
            L"Codex Proxy - WebView2 Error", MB_OK | MB_ICONERROR);
        return 0;
    }
    return 1;
}

static void open_dashboard(void) {
    if (dashboard_url[0]) {
        if (webview2_host_path[0]) {
            start_webview2_host();
        } else {
            ShellExecuteW(NULL, L"open", dashboard_url, NULL, NULL, SW_SHOWNORMAL);
        }
    } else {
        show_timeout_message(
            L"The local server is still starting. Please try the tray menu again in a moment.",
            L"Codex Proxy", MB_OK | MB_ICONINFORMATION);
    }
}

static int activate_existing_instance(void) {
    for (int attempt = 0; attempt < 10; ++attempt) {
        HWND existing = FindWindowExW(HWND_MESSAGE, NULL, TRAY_CLASS_NAME, L"Codex Proxy");
        if (existing) {
            PostMessageW(existing, TRAY_ACTIVATE_INSTANCE, 0, 0);
            return 1;
        }
        Sleep(50);
    }
    return 0;
}

static int acquire_single_instance(void) {
    single_instance_mutex = CreateMutexW(NULL, TRUE, SINGLE_INSTANCE_MUTEX);
    if (!single_instance_mutex) return 1;
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        activate_existing_instance();
        CloseHandle(single_instance_mutex);
        single_instance_mutex = NULL;
        return 0;
    }
    return 1;
}

static void release_single_instance(void) {
    if (single_instance_mutex) CloseHandle(single_instance_mutex);
    single_instance_mutex = NULL;
}

static void show_tray_menu(void) {
    HMENU menu = CreatePopupMenu();
    if (!menu) return;
    AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, L"Codex Proxy");
    AppendMenuW(menu, MF_SEPARATOR, 0, NULL);
    AppendMenuW(
        menu,
        MF_STRING | (dashboard_url[0] ? 0 : MF_GRAYED),
        TRAY_OPEN_DASHBOARD,
        dashboard_url[0] ? L"Open Dashboard" : L"Starting...");
    AppendMenuW(menu, MF_SEPARATOR, 0, NULL);
    AppendMenuW(menu, MF_STRING, TRAY_OPEN_RELEASES, L"Check for Updates");
    AppendMenuW(menu, MF_SEPARATOR, 0, NULL);
    AppendMenuW(menu, MF_STRING, TRAY_QUIT, L"Quit");

    POINT point;
    GetCursorPos(&point);
    SetForegroundWindow(tray_window);
    TrackPopupMenu(menu, TPM_RIGHTBUTTON, point.x, point.y, 0, tray_window, NULL);
    PostMessageW(tray_window, WM_NULL, 0, 0);
    DestroyMenu(menu);
}

static void request_quit(void) {
    quit_requested = 1;
    if (child_process) TerminateProcess(child_process, 0);
    if (webview2_process) TerminateProcess(webview2_process, 0);
}

static LRESULT CALLBACK tray_window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == TRAY_CALLBACK_MESSAGE) {
        /* NOTIFYICON_VERSION_4 puts the event in LOWORD(lParam) and uses
           WM_CONTEXTMENU for the context-menu gesture. Older shells pass the
           mouse message directly in lParam. Accept both contracts. */
        UINT event = tray_icon.uVersion >= NOTIFYICON_VERSION_4
            ? LOWORD(lparam)
            : (UINT)lparam;
        if (event == WM_LBUTTONDBLCLK) open_dashboard();
        if (event == WM_RBUTTONUP || event == WM_CONTEXTMENU) show_tray_menu();
        return 0;
    }
    if (message == WM_COMMAND) {
        switch (LOWORD(wparam)) {
            case TRAY_OPEN_DASHBOARD:
                open_dashboard();
                return 0;
            case TRAY_QUIT:
                request_quit();
                return 0;
            case TRAY_OPEN_RELEASES:
                ShellExecuteW(NULL, L"open", RELEASES_URL, NULL, NULL, SW_SHOWNORMAL);
                return 0;
            default:
                break;
        }
    }
    if (message == TRAY_ACTIVATE_INSTANCE) {
        open_dashboard();
        return 0;
    }
    if (message == WM_QUERYENDSESSION || message == WM_ENDSESSION) {
        request_quit();
        return TRUE;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

static int install_tray(void) {
    WNDCLASSW window_class = {0};
    window_class.lpfnWndProc = tray_window_proc;
    window_class.hInstance = GetModuleHandleW(NULL);
    window_class.lpszClassName = TRAY_CLASS_NAME;
    if (!RegisterClassW(&window_class) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return 0;

    tray_window = CreateWindowExW(
        0, TRAY_CLASS_NAME, L"Codex Proxy", 0, 0, 0, 0, 0,
        HWND_MESSAGE, NULL, window_class.hInstance, NULL);
    if (!tray_window) return 0;

    memset(&tray_icon, 0, sizeof(tray_icon));
    tray_icon.cbSize = sizeof(tray_icon);
    tray_icon.hWnd = tray_window;
    tray_icon.uID = 1;
    tray_icon.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    tray_icon.uCallbackMessage = TRAY_CALLBACK_MESSAGE;
    tray_icon.hIcon = LoadIconW(GetModuleHandleW(NULL), MAKEINTRESOURCEW(IDI_APP_ICON));
    if (!tray_icon.hIcon) tray_icon.hIcon = LoadIconW(NULL, IDI_APPLICATION);
    wcsncpy(tray_icon.szTip, L"Codex Proxy", sizeof(tray_icon.szTip) / sizeof(tray_icon.szTip[0]) - 1);
    tray_icon.szTip[sizeof(tray_icon.szTip) / sizeof(tray_icon.szTip[0]) - 1] = L'\0';
    if (!Shell_NotifyIconW(NIM_ADD, &tray_icon)) {
        DestroyWindow(tray_window);
        tray_window = NULL;
        return 0;
    }
    tray_icon.uVersion = NOTIFYICON_VERSION_4;
    Shell_NotifyIconW(NIM_SETVERSION, &tray_icon);
    return 1;
}

static void remove_tray(void) {
    if (tray_window) Shell_NotifyIconW(NIM_DELETE, &tray_icon);
    if (tray_window) DestroyWindow(tray_window);
    tray_window = NULL;
}

static int start_child(const wchar_t *root, wchar_t *command) {
    SECURITY_ATTRIBUTES security = {0};
    security.nLength = sizeof(security);
    security.bInheritHandle = TRUE;

    HANDLE output_write = NULL;
    HANDLE input_null = CreateFileW(
        L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &security, OPEN_EXISTING, 0, NULL);
    if (input_null == INVALID_HANDLE_VALUE) input_null = NULL;
    if (!CreatePipe(&output_read, &output_write, &security, 0)) {
        if (input_null) CloseHandle(input_null);
        output_read = NULL;
        return 0;
    }
    SetHandleInformation(output_read, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process = {0};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = input_null;
    startup.hStdOutput = output_write;
    startup.hStdError = output_write;

    BOOL created = CreateProcessW(
        NULL, command, NULL, NULL, TRUE,
        CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | CREATE_SUSPENDED,
        NULL, root, &startup, &process);
    CloseHandle(output_write);
    if (input_null) CloseHandle(input_null);
    if (!created) {
        CloseHandle(output_read);
        output_read = NULL;
        return 0;
    }

    child_process = process.hProcess;
    child_job = CreateJobObjectW(NULL, NULL);
    if (child_job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(
                child_job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
            !AssignProcessToJobObject(child_job, child_process)) {
            CloseHandle(child_job);
            child_job = NULL;
        }
    }
    ResumeThread(process.hThread);
    CloseHandle(process.hThread);
    return 1;
}

static DWORD wait_for_child(void) {
    for (;;) {
        drain_child_output();
        DWORD wait = MsgWaitForMultipleObjects(1, &child_process, FALSE, 100, QS_ALLINPUT);
        if (wait == WAIT_OBJECT_0) break;
        if (wait == WAIT_OBJECT_0 + 1) {
            MSG message;
            while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) {
                if (message.message == WM_QUIT) {
                    request_quit();
                } else {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        }
    }
    drain_child_output();
    DWORD exit_code = 1;
    GetExitCodeProcess(child_process, &exit_code);
    return exit_code;
}

static void offer_webview2_install(const wchar_t *root) {
    const wchar_t *installer = L"tools\\MicrosoftEdgeWebView2Setup.exe";
    wchar_t installer_path[MAX_PATH * 4];
    _snwprintf_s(installer_path, sizeof(installer_path) / sizeof(installer_path[0]), _TRUNCATE,
                 L"%s\\%s", root, installer);

    wchar_t question[2048];
    if (GetFileAttributesW(installer_path) != INVALID_FILE_ATTRIBUTES) {
        _snwprintf_s(
            question, sizeof(question) / sizeof(question[0]), _TRUNCATE,
            L"WebView2 Runtime is required for the requested mode but is not installed.\n\n"
            L"Run the packaged online installer now? (15 seconds)");
        if (show_timeout_message(question, L"Codex Proxy - WebView2 required", MB_YESNO | MB_ICONWARNING) != IDYES) return;

        wchar_t command[8192];
        size_t command_length = 0;
        append_arg(command, sizeof(command) / sizeof(command[0]), &command_length, installer_path);
        append_text(command, sizeof(command) / sizeof(command[0]), &command_length, L" /silent /install");
        STARTUPINFOW startup = {0};
        PROCESS_INFORMATION process = {0};
        startup.cb = sizeof(startup);
        if (CreateProcessW(NULL, command, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                           NULL, root, &startup, &process)) {
            WaitForSingleObject(process.hProcess, INFINITE);
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            show_timeout_message(
                L"The WebView2 installer has finished. Start codex-proxy.exe again to use WebView2.",
                L"Codex Proxy", MB_OK | MB_ICONINFORMATION);
        } else {
            show_timeout_message(
                L"The WebView2 installer could not be started. Use the official WebView2 installation page instead.",
                L"Codex Proxy - WebView2 required", MB_OK | MB_ICONWARNING);
            ShellExecuteW(NULL, L"open", L"https://developer.microsoft.com/microsoft-edge/webview2/",
                          NULL, NULL, SW_SHOWNORMAL);
        }
        return;
    }

    if (show_timeout_message(
            L"WebView2 Runtime is required for the requested mode but is not installed.\n\n"
            L"Open the official WebView2 installation page now? (15 seconds)",
            L"Codex Proxy - WebView2 required", MB_YESNO | MB_ICONWARNING) == IDYES) {
        ShellExecuteW(NULL, L"open", L"https://developer.microsoft.com/microsoft-edge/webview2/",
                      NULL, NULL, SW_SHOWNORMAL);
    }
}

static void show_child_failure(const wchar_t *root, DWORD exit_code) {
    if (quit_requested || exit_code == 0) return;
    if (strstr(captured_output, "WebView2 Runtime is required") != NULL) {
        offer_webview2_install(root);
        return;
    }
    wchar_t detail[4096];
    int converted = 0;
    if (captured_output_length > 0) {
        size_t length = captured_output_length < 3000 ? captured_output_length : 3000;
        converted = MultiByteToWideChar(CP_UTF8, 0, captured_output, (int)length, detail, 3800);
        if (converted <= 0) converted = MultiByteToWideChar(CP_ACP, 0, captured_output, (int)length, detail, 3800);
    }
    if (converted <= 0) {
        _snwprintf_s(detail, sizeof(detail) / sizeof(detail[0]), _TRUNCATE,
                     L"The portable server stopped before it was ready (exit code %lu).", exit_code);
    } else {
        detail[converted] = L'\0';
    }
    show_timeout_message(detail, L"Codex Proxy - Startup Error", MB_OK | MB_ICONERROR);
}

int wmain(int argc, wchar_t **argv) {
    wchar_t root[MAX_PATH * 4];
    DWORD length = GetModuleFileNameW(NULL, root, (DWORD)(sizeof(root) / sizeof(root[0])));
    if (length == 0 || length >= sizeof(root) / sizeof(root[0])) {
        show_timeout_message(L"Unable to locate codex-proxy.exe.", L"Codex Proxy", MB_OK | MB_ICONERROR);
        return 1;
    }
    wchar_t *slash = wcsrchr(root, L'\\');
    if (!slash) {
        show_timeout_message(L"Unable to locate the portable package directory.", L"Codex Proxy", MB_OK | MB_ICONERROR);
        return 1;
    }
    *slash = L'\0';
    wcsncpy(package_root, root, sizeof(package_root) / sizeof(package_root[0]) - 1);
    package_root[sizeof(package_root) / sizeof(package_root[0]) - 1] = L'\0';
    if (!SetCurrentDirectoryW(root)) {
        wchar_t message[512];
        _snwprintf_s(message, sizeof(message) / sizeof(message[0]), _TRUNCATE,
                     L"Unable to enter portable package directory (error %lu).", GetLastError());
        show_timeout_message(message, L"Codex Proxy", MB_OK | MB_ICONERROR);
        return 1;
    }

    if (has_help_arg(argc, argv)) {
        print_usage();
        return 0;
    }

    if (!acquire_single_instance()) return 0;

    const wchar_t *node_path = _wgetenv(L"CODEX_PROXY_NODE");
    wchar_t explicit_node[MAX_PATH * 4];
    explicit_node[0] = L'\0';
    int *skip_arg = (int *)calloc((size_t)argc, sizeof(int));
    if (!skip_arg) {
        release_single_instance();
        show_timeout_message(L"Unable to allocate launcher argument state.", L"Codex Proxy", MB_OK | MB_ICONERROR);
        return 1;
    }
    for (int i = 1; i < argc; ++i) {
        if (wcsncmp(argv[i], L"--node-path=", 12) == 0 || wcsncmp(argv[i], L"-n=", 3) == 0) {
            const wchar_t *value = wcsncmp(argv[i], L"-n=", 3) == 0 ? argv[i] + 3 : argv[i] + 12;
            wcsncpy(explicit_node, value, (sizeof(explicit_node) / sizeof(explicit_node[0])) - 1);
            explicit_node[(sizeof(explicit_node) / sizeof(explicit_node[0])) - 1] = L'\0';
            skip_arg[i] = 1;
            continue;
        }
        if ((wcscmp(argv[i], L"--node-path") == 0 || wcscmp(argv[i], L"-n") == 0) && i + 1 >= argc) {
            show_timeout_message(L"--node-path requires a path.", L"Codex Proxy", MB_OK | MB_ICONWARNING);
            release_single_instance();
            free(skip_arg);
            return 2;
        }
        if ((wcscmp(argv[i], L"--node-path") == 0 || wcscmp(argv[i], L"-n") == 0) && i + 1 < argc) {
            wcsncpy(explicit_node, argv[i + 1], (sizeof(explicit_node) / sizeof(explicit_node[0])) - 1);
            explicit_node[(sizeof(explicit_node) / sizeof(explicit_node[0])) - 1] = L'\0';
            skip_arg[i] = 1;
            skip_arg[i + 1] = 1;
            ++i;
        }
    }
    if (explicit_node[0]) node_path = explicit_node;
    if (!node_path || !node_path[0]) node_path = L"node";

    size_t capacity = 1024 * 64;
    wchar_t *command = (wchar_t *)calloc(capacity, sizeof(wchar_t));
    if (!command) {
        free(skip_arg);
        release_single_instance();
        show_timeout_message(L"Unable to allocate launcher command state.", L"Codex Proxy", MB_OK | MB_ICONERROR);
        return 1;
    }
    size_t command_length = 0;
    append_arg(command, capacity, &command_length, node_path);
    append_char(command, capacity, &command_length, L' ');
    append_arg(command, capacity, &command_length, L"app\\server.mjs");

    int app_arg_count = 0;
    for (int i = 1; i < argc; ++i) {
        if (skip_arg[i] || is_node_path_arg(argv[i])) continue;
        append_char(command, capacity, &command_length, L' ');
        append_arg(command, capacity, &command_length, argv[i]);
        ++app_arg_count;
    }
    if (app_arg_count == 0) append_text(command, capacity, &command_length, L" --mode=auto");

    dashboard_url[0] = L'\0';
    captured_output_length = 0;
    captured_output[0] = '\0';
    if (!install_tray()) {
        /* A missing notification-area shell should not prevent server use. */
        tray_window = NULL;
    }
    // Keep GUI ownership in this native launcher. The Node wrapper still
    // launches WebView2 when run directly through .cmd or Node itself.
    SetEnvironmentVariableW(L"CODEX_PROXY_NATIVE_TRAY", L"1");

    if (!start_child(root, command)) {
        const DWORD error_code = GetLastError();
        remove_tray();
        show_node_help(error_code);
        release_single_instance();
        free(command);
        free(skip_arg);
        return 127;
    }

    DWORD exit_code = wait_for_child();
    show_child_failure(root, exit_code);
    if (webview2_process) {
        if (WaitForSingleObject(webview2_process, 0) != WAIT_OBJECT_0) {
            TerminateProcess(webview2_process, 0);
        }
        CloseHandle(webview2_process);
        webview2_process = NULL;
    }
    remove_tray();
    if (output_read) CloseHandle(output_read);
    if (child_job) CloseHandle(child_job);
    if (child_process) CloseHandle(child_process);
    release_single_instance();
    free(command);
    free(skip_arg);
    return (int)exit_code;
}
