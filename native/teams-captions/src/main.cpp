#include <windows.h>
#include <ole2.h>
#include <tlhelp32.h>
#include <uiautomation.h>
#include <wrl/client.h>

#include "ocr_runtime.h"

#include <algorithm>
#include <cstdio>
#include <cwchar>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

constexpr std::wstring_view TeamsExecutableName = L"ms-teams.exe";
constexpr int MaximumSensitiveCharacters = 8'000;
constexpr DWORD ProbeTimeoutMilliseconds = 5'000;
constexpr DWORD ProbeCandidate = 0;
constexpr DWORD ProbeTeamsNotFound = 10;
constexpr DWORD ProbeWindowNotFound = 11;
constexpr DWORD ProbeUiaUnavailable = 12;
constexpr DWORD CursorUnavailable = 20;
constexpr DWORD CursorElementUnavailable = 21;
constexpr DWORD CursorTeamsElementRequired = 22;
constexpr DWORD CursorSuccessBase = 64;

class UniqueHandle final {
public:
    explicit UniqueHandle(HANDLE handle = nullptr) noexcept : handle_(handle) {}
    ~UniqueHandle() { reset(); }
    UniqueHandle(const UniqueHandle&) = delete;
    UniqueHandle& operator=(const UniqueHandle&) = delete;
    HANDLE get() const noexcept { return handle_; }
    explicit operator bool() const noexcept { return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE; }
    void reset(HANDLE replacement = nullptr) noexcept {
        if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) CloseHandle(handle_);
        handle_ = replacement;
    }
private:
    HANDLE handle_;
};

bool WriteText(std::string_view text) {
    const std::size_t written = std::fwrite(text.data(), 1, text.size(), stdout);
    return written == text.size();
}

std::unordered_set<DWORD> FindTeamsProcesses() {
    std::unordered_set<DWORD> matches;
    UniqueHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    if (!snapshot) return matches;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (!Process32FirstW(snapshot.get(), &entry)) return matches;
    do {
        if (_wcsicmp(entry.szExeFile, TeamsExecutableName.data()) == 0) matches.insert(entry.th32ProcessID);
    } while (Process32NextW(snapshot.get(), &entry));
    return matches;
}

bool IsExpectedTeamsProcess(DWORD processId) {
    UniqueHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId));
    if (!process) return false;
    std::vector<wchar_t> path(32'768);
    DWORD length = static_cast<DWORD>(path.size());
    if (!QueryFullProcessImageNameW(process.get(), 0, path.data(), &length)) return false;
    const std::wstring_view fullPath(path.data(), length);
    const std::size_t separator = fullPath.find_last_of(L"\\/");
    const std::wstring executable(fullPath.substr(separator == std::wstring_view::npos ? 0 : separator + 1));
    return _wcsicmp(executable.c_str(), TeamsExecutableName.data()) == 0;
}

struct WindowContext final {
    const std::unordered_set<DWORD>* processIds;
    std::vector<HWND>* windows;
};

BOOL CALLBACK CollectTeamsWindows(HWND window, LPARAM parameter) {
    auto* context = reinterpret_cast<WindowContext*>(parameter);
    DWORD processId = 0;
    GetWindowThreadProcessId(window, &processId);
    if (IsWindowVisible(window) && context->processIds->contains(processId)) context->windows->push_back(window);
    return TRUE;
}

int RunContract() {
    return WriteText(
        "{\"contractVersion\":1,\"commands\":[\"probe\",\"probe-at-cursor\",\"ocr-status\",\"ocr-capture\"],"
        "\"contentEmitted\":false,\"contentPersisted\":false}\n") ? 0 : 3;
}

DWORD RunProbeWorker(IUIAutomation* automation) {
    const auto processIds = FindTeamsProcesses();
    if (processIds.empty()) return ProbeTeamsNotFound;
    std::vector<HWND> windows;
    WindowContext context{&processIds, &windows};
    EnumWindows(CollectTeamsWindows, reinterpret_cast<LPARAM>(&context));
    if (windows.empty()) return ProbeWindowNotFound;

    for (HWND window : windows) {
        ComPtr<IUIAutomationElement> root;
        if (SUCCEEDED(automation->ElementFromHandle(window, &root)) && root) return ProbeCandidate;
    }
    return ProbeUiaUnavailable;
}

std::size_t SecureLengthAndFree(BSTR value) {
    if (value == nullptr) return 0;
    const UINT length = SysStringLen(value);
    SecureZeroMemory(value, SysStringByteLen(value));
    SysFreeString(value);
    return length;
}

