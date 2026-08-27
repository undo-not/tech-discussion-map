#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <tlhelp32.h>
#include <winternl.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <iomanip>
#include <memory>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

#include "capture_state.h"

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;

namespace {

constexpr DWORD MinimumProcessLoopbackBuild = 20'348;
constexpr std::uint8_t ProtocolVersion = 1;
constexpr std::size_t ProtocolHeaderSize = 12;
constexpr std::wstring_view TeamsExecutableName = L"ms-teams.exe";

enum class FrameType : std::uint8_t {
    State = 1,
    Pcm = 2,
    Format = 3,
};

std::atomic_bool g_stopRequested{false};

BOOL WINAPI HandleConsoleControl(DWORD controlType) {
    if (controlType == CTRL_C_EVENT || controlType == CTRL_BREAK_EVENT || controlType == CTRL_CLOSE_EVENT) {
        g_stopRequested.store(true);
        return TRUE;
    }
    return FALSE;
}

class UniqueHandle final {
public:
    UniqueHandle() noexcept = default;
    explicit UniqueHandle(HANDLE handle) noexcept : handle_(handle) {}
    ~UniqueHandle() { reset(); }

    UniqueHandle(const UniqueHandle&) = delete;
    UniqueHandle& operator=(const UniqueHandle&) = delete;

    UniqueHandle(UniqueHandle&& other) noexcept : handle_(other.release()) {}
    UniqueHandle& operator=(UniqueHandle&& other) noexcept {
        if (this != &other) {
            reset(other.release());
        }
        return *this;
    }

    HANDLE get() const noexcept { return handle_; }
    explicit operator bool() const noexcept { return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE; }

    HANDLE release() noexcept {
        HANDLE released = handle_;
        handle_ = nullptr;
        return released;
    }

    void reset(HANDLE replacement = nullptr) noexcept {
        if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) {
            CloseHandle(handle_);
        }
        handle_ = replacement;
    }

private:
    HANDLE handle_{nullptr};
};

bool WriteAll(HANDLE output, const void* data, std::size_t size) {
    const auto* cursor = static_cast<const std::uint8_t*>(data);
    std::size_t remaining = size;
    while (remaining > 0) {
        const DWORD chunk = static_cast<DWORD>(std::min<std::size_t>(remaining, MAXDWORD));
        DWORD written = 0;
        if (!WriteFile(output, cursor, chunk, &written, nullptr) || written == 0) {
            return false;
        }
        cursor += written;
        remaining -= written;
    }
    return true;
}

bool WriteText(std::string_view text) {
    return WriteAll(GetStdHandle(STD_OUTPUT_HANDLE), text.data(), text.size());
}

bool WriteFrame(FrameType type, const std::uint8_t* payload, std::uint32_t payloadSize) {
    std::uint8_t header[ProtocolHeaderSize] = {
        'T', 'M', 'A', '1', ProtocolVersion, static_cast<std::uint8_t>(type), 0, 0,
        static_cast<std::uint8_t>(payloadSize & 0xff),
        static_cast<std::uint8_t>((payloadSize >> 8) & 0xff),
        static_cast<std::uint8_t>((payloadSize >> 16) & 0xff),
        static_cast<std::uint8_t>((payloadSize >> 24) & 0xff),
    };
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    return WriteAll(output, header, sizeof(header)) && (payloadSize == 0 || WriteAll(output, payload, payloadSize));
}

bool WriteJsonFrame(FrameType type, const std::string& json) {
    if (json.size() > MAXDWORD) {
        return false;
    }
    return WriteFrame(type, reinterpret_cast<const std::uint8_t*>(json.data()), static_cast<std::uint32_t>(json.size()));
}

bool EmitState(techmap::audio::CaptureState state, std::string_view reason) {
    std::string json = "{\"state\":\"";
    json += techmap::audio::ToString(state);
    json += "\",\"reason\":\"";
    json += reason;
    json += "\"}";
    return WriteJsonFrame(FrameType::State, json);
}

