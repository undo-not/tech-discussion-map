#include <windows.h>
#include <ole2.h>
#include <tlhelp32.h>
#include <uiautomation.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstdio>
#include <cwchar>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

constexpr std::wstring_view TeamsExecutableName = L"ms-teams.exe";
constexpr int MaximumSensitiveCharacters = 8'000;

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
        "{\"contractVersion\":1,\"commands\":[\"probe\",\"probe-at-cursor\"],"
        "\"contentEmitted\":false,\"contentPersisted\":false}\n") ? 0 : 3;
}

int RunProbe(IUIAutomation* automation) {
    const auto processIds = FindTeamsProcesses();
    std::vector<HWND> windows;
    WindowContext context{&processIds, &windows};
    EnumWindows(CollectTeamsWindows, reinterpret_cast<LPARAM>(&context));

    std::size_t roots = 0;
    for (HWND window : windows) {
        ComPtr<IUIAutomationElement> root;
        if (SUCCEEDED(automation->ElementFromHandle(window, &root)) && root) ++roots;
    }

    const char* state = processIds.empty() ? "teams-not-found"
        : windows.empty() ? "teams-window-not-found"
        : roots == 0 ? "uia-unavailable"
        : "candidate-found";
    std::ostringstream json;
    json << "{\"contractVersion\":1,\"state\":\"" << state
         << "\",\"teamsProcessCount\":" << processIds.size()
         << ",\"teamsWindowCount\":" << windows.size()
         << ",\"uiaRootCount\":" << roots
         << ",\"contentInspected\":false,\"contentEmitted\":false,\"contentPersisted\":false}\n";
    if (!WriteText(json.str())) return 3;
    return std::string_view(state) == "candidate-found" ? 0 : 2;
}

std::size_t SecureLengthAndFree(BSTR value) {
    if (value == nullptr) return 0;
    const UINT length = SysStringLen(value);
    SecureZeroMemory(value, SysStringByteLen(value));
    SysFreeString(value);
    return length;
}

int RunProbeAtCursor(IUIAutomation* automation, bool consentConfirmed) {
    if (!consentConfirmed) {
        WriteText("{\"contractVersion\":1,\"state\":\"consent-required\",\"contentEmitted\":false,\"contentPersisted\":false}\n");
        return 2;
    }
    POINT point{};
    if (!GetCursorPos(&point)) {
        WriteText("{\"contractVersion\":1,\"state\":\"cursor-unavailable\",\"contentEmitted\":false,\"contentPersisted\":false}\n");
        return 2;
    }
    ComPtr<IUIAutomationElement> element;
    if (FAILED(automation->ElementFromPoint(point, &element)) || !element) {
        WriteText("{\"contractVersion\":1,\"state\":\"element-unavailable\",\"contentEmitted\":false,\"contentPersisted\":false}\n");
        return 2;
    }
    int processId = 0;
    if (FAILED(element->get_CurrentProcessId(&processId)) || processId <= 0 || !IsExpectedTeamsProcess(static_cast<DWORD>(processId))) {
        WriteText("{\"contractVersion\":1,\"state\":\"teams-element-required\",\"contentEmitted\":false,\"contentPersisted\":false}\n");
        return 2;
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

    std::ostringstream json;
    json << "{\"contractVersion\":1,\"state\":\"teams-element-inspected\""
         << ",\"controlType\":" << controlType
         << ",\"namePresent\":" << (nameCharacters > 0 ? "true" : "false")
         << ",\"nameWithinLimit\":" << (nameCharacters <= static_cast<std::size_t>(MaximumSensitiveCharacters) ? "true" : "false")
         << ",\"textPatternAvailable\":" << (textPatternAvailable ? "true" : "false")
         << ",\"textPresent\":" << (textCharacters > 0 ? "true" : "false")
         << ",\"textWithinLimit\":" << (textCharacters <= static_cast<std::size_t>(MaximumSensitiveCharacters) ? "true" : "false")
         << ",\"contentInspected\":true,\"contentEmitted\":false,\"contentPersisted\":false}\n";
    return WriteText(json.str()) ? 0 : 3;
}

void PrintUsage() {
    WriteText(
        "Usage:\n"
        "  techmap-captions contract\n"
        "  techmap-captions probe\n"
        "  techmap-captions probe-at-cursor --consent-confirmed\n");
}

} // namespace

int wmain(int argc, wchar_t* argv[]) {
    if (argc == 2 && wcscmp(argv[1], L"contract") == 0) return RunContract();

    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE) return 1;
    const bool shouldUninitialize = SUCCEEDED(initialized);
    ComPtr<IUIAutomation> automation;
    const HRESULT created = CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation));
    int exitCode = 1;
    if (FAILED(created) || !automation) {
        WriteText("{\"contractVersion\":1,\"state\":\"uia-unavailable\",\"contentEmitted\":false,\"contentPersisted\":false}\n");
    } else if (argc == 2 && wcscmp(argv[1], L"probe") == 0) {
        exitCode = RunProbe(automation.Get());
    } else if (argc >= 2 && wcscmp(argv[1], L"probe-at-cursor") == 0) {
        bool consentConfirmed = false;
        bool valid = true;
        for (int index = 2; index < argc; ++index) {
            if (wcscmp(argv[index], L"--consent-confirmed") == 0) consentConfirmed = true;
            else valid = false;
        }
        if (valid) exitCode = RunProbeAtCursor(automation.Get(), consentConfirmed);
        else PrintUsage();
    } else {
        PrintUsage();
    }
    if (shouldUninitialize) CoUninitialize();
    return exitCode;
}