DWORD RunProbeAtCursorWorker(IUIAutomation* automation) {
    POINT point{};
    if (!GetCursorPos(&point)) return CursorUnavailable;
    ComPtr<IUIAutomationElement> element;
    if (FAILED(automation->ElementFromPoint(point, &element)) || !element) return CursorElementUnavailable;
    int processId = 0;
    if (FAILED(element->get_CurrentProcessId(&processId)) || processId <= 0 || !IsExpectedTeamsProcess(static_cast<DWORD>(processId))) {
        return CursorTeamsElementRequired;
    }

    CONTROLTYPEID controlType = 0;
    element->get_CurrentControlType(&controlType);
    BSTR name = nullptr;
    const HRESULT nameResult = element->get_CurrentName(&name);
    const std::size_t nameCharacters = SUCCEEDED(nameResult) ? SecureLengthAndFree(name) : 0;

    bool textPatternAvailable = false;
    std::size_t textCharacters = 0;
    if (controlType == UIA_TextControlTypeId) {
        ComPtr<IUIAutomationTextPattern> pattern;
        if (SUCCEEDED(element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&pattern))) && pattern) {
            textPatternAvailable = true;
            ComPtr<IUIAutomationTextRange> range;
            if (SUCCEEDED(pattern->get_DocumentRange(&range)) && range) {
                BSTR text = nullptr;
                if (SUCCEEDED(range->GetText(MaximumSensitiveCharacters + 1, &text))) textCharacters = SecureLengthAndFree(text);
            }
        }
    }

    DWORD flags = 0;
    if (nameCharacters > 0) flags |= 1;
    if (nameCharacters <= static_cast<std::size_t>(MaximumSensitiveCharacters)) flags |= 2;
    if (controlType == UIA_TextControlTypeId) flags |= 4;
    if (textPatternAvailable) flags |= 8;
    if (textCharacters > 0) flags |= 16;
    if (textCharacters <= static_cast<std::size_t>(MaximumSensitiveCharacters)) flags |= 32;
    return CursorSuccessBase | flags;
}

int EmitSimpleState(std::string_view state, bool contentInspected = false) {
    std::string json = "{\"contractVersion\":1,\"state\":\"";
    json += state;
    json += "\",\"contentInspected\":";
    json += contentInspected ? "true" : "false";
    json += ",\"contentEmitted\":false,\"contentPersisted\":false}\n";
    return WriteText(json) ? 0 : 3;
}

int EmitWorkerResult(DWORD result, bool cursorProbe) {
    if (!cursorProbe) {
        if (result == ProbeCandidate) return EmitSimpleState("candidate-found");
        if (result == ProbeTeamsNotFound) return EmitSimpleState("teams-not-found") == 0 ? 2 : 3;
        if (result == ProbeWindowNotFound) return EmitSimpleState("teams-window-not-found") == 0 ? 2 : 3;
        return EmitSimpleState("uia-unavailable") == 0 ? 2 : 3;
    }
    if (result == CursorUnavailable) return EmitSimpleState("cursor-unavailable") == 0 ? 2 : 3;
    if (result == CursorElementUnavailable) return EmitSimpleState("element-unavailable") == 0 ? 2 : 3;
    if (result == CursorTeamsElementRequired) return EmitSimpleState("teams-element-required") == 0 ? 2 : 3;
    if (result < CursorSuccessBase || result > CursorSuccessBase + 63) {
        return EmitSimpleState("uia-unavailable") == 0 ? 2 : 3;
    }

    const DWORD flags = result - CursorSuccessBase;
    std::ostringstream json;
    json << "{\"contractVersion\":1,\"state\":\"teams-element-inspected\""
         << ",\"namePresent\":" << ((flags & 1) != 0 ? "true" : "false")
         << ",\"nameWithinLimit\":" << ((flags & 2) != 0 ? "true" : "false")
         << ",\"textControl\":" << ((flags & 4) != 0 ? "true" : "false")
         << ",\"textPatternAvailable\":" << ((flags & 8) != 0 ? "true" : "false")
         << ",\"textPresent\":" << ((flags & 16) != 0 ? "true" : "false")
         << ",\"textWithinLimit\":" << ((flags & 32) != 0 ? "true" : "false")
         << ",\"contentInspected\":true,\"contentEmitted\":false,\"contentPersisted\":false}\n";
    return WriteText(json.str()) ? 0 : 3;
}