std::string HresultHex(HRESULT value) {
    std::ostringstream stream;
    stream << "0x" << std::hex << std::uppercase << std::setw(8) << std::setfill('0')
           << static_cast<std::uint32_t>(value);
    return stream.str();
}

DWORD GetWindowsBuildNumber() {
    using RtlGetVersionFunction = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (ntdll == nullptr) {
        return 0;
    }
    const auto rtlGetVersion = reinterpret_cast<RtlGetVersionFunction>(GetProcAddress(ntdll, "RtlGetVersion"));
    if (rtlGetVersion == nullptr) {
        return 0;
    }
    RTL_OSVERSIONINFOW version{};
    version.dwOSVersionInfoSize = sizeof(version);
    return rtlGetVersion(&version) == 0 ? version.dwBuildNumber : 0;
}

struct ProcessEntry final {
    DWORD processId;
    DWORD parentProcessId;
};

std::vector<ProcessEntry> FindProcesses(std::wstring_view executableName) {
    std::vector<ProcessEntry> matches;
    UniqueHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    if (!snapshot) {
        return matches;
    }

    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (!Process32FirstW(snapshot.get(), &entry)) {
        return matches;
    }

    do {
        if (_wcsicmp(entry.szExeFile, std::wstring(executableName).c_str()) == 0) {
            matches.push_back({entry.th32ProcessID, entry.th32ParentProcessID});
        }
    } while (Process32NextW(snapshot.get(), &entry));

    return matches;
}

DWORD SelectRootProcess(const std::vector<ProcessEntry>& processes) {
    std::unordered_set<DWORD> processIds;
    for (const auto& process : processes) {
        processIds.insert(process.processId);
    }
    for (const auto& process : processes) {
        if (!processIds.contains(process.parentProcessId)) {
            return process.processId;
        }
    }
    return processes.empty() ? 0 : processes.front().processId;
}

bool IsExpectedTeamsProcess(DWORD processId) {
    UniqueHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId));
    if (!process) {
        return false;
    }

    std::vector<wchar_t> path(32'768);
    DWORD length = static_cast<DWORD>(path.size());
    if (!QueryFullProcessImageNameW(process.get(), 0, path.data(), &length)) {
        return false;
    }
    std::wstring_view fullPath(path.data(), length);
    const std::size_t separator = fullPath.find_last_of(L"\\/");
    const std::wstring executable(fullPath.substr(separator == std::wstring_view::npos ? 0 : separator + 1));
    return _wcsicmp(executable.c_str(), TeamsExecutableName.data()) == 0;
}

class ActivationHandler final
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
public:
    ActivationHandler() : completed_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {}

    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        ComPtr<IUnknown> activated;
        HRESULT activationResult = E_UNEXPECTED;
        HRESULT operationResult = operation->GetActivateResult(&activationResult, &activated);
        result_ = FAILED(operationResult) ? operationResult : activationResult;
        if (SUCCEEDED(result_)) {
            result_ = activated.As(&audioClient_);
        }
        if (completed_) {
            SetEvent(completed_.get());
        }
        return S_OK;
    }

    HRESULT WaitForResult(ComPtr<IAudioClient>* audioClient) {
        if (!completed_) {
            return E_OUTOFMEMORY;
        }
        const DWORD waitResult = WaitForSingleObject(completed_.get(), 10'000);
        if (waitResult != WAIT_OBJECT_0) {
            return waitResult == WAIT_TIMEOUT ? HRESULT_FROM_WIN32(ERROR_TIMEOUT) : HRESULT_FROM_WIN32(GetLastError());
        }
        if (SUCCEEDED(result_)) {
            *audioClient = audioClient_;
        }
        return result_;
    }

private:
    UniqueHandle completed_;
    HRESULT result_{E_PENDING};
    ComPtr<IAudioClient> audioClient_;
};