int RunBoundedWorker(std::wstring_view workerArgument, bool cursorProbe) {
    std::vector<wchar_t> executable(32'768);
    const DWORD length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
    if (length == 0 || length >= executable.size()) return EmitSimpleState("helper-launch-failed") == 0 ? 2 : 3;
    std::wstring command = L"\"";
    command.append(executable.data(), length);
    command += L"\" ";
    command += workerArgument;
    std::vector<wchar_t> mutableCommand(command.begin(), command.end());
    mutableCommand.push_back(L'\0');

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION processInfo{};
    if (!CreateProcessW(nullptr, mutableCommand.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &processInfo)) {
        return EmitSimpleState("helper-launch-failed") == 0 ? 2 : 3;
    }
    UniqueHandle process(processInfo.hProcess);
    UniqueHandle thread(processInfo.hThread);
    const DWORD waitResult = WaitForSingleObject(process.get(), ProbeTimeoutMilliseconds);
    if (waitResult == WAIT_TIMEOUT) {
        TerminateProcess(process.get(), 2);
        WaitForSingleObject(process.get(), 1'000);
        return EmitSimpleState("probe-timeout") == 0 ? 2 : 3;
    }
    if (waitResult != WAIT_OBJECT_0) return EmitSimpleState("probe-failed") == 0 ? 2 : 3;
    DWORD workerResult = 0;
    if (!GetExitCodeProcess(process.get(), &workerResult)) return EmitSimpleState("probe-failed") == 0 ? 2 : 3;
    return EmitWorkerResult(workerResult, cursorProbe);
}

void PrintUsage() {
    WriteText(
        "Usage:\n"
        "  techmap-captions contract\n"
        "  techmap-captions probe\n"
        "  techmap-captions probe-at-cursor --consent-confirmed\n"
        "  techmap-captions ocr-status\n"
        "  techmap-captions ocr-capture --consent-confirmed --session-proof <companion-generated>\n");
}

std::optional<std::string> ParseSessionProof(const wchar_t* value) {
    if (!value || wcslen(value) != 64) return std::nullopt;
    std::string proof;
    proof.reserve(64);
    for (std::size_t index = 0; index < 64; ++index) {
        const wchar_t character = value[index];
        if (!((character >= L'0' && character <= L'9') || (character >= L'a' && character <= L'f'))) return std::nullopt;
        proof.push_back(static_cast<char>(character));
    }
    return proof;
}

} // namespace

int wmain(int argc, wchar_t* argv[]) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    if (argc == 2 && wcscmp(argv[1], L"contract") == 0) return RunContract();
    if (argc == 2 && wcscmp(argv[1], L"ocr-status") == 0) return techmap::captions::RunOcrStatus();
    if (argc >= 2 && wcscmp(argv[1], L"ocr-capture") == 0) {
        const bool consentConfirmed = argc == 5 && wcscmp(argv[2], L"--consent-confirmed") == 0 && wcscmp(argv[3], L"--session-proof") == 0;
        const auto sessionProof = consentConfirmed ? ParseSessionProof(argv[4]) : std::nullopt;
        if (!sessionProof) return EmitSimpleState("consent-required") == 0 ? 2 : 3;
        return techmap::captions::RunOcrCapture(std::move(*sessionProof));
    }
    if (argc == 8 && wcscmp(argv[1], L"capture-frame-worker") == 0) {
        wchar_t* end = nullptr;
        const auto window = static_cast<std::uintptr_t>(_wcstoui64(argv[2], &end, 10));
        if (!end || *end != L'\0' || window == 0) return 1;
        auto parseCoordinate = [](const wchar_t* value, std::int32_t& output) {
            wchar_t* parsedEnd = nullptr;
            const long long parsed = _wcstoi64(value, &parsedEnd, 10);
            if (!parsedEnd || *parsedEnd != L'\0' || parsed < INT32_MIN || parsed > INT32_MAX) return false;
            output = static_cast<std::int32_t>(parsed);
            return true;
        };
        techmap::captions::PixelRect selection{};
        if (!parseCoordinate(argv[3], selection.left) || !parseCoordinate(argv[4], selection.top) ||
            !parseCoordinate(argv[5], selection.right) || !parseCoordinate(argv[6], selection.bottom)) return 1;
        wchar_t* dpiEnd = nullptr;
        const unsigned long dpi = wcstoul(argv[7], &dpiEnd, 10);
        if (!dpiEnd || *dpiEnd != L'\0' || dpi == 0 || dpi > UINT32_MAX) return 1;
        return techmap::captions::RunCaptureFrameWorker(window, selection, static_cast<std::uint32_t>(dpi));
    }

    if (argc == 2 && wcscmp(argv[1], L"probe") == 0) return RunBoundedWorker(L"probe-worker", false);
    if (argc >= 2 && wcscmp(argv[1], L"probe-at-cursor") == 0) {
        bool consentConfirmed = false;
        bool valid = true;
        for (int index = 2; index < argc; ++index) {
            if (wcscmp(argv[index], L"--consent-confirmed") == 0) consentConfirmed = true;
            else valid = false;
        }
        if (!valid) {
            PrintUsage();
            return 1;
        }
        if (!consentConfirmed) return EmitSimpleState("consent-required") == 0 ? 2 : 3;
        return RunBoundedWorker(L"probe-at-cursor-worker --consent-confirmed", true);
    }

    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE) return 1;
    const bool shouldUninitialize = SUCCEEDED(initialized);
    ComPtr<IUIAutomation> automation;
    const HRESULT created = CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation));
    int exitCode = 1;
    if (FAILED(created) || !automation) {
        exitCode = static_cast<int>(ProbeUiaUnavailable);
    } else if (argc == 2 && wcscmp(argv[1], L"probe-worker") == 0) {
        exitCode = static_cast<int>(RunProbeWorker(automation.Get()));
    } else if (argc == 3 && wcscmp(argv[1], L"probe-at-cursor-worker") == 0 && wcscmp(argv[2], L"--consent-confirmed") == 0) {
        exitCode = static_cast<int>(RunProbeAtCursorWorker(automation.Get()));
    } else {
        PrintUsage();
    }
    if (shouldUninitialize) CoUninitialize();
    return exitCode;
}