HRESULT ActivateProcessLoopback(DWORD processId, ComPtr<IAudioClient>* audioClient) {
    AUDIOCLIENT_ACTIVATION_PARAMS activationParameters{};
    activationParameters.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activationParameters.ProcessLoopbackParams.TargetProcessId = processId;
    activationParameters.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT parameters{};
    parameters.vt = VT_BLOB;
    parameters.blob.cbSize = sizeof(activationParameters);
    parameters.blob.pBlobData = reinterpret_cast<BYTE*>(&activationParameters);

    auto handler = Microsoft::WRL::Make<ActivationHandler>();
    if (!handler) {
        return E_OUTOFMEMORY;
    }

    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    const HRESULT startResult = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &parameters,
        handler.Get(),
        &operation);
    if (FAILED(startResult)) {
        return startResult;
    }
    return handler->WaitForResult(audioClient);
}

bool ContainsSignal(const BYTE* data, UINT32 frames, const WAVEFORMATEX& format, DWORD flags) {
    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == nullptr) {
        return false;
    }
    if (format.wBitsPerSample != 16) {
        return true;
    }
    const auto* samples = reinterpret_cast<const std::int16_t*>(data);
    const std::size_t sampleCount = static_cast<std::size_t>(frames) * format.nChannels;
    for (std::size_t index = 0; index < sampleCount; ++index) {
        if (samples[index] != 0) {
            return true;
        }
    }
    return false;
}

int RunProbe(DWORD requestedProcessId, bool activate) {
    const DWORD build = GetWindowsBuildNumber();
    const auto processes = FindProcesses(TeamsExecutableName);
    const DWORD processId = requestedProcessId != 0 ? requestedProcessId : SelectRootProcess(processes);
    const bool supportedBuild = build >= MinimumProcessLoopbackBuild;
    const bool targetFound = processId != 0 && IsExpectedTeamsProcess(processId);

    HRESULT activationResult = E_NOTIMPL;
    bool activationAttempted = false;
    if (activate && supportedBuild && targetFound) {
        activationAttempted = true;
        ComPtr<IAudioClient> audioClient;
        activationResult = ActivateProcessLoopback(processId, &audioClient);
    }

    std::ostringstream json;
    json << "{\"windowsBuild\":" << build
         << ",\"minimumBuild\":" << MinimumProcessLoopbackBuild
         << ",\"supportedBuild\":" << (supportedBuild ? "true" : "false")
         << ",\"teamsProcessCount\":" << processes.size()
         << ",\"selectedProcessId\":" << processId
         << ",\"targetFound\":" << (targetFound ? "true" : "false")
         << ",\"activationAttempted\":" << (activationAttempted ? "true" : "false")
         << ",\"activationSucceeded\":" << (activationAttempted && SUCCEEDED(activationResult) ? "true" : "false")
         << ",\"activationHresult\":\"" << HresultHex(activationResult) << "\"}\n";
    WriteText(json.str());

    if (!supportedBuild || !targetFound || (activationAttempted && FAILED(activationResult))) {
        return 2;
    }
    return 0;
}

int RunCapture(DWORD processId, bool consentConfirmed, std::uint64_t durationMilliseconds) {
    _setmode(_fileno(stdout), _O_BINARY);

    if (!consentConfirmed) {
        EmitState(techmap::audio::CaptureState::Stopped, "consent-required");
        return 2;
    }
    if (GetWindowsBuildNumber() < MinimumProcessLoopbackBuild) {
        EmitState(techmap::audio::CaptureState::Stopped, "unsupported-windows-build");
        return 2;
    }
    if (processId == 0 || !IsExpectedTeamsProcess(processId)) {
        EmitState(techmap::audio::CaptureState::Stopped, "teams-process-required");
        return 2;
    }

    UniqueHandle targetProcess(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId));
    if (!targetProcess) {
        EmitState(techmap::audio::CaptureState::Stopped, "teams-process-unavailable");
        return 2;
    }

    ComPtr<IAudioClient> audioClient;
    HRESULT result = ActivateProcessLoopback(processId, &audioClient);
    if (FAILED(result)) {
        EmitState(techmap::audio::CaptureState::Stopped, "process-loopback-activation-failed");
        return 2;
    }

    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = 2;
    format.nSamplesPerSec = 48'000;
    format.wBitsPerSample = 16;
    format.nBlockAlign = static_cast<WORD>(format.nChannels * format.wBitsPerSample / 8);
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

    constexpr DWORD streamFlags = AUDCLNT_STREAMFLAGS_LOOPBACK |
                                  AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                                  AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                                  AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    result = audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED, streamFlags, 0, 0, &format, nullptr);
    if (FAILED(result)) {
        EmitState(techmap::audio::CaptureState::Stopped, "audio-client-initialize-failed");
        return 2;
    }

    UniqueHandle sampleReady(CreateEventW(nullptr, FALSE, FALSE, nullptr));
    if (!sampleReady || FAILED(audioClient->SetEventHandle(sampleReady.get()))) {
        EmitState(techmap::audio::CaptureState::Stopped, "audio-event-initialize-failed");
        return 2;
    }

    ComPtr<IAudioCaptureClient> captureClient;
    result = audioClient->GetService(IID_PPV_ARGS(&captureClient));
    if (FAILED(result)) {
        EmitState(techmap::audio::CaptureState::Stopped, "capture-client-unavailable");
        return 2;
    }

    if (FAILED(audioClient->Start())) {
        EmitState(techmap::audio::CaptureState::Stopped, "audio-start-failed");
        return 2;
    }

    const std::string formatJson = "{\"sampleRate\":48000,\"channels\":2,\"bitsPerSample\":16,\"encoding\":\"pcm-s16le\"}";
    if (!WriteJsonFrame(FrameType::Format, formatJson)) {
        audioClient->Stop();
        return 3;
    }

    techmap::audio::CaptureStateTracker tracker;
    const std::uint64_t startedAt = GetTickCount64();
    tracker.Start(startedAt);
    if (!EmitState(tracker.state(), "capture-started")) {
        audioClient->Stop();
        return 3;
    }

    int exitCode = 0;
    while (!g_stopRequested.load()) {
        const std::uint64_t now = GetTickCount64();
        if (durationMilliseconds > 0 && now - startedAt >= durationMilliseconds) {
            break;
        }
        if (WaitForSingleObject(targetProcess.get(), 0) == WAIT_OBJECT_0) {
            tracker.Degrade();
            EmitState(tracker.state(), "teams-process-exited");
            exitCode = 4;
            break;
        }

        const DWORD waitResult = WaitForSingleObject(sampleReady.get(), 250);
        if (waitResult == WAIT_TIMEOUT) {
            if (tracker.ObserveSignal(false, now) && !EmitState(tracker.state(), "remote-audio-silent")) {
                exitCode = 3;
                break;
            }
            continue;
        }
        if (waitResult != WAIT_OBJECT_0) {
            tracker.Degrade();
            EmitState(tracker.state(), "audio-device-unavailable");
            exitCode = 4;
            break;
        }

        UINT32 packetFrames = 0;
        std::vector<std::uint8_t> ownedPayload;
        while (SUCCEEDED(result = captureClient->GetNextPacketSize(&packetFrames)) && packetFrames > 0) {
            const std::uint32_t expectedByteCount = packetFrames * format.nBlockAlign;
            if (ownedPayload.size() < expectedByteCount) {
                ownedPayload.resize(expectedByteCount);
            }
            BYTE* data = nullptr;
            DWORD flags = 0;
            result = captureClient->GetBuffer(&data, &packetFrames, &flags, nullptr, nullptr);
            if (FAILED(result)) {
                break;
            }

            const std::uint32_t byteCount = packetFrames * format.nBlockAlign;
            const bool hasSignal = ContainsSignal(data, packetFrames, format, flags);
            if (byteCount > ownedPayload.size()) {
                captureClient->ReleaseBuffer(packetFrames);
                result = E_UNEXPECTED;
                break;
            }
            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0 && data != nullptr) {
                std::memcpy(ownedPayload.data(), data, byteCount);
            } else {
                std::fill_n(ownedPayload.data(), byteCount, 0);
            }

            const bool stateChanged = tracker.ObserveSignal(hasSignal, GetTickCount64());
            const bool dataDiscontinuity = (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0;
            const HRESULT releaseResult = captureClient->ReleaseBuffer(packetFrames);
            if (FAILED(releaseResult)) {
                result = releaseResult;
                break;
            }
            if (dataDiscontinuity && !EmitState(tracker.state(), "data-discontinuity")) {
                result = HRESULT_FROM_WIN32(ERROR_BROKEN_PIPE);
                break;
            }
            if (!WriteFrame(FrameType::Pcm, ownedPayload.data(), byteCount)) {
                result = HRESULT_FROM_WIN32(ERROR_BROKEN_PIPE);
                break;
            }
            if (stateChanged) {
                const std::string_view reason = tracker.state() == techmap::audio::CaptureState::Active
                    ? "remote-audio-resumed"
                    : "remote-audio-silent";
                if (!EmitState(tracker.state(), reason)) {
                    result = HRESULT_FROM_WIN32(ERROR_BROKEN_PIPE);
                    break;
                }
            }
        }

        if (FAILED(result)) {
            tracker.Degrade();
            EmitState(tracker.state(), "audio-stream-failed");
            exitCode = 4;
            break;
        }
    }

    audioClient->Stop();
    if (exitCode == 0) {
        tracker.Stop();
        EmitState(tracker.state(), "capture-stopped");
    }
    return exitCode;
}

bool TryParseDword(const wchar_t* value, DWORD* parsed) {
    wchar_t* end = nullptr;
    const unsigned long number = std::wcstoul(value, &end, 10);
    if (value == end || *end != L'\0' || number == 0 || number > MAXDWORD) {
        return false;
    }
    *parsed = static_cast<DWORD>(number);
    return true;
}

bool TryParseDuration(const wchar_t* value, std::uint64_t* parsed) {
    wchar_t* end = nullptr;
    const unsigned long long number = std::wcstoull(value, &end, 10);
    if (value == end || *end != L'\0') {
        return false;
    }
    *parsed = number;
    return true;
}

void PrintUsage() {
    WriteText(
        "Usage:\n"
        "  techmap-audio probe [--pid <ms-teams-pid>] [--activate]\n"
        "  techmap-audio capture --pid <ms-teams-pid> --consent-confirmed [--duration-ms <milliseconds>]\n");
}

} // namespace

int wmain(int argc, wchar_t* argv[]) {
    const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(comResult) && comResult != RPC_E_CHANGED_MODE) {
        return 1;
    }
    const bool shouldUninitialize = SUCCEEDED(comResult);

    int exitCode = 1;
    if (argc >= 2 && wcscmp(argv[1], L"probe") == 0) {
        DWORD processId = 0;
        bool activate = false;
        bool valid = true;
        for (int index = 2; index < argc; ++index) {
            if (wcscmp(argv[index], L"--activate") == 0) {
                activate = true;
            } else if (wcscmp(argv[index], L"--pid") == 0 && index + 1 < argc) {
                valid = TryParseDword(argv[++index], &processId);
            } else {
                valid = false;
            }
        }
        if (valid) {
            exitCode = RunProbe(processId, activate);
        } else {
            PrintUsage();
        }
    } else if (argc >= 2 && wcscmp(argv[1], L"capture") == 0) {
        DWORD processId = 0;
        bool consentConfirmed = false;
        std::uint64_t durationMilliseconds = 0;
        bool valid = true;
        for (int index = 2; index < argc; ++index) {
            if (wcscmp(argv[index], L"--consent-confirmed") == 0) {
                consentConfirmed = true;
            } else if (wcscmp(argv[index], L"--pid") == 0 && index + 1 < argc) {
                valid = TryParseDword(argv[++index], &processId);
            } else if (wcscmp(argv[index], L"--duration-ms") == 0 && index + 1 < argc) {
                valid = TryParseDuration(argv[++index], &durationMilliseconds);
            } else {
                valid = false;
            }
        }
        if (valid) {
            SetConsoleCtrlHandler(HandleConsoleControl, TRUE);
            exitCode = RunCapture(processId, consentConfirmed, durationMilliseconds);
        } else {
            PrintUsage();
        }
    } else {
        PrintUsage();
    }

    if (shouldUninitialize) {
        CoUninitialize();
    }
    return exitCode;
}
