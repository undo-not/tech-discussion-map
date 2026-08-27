#include "ocr_runtime.h"

#include "caption_geometry.h"
#include "caption_frame.h"
#include "caption_proof.h"
#include "caption_rows.h"
#include "caption_speaker.h"
#include "caption_tsv.h"

#include <windows.h>
#include <windowsx.h>
#include <bcrypt.h>
#include <tlhelp32.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cwchar>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

namespace techmap::captions {
namespace {

constexpr std::wstring_view TeamsExecutableName = L"ms-teams.exe";
constexpr std::string_view ExpectedTesseractVersion = "5.5.3";
constexpr DWORD OcrTimeoutMilliseconds = 5'000;
constexpr std::size_t MaximumOcrOutputBytes = 512 * 1024;
constexpr DWORD CaptureCadenceMilliseconds = 500;
constexpr DWORD CaptureTimeoutMilliseconds = 2'000;
constexpr DWORD CompanionProofTimeoutMilliseconds = 2'000;
constexpr UINT_PTR SelectionTimerId = 1;
constexpr UINT SelectionTimeoutMilliseconds = 60'000;

class UniqueHandle final {
public:
    explicit UniqueHandle(HANDLE handle = nullptr) noexcept : handle_(handle) {}
    ~UniqueHandle() { reset(); }
    UniqueHandle(const UniqueHandle&) = delete;
    UniqueHandle& operator=(const UniqueHandle&) = delete;
    UniqueHandle(UniqueHandle&& other) noexcept : handle_(other.release()) {}
    UniqueHandle& operator=(UniqueHandle&& other) noexcept {
        if (this != &other) reset(other.release());
        return *this;
    }
    HANDLE get() const noexcept { return handle_; }
    HANDLE release() noexcept { HANDLE value = handle_; handle_ = nullptr; return value; }
    explicit operator bool() const noexcept { return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE; }
    void reset(HANDLE replacement = nullptr) noexcept {
        if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) CloseHandle(handle_);
        handle_ = replacement;
    }
private:
    HANDLE handle_;
};

struct OcrPaths final {
    std::wstring root;
    std::wstring executable;
    std::wstring tessdata;
    std::wstring japanese;
    std::wstring english;
    std::wstring manifest;
};

std::optional<OcrPaths> ResolveOcrPaths() {
    std::vector<wchar_t> localAppData(32'768);
    const DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData.data(), static_cast<DWORD>(localAppData.size()));
    if (length == 0 || length >= localAppData.size()) return std::nullopt;
    std::wstring root(localAppData.data(), length);
    root += L"\\TechMapLive\\ocr\\current";
    return OcrPaths{
        root,
        root + L"\\tesseract.exe",
        root + L"\\tessdata",
        root + L"\\tessdata\\jpn.traineddata",
        root + L"\\tessdata\\eng.traineddata",
        root + L"\\techmap-ocr.manifest",
    };
}

std::optional<std::string> ReadBoundedFile(const std::wstring& path, std::size_t maximumBytes) {
    UniqueHandle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!file) return std::nullopt;
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file.get(), &size) || size.QuadPart < 0 || static_cast<unsigned long long>(size.QuadPart) > maximumBytes) return std::nullopt;
    std::string output(static_cast<std::size_t>(size.QuadPart), '\0');
    DWORD read = 0;
    if (!output.empty() && (!ReadFile(file.get(), output.data(), static_cast<DWORD>(output.size()), &read, nullptr) || read != static_cast<DWORD>(output.size()))) return std::nullopt;
    return output;
}

std::optional<std::string> Sha256File(const std::wstring& path) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    UniqueHandle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!file || BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return std::nullopt;
    DWORD objectBytes = 0;
    DWORD received = 0;
    if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectBytes), sizeof(objectBytes), &received, 0) < 0) {
        BCryptCloseAlgorithmProvider(algorithm, 0);
        return std::nullopt;
    }
    std::vector<unsigned char> object(objectBytes);
    std::array<unsigned char, 32> digest{};
    if (BCryptCreateHash(algorithm, &hash, object.data(), static_cast<ULONG>(object.size()), nullptr, 0, 0) < 0) {
        BCryptCloseAlgorithmProvider(algorithm, 0);
        return std::nullopt;
    }
    std::array<unsigned char, 64 * 1024> buffer{};
    bool ok = true;
    for (;;) {
        DWORD read = 0;
        if (!ReadFile(file.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) { ok = false; break; }
        if (read == 0) break;
        if (BCryptHashData(hash, buffer.data(), read, 0) < 0) { ok = false; break; }
    }
    if (ok) ok = BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) >= 0;
    SecureZeroMemory(buffer.data(), buffer.size());
    SecureZeroMemory(object.data(), object.size());
    BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (!ok) return std::nullopt;
    constexpr char Hex[] = "0123456789abcdef";
    std::string encoded;
    encoded.reserve(64);
    for (const unsigned char byte : digest) { encoded.push_back(Hex[byte >> 4]); encoded.push_back(Hex[byte & 0x0f]); }
    SecureZeroMemory(digest.data(), digest.size());
    return encoded;
}

bool IsLowerSha256(std::string_view value) {
    return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char character) {
        return (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f');
    });
}

bool VerifyOcrInstallation(const OcrPaths& paths) {
    const auto manifest = ReadBoundedFile(paths.manifest, 4 * 1024);
    if (!manifest) return false;
    std::unordered_map<std::string, std::string> fields;
    std::size_t offset = 0;
    while (offset <= manifest->size()) {
        const std::size_t newline = manifest->find('\n', offset);
        std::string line = manifest->substr(offset, newline == std::string::npos ? manifest->size() - offset : newline - offset);
        if (!line.empty() && line.back() == '\r') line.pop_back();
        offset = newline == std::string::npos ? manifest->size() + 1 : newline + 1;
        if (line.empty()) continue;
        const std::size_t equals = line.find('=');
        if (equals == std::string::npos || equals == 0 || !fields.emplace(line.substr(0, equals), line.substr(equals + 1)).second) return false;
    }
    if (fields.size() != 5 || fields["contractVersion"] != "1" || fields["tesseractVersion"] != ExpectedTesseractVersion ||
        !IsLowerSha256(fields["tesseractSha256"]) || !IsLowerSha256(fields["jpnSha256"]) || !IsLowerSha256(fields["engSha256"])) return false;
    const auto executableHash = Sha256File(paths.executable);
    const auto japaneseHash = Sha256File(paths.japanese);
    const auto englishHash = Sha256File(paths.english);
    return executableHash && japaneseHash && englishHash &&
        *executableHash == fields["tesseractSha256"] && *japaneseHash == fields["jpnSha256"] && *englishHash == fields["engSha256"];
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

bool IsExpectedTeamsWindow(HWND window, DWORD& processId) {
    processId = 0;
    if (!window || !IsWindowVisible(window) || IsIconic(window)) return false;
    GetWindowThreadProcessId(window, &processId);
    return processId != 0 && IsExpectedTeamsProcess(processId);
}

std::optional<std::wstring> ProcessImage(DWORD processId) {
    UniqueHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId));
    if (!process) return std::nullopt;
    std::vector<wchar_t> path(32'768);
    DWORD length = static_cast<DWORD>(path.size());
    if (!QueryFullProcessImageNameW(process.get(), 0, path.data(), &length)) return std::nullopt;
    return std::wstring(path.data(), length);
}

std::optional<DWORD> ParentProcessId() {
    const DWORD currentId = GetCurrentProcessId();
    UniqueHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    if (!snapshot) return std::nullopt;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (!Process32FirstW(snapshot.get(), &entry)) return std::nullopt;
    do {
        if (entry.th32ProcessID == currentId && entry.th32ParentProcessID != 0) return entry.th32ParentProcessID;
    } while (Process32NextW(snapshot.get(), &entry));
    return std::nullopt;
}

std::wstring_view ExecutableName(std::wstring_view path) {
    const std::size_t separator = path.find_last_of(L"\\/");
    return path.substr(separator == std::wstring_view::npos ? 0 : separator + 1);
}

bool ParentIsSameExecutable() {
    const auto parentId = ParentProcessId();
    if (!parentId) return false;
    const DWORD currentId = GetCurrentProcessId();
    const auto current = ProcessImage(currentId);
    const auto parent = ProcessImage(*parentId);
    return current && parent && _wcsicmp(current->c_str(), parent->c_str()) == 0;
}

bool ParentIsNode() {
    const auto parentId = ParentProcessId();
    if (!parentId) return false;
    const auto parent = ProcessImage(*parentId);
    return parent && _wcsicmp(std::wstring(ExecutableName(*parent)).c_str(), L"node.exe") == 0;
}

bool VerifyCompanionProof(std::string_view expected) {
    if (!IsLowerSha256(expected) || !ParentIsNode()) return false;
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    if (!input || input == INVALID_HANDLE_VALUE || GetFileType(input) != FILE_TYPE_PIPE) return false;
    std::array<unsigned char, 64> received{};
    std::size_t offset = 0;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(CompanionProofTimeoutMilliseconds);
    while (offset < received.size()) {
        DWORD available = 0;
        if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) {
            SecureZeroMemory(received.data(), received.size());
            return false;
        }
        if (available > 0) {
            DWORD read = 0;
            const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(available, received.size() - offset));
            if (!ReadFile(input, received.data() + offset, requested, &read, nullptr) || read == 0) {
                SecureZeroMemory(received.data(), received.size());
                return false;
            }
            offset += read;
            continue;
        }
        if (std::chrono::steady_clock::now() >= deadline) {
            SecureZeroMemory(received.data(), received.size());
            return false;
        }
        Sleep(10);
    }
    DWORD extra = 0;
    const BOOL peeked = PeekNamedPipe(input, nullptr, 0, nullptr, &extra, nullptr);
    const DWORD peekError = peeked ? ERROR_SUCCESS : GetLastError();
    const bool noExtra = ProofPipeHasNoTrailingBytes(peeked != FALSE, extra, peekError == ERROR_BROKEN_PIPE);
    unsigned char difference = 0;
    for (std::size_t index = 0; index < received.size(); ++index) difference |= received[index] ^ static_cast<unsigned char>(expected[index]);
    SecureZeroMemory(received.data(), received.size());
    return noExtra && difference == 0;
}

struct SelectionContext final {
    POINT start{};
    POINT current{};
    PixelRect selected{};
    bool dragging = false;
    bool complete = false;
    bool cancelled = false;
};

LRESULT CALLBACK SelectionWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    auto* context = reinterpret_cast<SelectionContext*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        const auto* create = reinterpret_cast<CREATESTRUCTW*>(lParam);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(create->lpCreateParams));
        return TRUE;
    }
    if (!context) return DefWindowProcW(window, message, wParam, lParam);
    switch (message) {
        case WM_LBUTTONDOWN:
            context->start = {GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
            context->current = context->start;
            context->dragging = true;
            SetCapture(window);
            return 0;
        case WM_MOUSEMOVE:
            if (context->dragging) {
                context->current = {GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
                InvalidateRect(window, nullptr, FALSE);
            }
            return 0;
        case WM_LBUTTONUP: {
            if (!context->dragging) return 0;
            context->current = {GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
            context->dragging = false;
            ReleaseCapture();
            RECT bounds{};
            GetWindowRect(window, &bounds);
            const LONG left = std::min(context->start.x, context->current.x);
            const LONG top = std::min(context->start.y, context->current.y);
            const LONG right = std::max(context->start.x, context->current.x);
            const LONG bottom = std::max(context->start.y, context->current.y);
            if (right - left >= 32 && bottom - top >= 32) {
                context->selected = {bounds.left + left, bounds.top + top, bounds.left + right, bounds.top + bottom};
                context->complete = true;
                PostQuitMessage(0);
            }
            return 0;
        }
        case WM_RBUTTONDOWN:
        case WM_KEYDOWN:
            if (message == WM_RBUTTONDOWN || wParam == VK_ESCAPE) {
                context->cancelled = true;
                PostQuitMessage(0);
                return 0;
            }
            break;
        case WM_TIMER:
            if (wParam == SelectionTimerId) {
                context->cancelled = true;
                PostQuitMessage(0);
                return 0;
            }
            break;
        case WM_PAINT: {
            PAINTSTRUCT paint{};
            HDC dc = BeginPaint(window, &paint);
            RECT client{};
            GetClientRect(window, &client);
            HBRUSH shade = CreateSolidBrush(RGB(10, 55, 48));
            FillRect(dc, &client, shade);
            DeleteObject(shade);
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, RGB(255, 255, 255));
            DrawTextW(dc, L"字幕領域をドラッグ選択（Esc／右クリックで中止）", -1, &client, DT_TOP | DT_CENTER | DT_SINGLELINE);
            if (context->dragging) {
                RECT selected{std::min(context->start.x, context->current.x), std::min(context->start.y, context->current.y),
                    std::max(context->start.x, context->current.x), std::max(context->start.y, context->current.y)};
                HPEN pen = CreatePen(PS_SOLID, 3, RGB(255, 210, 96));
                HGDIOBJ oldPen = SelectObject(dc, pen);
                HGDIOBJ oldBrush = SelectObject(dc, GetStockObject(HOLLOW_BRUSH));
                Rectangle(dc, selected.left, selected.top, selected.right, selected.bottom);
                SelectObject(dc, oldBrush);
                SelectObject(dc, oldPen);
                DeleteObject(pen);
            }
            EndPaint(window, &paint);
            return 0;
        }
    }
    return DefWindowProcW(window, message, wParam, lParam);
}

std::optional<PixelRect> SelectCaptionRegion(HWND teamsWindow, const RECT& clientScreen) {
    constexpr wchar_t ClassName[] = L"TechMapCaptionSelector";
    HINSTANCE instance = GetModuleHandleW(nullptr);
    WNDCLASSW windowClass{};
    windowClass.lpfnWndProc = SelectionWindowProc;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursorW(nullptr, IDC_CROSS);
    windowClass.lpszClassName = ClassName;
    RegisterClassW(&windowClass);
    SelectionContext context{};
    HWND overlay = CreateWindowExW(WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TOOLWINDOW, ClassName, L"TechMap caption selector", WS_POPUP,
        clientScreen.left, clientScreen.top, clientScreen.right - clientScreen.left, clientScreen.bottom - clientScreen.top,
        nullptr, nullptr, instance, &context);
    if (!overlay) return std::nullopt;
    SetLayeredWindowAttributes(overlay, 0, 100, LWA_ALPHA);
    SetWindowDisplayAffinity(overlay, WDA_EXCLUDEFROMCAPTURE);
    if (SetTimer(overlay, SelectionTimerId, SelectionTimeoutMilliseconds, nullptr) == 0) {
        DestroyWindow(overlay);
        UnregisterClassW(ClassName, instance);
        return std::nullopt;
    }
    ShowWindow(overlay, SW_SHOW);
    SetForegroundWindow(overlay);
    SetFocus(overlay);
    MSG message{};
    while (!context.complete && !context.cancelled && GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    KillTimer(overlay, SelectionTimerId);
    DestroyWindow(overlay);
    UnregisterClassW(ClassName, instance);
    if (!context.complete || context.cancelled) return std::nullopt;
    SetForegroundWindow(teamsWindow);
    return context.selected;
}

bool ClientScreenRect(HWND window, RECT& output) {
    RECT client{};
    if (!GetClientRect(window, &client)) return false;
    POINT topLeft{client.left, client.top};
    POINT bottomRight{client.right, client.bottom};
    if (!ClientToScreen(window, &topLeft) || !ClientToScreen(window, &bottomRight)) return false;
    output = {topLeft.x, topLeft.y, bottomRight.x, bottomRight.y};
    return true;
}

bool SelectionPointsBelongToTeams(const PixelRect& selection, DWORD processId) {
    const std::array<POINT, 5> points{{
        {selection.left + 1, selection.top + 1}, {selection.right - 1, selection.top + 1},
        {selection.left + 1, selection.bottom - 1}, {selection.right - 1, selection.bottom - 1},
        {selection.left + static_cast<LONG>(Width(selection) / 2), selection.top + static_cast<LONG>(Height(selection) / 2)},
    }};
    for (const auto point : points) {
        HWND owner = WindowFromPoint(point);
        DWORD ownerProcess = 0;
        if (!owner) return false;
        GetWindowThreadProcessId(owner, &ownerProcess);
        if (ownerProcess != processId) return false;
    }
    return true;
}

WindowSnapshot Snapshot(HWND window, DWORD processId, const PixelRect& selection) {
    RECT client{};
    const bool hasClient = ClientScreenRect(window, client);
    return {
        hasClient ? PixelRect{client.left, client.top, client.right, client.bottom} : PixelRect{},
        GetDpiForWindow(window),
        hasClient && IsWindowVisible(window),
        GetForegroundWindow() == window,
        IsIconic(window) != FALSE,
        hasClient && SelectionPointsBelongToTeams(selection, processId),
    };
}

#pragma pack(push, 1)
struct BitmapFileHeader final {
    WORD type;
    DWORD size;
    WORD reserved1;
    WORD reserved2;
    DWORD offset;
};
#pragma pack(pop)

std::optional<std::vector<unsigned char>> CaptureSelectedBmpUnsafe(HWND window, const PixelRect& selection) {
    const int width = static_cast<int>(Width(selection));
    const int height = static_cast<int>(Height(selection));
    RECT windowRect{};
    if (!GetWindowRect(window, &windowRect)) return std::nullopt;
    HDC windowDc = GetDC(window);
    if (!windowDc) return std::nullopt;
    HDC memoryDc = CreateCompatibleDC(windowDc);
    ReleaseDC(window, windowDc);
    if (!memoryDc) return std::nullopt;
    BITMAPINFO info{};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = width;
    info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    void* pixels = nullptr;
    HBITMAP bitmap = CreateDIBSection(memoryDc, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
    if (!bitmap || !pixels) { DeleteDC(memoryDc); return std::nullopt; }
    HGDIOBJ previous = SelectObject(memoryDc, bitmap);
    SetViewportOrgEx(memoryDc, -(selection.left - windowRect.left), -(selection.top - windowRect.top), nullptr);
    const BOOL captured = PrintWindow(window, memoryDc, PW_RENDERFULLCONTENT);
    SetViewportOrgEx(memoryDc, 0, 0, nullptr);
    SelectObject(memoryDc, previous);
    const std::size_t pixelBytes = static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 4;
    bool varied = false;
    if (captured) {
        const auto* bytes = static_cast<const unsigned char*>(pixels);
        const std::array<std::size_t, 5> samples{{0, pixelBytes / 4, pixelBytes / 2, pixelBytes * 3 / 4, pixelBytes - 4}};
        for (std::size_t index = 1; index < samples.size(); ++index) {
            if (std::memcmp(bytes + samples[0], bytes + samples[index], 4) != 0) { varied = true; break; }
        }
    }
    std::optional<std::vector<unsigned char>> result;
    if (captured && varied) {
        BitmapFileHeader fileHeader{0x4d42, static_cast<DWORD>(sizeof(BitmapFileHeader) + sizeof(BITMAPINFOHEADER) + pixelBytes), 0, 0,
            static_cast<DWORD>(sizeof(BitmapFileHeader) + sizeof(BITMAPINFOHEADER))};
        std::vector<unsigned char> bmp(fileHeader.size);
        std::memcpy(bmp.data(), &fileHeader, sizeof(fileHeader));
        std::memcpy(bmp.data() + sizeof(fileHeader), &info.bmiHeader, sizeof(info.bmiHeader));
        std::memcpy(bmp.data() + fileHeader.offset, pixels, pixelBytes);
        result = std::move(bmp);
    }
    SecureZeroMemory(pixels, pixelBytes);
    DeleteObject(bitmap);
    DeleteDC(memoryDc);
    return result;
}

std::optional<std::vector<unsigned char>> CaptureSelectedBmpBounded(HWND window, const PixelRect& selection, std::uint32_t selectionDpi) {
    SECURITY_ATTRIBUTES inheritable{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE parentOutputRaw = nullptr;
    HANDLE childOutputRaw = nullptr;
    if (!CreatePipe(&parentOutputRaw, &childOutputRaw, &inheritable, 0)) return std::nullopt;
    UniqueHandle parentOutput(parentOutputRaw), childOutput(childOutputRaw);
    SetHandleInformation(parentOutput.get(), HANDLE_FLAG_INHERIT, 0);
    UniqueHandle nullInput(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    UniqueHandle nullError(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!nullInput || !nullError) return std::nullopt;
    std::vector<wchar_t> executable(32'768);
    const DWORD executableLength = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
    if (executableLength == 0 || executableLength >= executable.size()) return std::nullopt;
    std::wstring command = L"\"" + std::wstring(executable.data(), executableLength) + L"\" capture-frame-worker " +
        std::to_wstring(reinterpret_cast<std::uintptr_t>(window)) + L" " + std::to_wstring(selection.left) + L" " +
        std::to_wstring(selection.top) + L" " + std::to_wstring(selection.right) + L" " + std::to_wstring(selection.bottom) + L" " +
        std::to_wstring(selectionDpi);
    std::vector<wchar_t> mutableCommand(command.begin(), command.end());
    mutableCommand.push_back(L'\0');
    UniqueHandle job(CreateJobObjectW(nullptr, nullptr));
    if (!job) return std::nullopt;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    limits.ProcessMemoryLimit = 128ULL * 1024ULL * 1024ULL;
    if (!SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return std::nullopt;

    SIZE_T attributeBytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
    if (attributeBytes == 0) return std::nullopt;
    std::vector<unsigned char> attributeStorage(attributeBytes);
    auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
    if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attributeBytes)) return std::nullopt;
    const std::array<HANDLE, 3> inherited{{nullInput.get(), childOutput.get(), nullError.get()}};
    if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        const_cast<HANDLE*>(inherited.data()), inherited.size() * sizeof(HANDLE), nullptr, nullptr)) {
        DeleteProcThreadAttributeList(attributes);
        SecureZeroMemory(attributeStorage.data(), attributeStorage.size());
        return std::nullopt;
    }

    wchar_t windowsDirectory[MAX_PATH]{};
    const UINT windowsLength = GetWindowsDirectoryW(windowsDirectory, MAX_PATH);
    if (windowsLength == 0 || windowsLength >= MAX_PATH) {
        DeleteProcThreadAttributeList(attributes);
        SecureZeroMemory(attributeStorage.data(), attributeStorage.size());
        return std::nullopt;
    }
    std::wstring environment = L"SystemRoot=";
    environment.append(windowsDirectory, windowsLength);
    environment.push_back(L'\0');
    environment.push_back(L'\0');

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = nullInput.get();
    startup.StartupInfo.hStdOutput = childOutput.get();
    startup.StartupInfo.hStdError = nullError.get();
    startup.lpAttributeList = attributes;
    PROCESS_INFORMATION processInfo{};
    const BOOL created = CreateProcessW(executable.data(), mutableCommand.data(), nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        environment.data(), nullptr, &startup.StartupInfo, &processInfo);
    DeleteProcThreadAttributeList(attributes);
    SecureZeroMemory(attributeStorage.data(), attributeStorage.size());
    if (!created) return std::nullopt;
    UniqueHandle process(processInfo.hProcess), thread(processInfo.hThread);
    if (!AssignProcessToJobObject(job.get(), process.get()) || ResumeThread(thread.get()) == static_cast<DWORD>(-1)) {
        TerminateProcess(process.get(), 2);
        WaitForSingleObject(process.get(), 1'000);
        return std::nullopt;
    }
    childOutput.reset();
    std::vector<unsigned char> output;
    output.reserve(static_cast<std::size_t>(Width(selection)) * static_cast<std::size_t>(Height(selection)) * 4 + 64);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(CaptureTimeoutMilliseconds);
    bool failed = false;
    for (;;) {
        DWORD available = 0;
        if (!PeekNamedPipe(parentOutput.get(), nullptr, 0, nullptr, &available, nullptr)) {
            if (GetLastError() == ERROR_BROKEN_PIPE) break;
            failed = true;
            break;
        }
        if (available > 0) {
            std::array<unsigned char, 64 * 1024> buffer{};
            DWORD read = 0;
            if (!ReadFile(parentOutput.get(), buffer.data(), static_cast<DWORD>(std::min<std::size_t>(buffer.size(), available)), &read, nullptr)) { failed = true; break; }
            if (output.size() + read > MaximumCaptionPixelBytes + sizeof(BitmapFileHeader) + sizeof(BITMAPINFOHEADER)) { failed = true; break; }
            output.insert(output.end(), buffer.begin(), buffer.begin() + read);
            SecureZeroMemory(buffer.data(), buffer.size());
            continue;
        }
        if (WaitForSingleObject(process.get(), 0) == WAIT_OBJECT_0) break;
        if (std::chrono::steady_clock::now() >= deadline) { failed = true; break; }
        Sleep(10);
    }
    if (failed) TerminateJobObject(job.get(), 2);
    WaitForSingleObject(process.get(), 1'000);
    DWORD exitCode = 1;
    GetExitCodeProcess(process.get(), &exitCode);
    if (failed || exitCode != 0 || output.size() < sizeof(BitmapFileHeader) + sizeof(BITMAPINFOHEADER)) {
        SecureZeroMemory(output.data(), output.size());
        return std::nullopt;
    }
    BitmapFileHeader header{};
    BITMAPINFOHEADER bitmapInfo{};
    std::memcpy(&header, output.data(), sizeof(header));
    std::memcpy(&bitmapInfo, output.data() + sizeof(header), sizeof(bitmapInfo));
    const std::uint64_t expectedPixels = static_cast<std::uint64_t>(Width(selection)) * static_cast<std::uint64_t>(Height(selection)) * 4ULL;
    if (header.type != 0x4d42 || header.size != static_cast<DWORD>(output.size()) || header.offset != sizeof(BitmapFileHeader) + sizeof(BITMAPINFOHEADER) ||
        bitmapInfo.biSize != sizeof(BITMAPINFOHEADER) || bitmapInfo.biWidth != Width(selection) || bitmapInfo.biHeight != -Height(selection) ||
        bitmapInfo.biPlanes != 1 || bitmapInfo.biBitCount != 32 || bitmapInfo.biCompression != BI_RGB || output.size() != header.offset + expectedPixels) {
        SecureZeroMemory(output.data(), output.size());
        return std::nullopt;
    }
    return output;
}

enum class TesseractResult { Success, Unavailable, Timeout, Malformed };

bool WriteAll(HANDLE pipe, const unsigned char* data, std::size_t size) {
    std::size_t offset = 0;
    while (offset < size) {
        const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(size - offset, 64 * 1024));
        DWORD written = 0;
        if (!WriteFile(pipe, data + offset, requested, &written, nullptr) || written == 0) return false;
        offset += written;
    }
    return true;
}

TesseractResult RunTesseract(const OcrPaths& paths, std::vector<unsigned char>& bmp, std::string& output) {
    SECURITY_ATTRIBUTES inheritable{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE childInputRaw = nullptr;
    HANDLE parentInputRaw = nullptr;
    HANDLE parentOutputRaw = nullptr;
    HANDLE childOutputRaw = nullptr;
    if (!CreatePipe(&childInputRaw, &parentInputRaw, &inheritable, 0) || !CreatePipe(&parentOutputRaw, &childOutputRaw, &inheritable, 0)) return TesseractResult::Unavailable;
    UniqueHandle childInput(childInputRaw), parentInput(parentInputRaw), parentOutput(parentOutputRaw), childOutput(childOutputRaw);
    SetHandleInformation(parentInput.get(), HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(parentOutput.get(), HANDLE_FLAG_INHERIT, 0);
    UniqueHandle nullError(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    UniqueHandle job(CreateJobObjectW(nullptr, nullptr));
    if (!nullError || !job) return TesseractResult::Unavailable;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    limits.ProcessMemoryLimit = 512ULL * 1024ULL * 1024ULL;
    if (!SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return TesseractResult::Unavailable;

    SIZE_T attributeBytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
    std::vector<unsigned char> attributeStorage(attributeBytes);
    auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
    if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attributeBytes)) return TesseractResult::Unavailable;
    const std::array<HANDLE, 3> inherited{{childInput.get(), childOutput.get(), nullError.get()}};
    if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        const_cast<HANDLE*>(inherited.data()), inherited.size() * sizeof(HANDLE), nullptr, nullptr)) {
        DeleteProcThreadAttributeList(attributes);
        return TesseractResult::Unavailable;
    }

    std::wstring command = L"\"" + paths.executable + L"\" stdin stdout --tessdata-dir \"" + paths.tessdata + L"\" -l jpn+eng --psm 6 -c debug_file=NUL -c tessedit_create_tsv=1";
    std::vector<wchar_t> mutableCommand(command.begin(), command.end());
    mutableCommand.push_back(L'\0');
    wchar_t windowsDirectory[MAX_PATH]{};
    const UINT windowsLength = GetWindowsDirectoryW(windowsDirectory, MAX_PATH);
    std::wstring environment = L"SystemRoot=";
    environment.append(windowsDirectory, windowsLength);
    environment.push_back(L'\0');
    environment += L"TESSDATA_PREFIX=" + paths.tessdata;
    environment.push_back(L'\0');
    environment.push_back(L'\0');

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = childInput.get();
    startup.StartupInfo.hStdOutput = childOutput.get();
    startup.StartupInfo.hStdError = nullError.get();
    startup.lpAttributeList = attributes;
    PROCESS_INFORMATION processInfo{};
    const BOOL created = CreateProcessW(paths.executable.c_str(), mutableCommand.data(), nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        environment.data(), paths.root.c_str(), &startup.StartupInfo, &processInfo);
    DeleteProcThreadAttributeList(attributes);
    SecureZeroMemory(attributeStorage.data(), attributeStorage.size());
    if (!created) return TesseractResult::Unavailable;
    UniqueHandle process(processInfo.hProcess), thread(processInfo.hThread);
    if (!AssignProcessToJobObject(job.get(), process.get()) || ResumeThread(thread.get()) == static_cast<DWORD>(-1)) {
        TerminateProcess(process.get(), 2);
        WaitForSingleObject(process.get(), 1'000);
        return TesseractResult::Unavailable;
    }
    childInput.reset();
    childOutput.reset();

    HANDLE writerHandle = parentInput.release();
    bool writeOk = false;
    std::thread writer([writerHandle, &bmp, &writeOk]() {
        writeOk = WriteAll(writerHandle, bmp.data(), bmp.size());
        CloseHandle(writerHandle);
    });

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(OcrTimeoutMilliseconds);
    bool timeout = false;
    bool oversized = false;
    bool ioFailed = false;
    for (;;) {
        DWORD available = 0;
        if (!PeekNamedPipe(parentOutput.get(), nullptr, 0, nullptr, &available, nullptr)) {
            if (GetLastError() == ERROR_BROKEN_PIPE) break;
            ioFailed = true;
            break;
        }
        if (available > 0) {
            std::array<char, 16 * 1024> buffer{};
            DWORD read = 0;
            if (!ReadFile(parentOutput.get(), buffer.data(), static_cast<DWORD>(std::min<std::size_t>(buffer.size(), available)), &read, nullptr)) { ioFailed = true; break; }
            if (output.size() + read > MaximumOcrOutputBytes) { oversized = true; break; }
            output.append(buffer.data(), read);
            SecureZeroMemory(buffer.data(), buffer.size());
            continue;
        }
        if (WaitForSingleObject(process.get(), 0) == WAIT_OBJECT_0) break;
        if (std::chrono::steady_clock::now() >= deadline) { timeout = true; break; }
        Sleep(10);
    }
    if (timeout || oversized || ioFailed) TerminateJobObject(job.get(), 2);
    WaitForSingleObject(process.get(), 1'000);
    writer.join();
    DWORD exitCode = 1;
    GetExitCodeProcess(process.get(), &exitCode);
    if (timeout) return TesseractResult::Timeout;
    if (oversized || ioFailed || !writeOk || exitCode != 0 || output.empty()) return TesseractResult::Malformed;
    return TesseractResult::Success;
}

std::string JsonEscape(std::string_view value) {
    std::string output;
    output.reserve(value.size() + 16);
    constexpr char Hex[] = "0123456789abcdef";
    for (const unsigned char character : value) {
        switch (character) {
            case '"': output += "\\\""; break;
            case '\\': output += "\\\\"; break;
            case '\b': output += "\\b"; break;
            case '\f': output += "\\f"; break;
            case '\n': output += "\\n"; break;
            case '\r': output += "\\r"; break;
            case '\t': output += "\\t"; break;
            default:
                if (character < 0x20) {
                    output += "\\u00";
                    output.push_back(Hex[character >> 4]);
                    output.push_back(Hex[character & 0x0f]);
                } else output.push_back(static_cast<char>(character));
        }
    }
    return output;
}

bool WriteFramedJson(std::string_view json) {
    if (json.empty() || json.size() > 64 * 1024) return false;
    const auto header = CaptionFrameHeader(1, static_cast<std::uint32_t>(json.size()));
    return std::fwrite(header.data(), 1, header.size(), stdout) == header.size() &&
        std::fwrite(json.data(), 1, json.size(), stdout) == json.size() && std::fflush(stdout) == 0;
}

bool EmitState(std::string_view state, std::string_view reason) {
    return WriteFramedJson("{\"v\":1,\"type\":\"state\",\"state\":\"" + std::string(state) + "\",\"reason\":\"" + std::string(reason) + "\"}");
}

bool EmitTick(std::uint64_t observedAtMs) {
    return WriteFramedJson("{\"v\":1,\"type\":\"tick\",\"observedAtMs\":" + std::to_string(observedAtMs) + "}");
}

bool EmitRowEvent(const CaptionRowEvent& event) {
    if (event.type == CaptionRowEvent::Type::Disappeared) {
        return WriteFramedJson("{\"v\":1,\"type\":\"row-disappeared\",\"rowId\":\"" + event.rowId +
            "\",\"observedAtMs\":" + std::to_string(event.observedAtMs) + "}");
    }
    std::string json = "{\"v\":1,\"type\":\"observation\",\"rowId\":\"" + event.rowId +
        "\",\"revision\":" + std::to_string(event.revision) + ",\"source\":\"teams-ocr\",\"speaker\":\"" + event.speaker + "\"";
    if (!event.speakerAlias.empty()) json += ",\"speakerAlias\":\"" + event.speakerAlias + "\"";
    json += ",\"observedAtMs\":" + std::to_string(event.observedAtMs) + ",\"text\":\"" + JsonEscape(event.text) +
        "\",\"confidence\":" + std::to_string(event.confidence) + "}";
    const bool written = WriteFramedJson(json);
    SecureZeroMemory(json.data(), json.size());
    return written;
}

const char* DecisionReason(SelectionDecision decision) {
    switch (decision) {
        case SelectionDecision::TeamsNotVisible: return "teams-not-visible";
        case SelectionDecision::TeamsNotForeground: return "teams-not-foreground";
        case SelectionDecision::TeamsMinimized: return "teams-minimized";
        case SelectionDecision::DpiChanged: return "dpi-changed";
        case SelectionDecision::SelectionInvalid: return "selection-invalid";
        case SelectionDecision::SelectionOutsideClient: return "selection-outside-client";
        case SelectionDecision::SelectionTooLarge: return "selection-too-large";
        case SelectionDecision::SelectionOwnedByAnotherProcess: return "selection-covered";
        case SelectionDecision::Allowed: return "ready";
    }
    return "capture-unsupported";
}

std::optional<std::string> RandomRowPrefix() {
    std::array<unsigned char, 4> random{};
    if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return std::nullopt;
    constexpr char Hex[] = "0123456789abcdef";
    std::string prefix = "ocr-";
    for (const unsigned char byte : random) { prefix.push_back(Hex[byte >> 4]); prefix.push_back(Hex[byte & 0x0f]); }
    prefix.push_back('-');
    SecureZeroMemory(random.data(), random.size());
    return prefix;
}

} // namespace

int RunOcrStatus() {
    const auto paths = ResolveOcrPaths();
    const bool ready = paths && VerifyOcrInstallation(*paths);
    const std::string json = std::string("{\"contractVersion\":1,\"state\":\"") + (ready ? "ready" : "ocr-unavailable") +
        "\",\"contentInspected\":false,\"contentEmitted\":false,\"contentPersisted\":false}\n";
    return std::fwrite(json.data(), 1, json.size(), stdout) == json.size() ? (ready ? 0 : 2) : 3;
}

int RunOcrCapture(std::string sessionProof) {
    const bool companionVerified = GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) == FILE_TYPE_PIPE && VerifyCompanionProof(sessionProof);
    SecureZeroMemory(sessionProof.data(), sessionProof.size());
    sessionProof.clear();
    if (!companionVerified) return 2;
    const auto paths = ResolveOcrPaths();
    if (!paths || !VerifyOcrInstallation(*paths)) { EmitState("degraded-caption-missing", "ocr-unavailable"); return 2; }
    HWND teamsWindow = GetForegroundWindow();
    DWORD teamsProcess = 0;
    if (!IsExpectedTeamsWindow(teamsWindow, teamsProcess)) { EmitState("degraded-caption-missing", "teams-not-foreground"); return 2; }
    RECT client{};
    if (!ClientScreenRect(teamsWindow, client)) { EmitState("degraded-caption-missing", "teams-window-unavailable"); return 2; }
    if (!EmitState("selecting-target", "user-selection-required")) return 3;
    const auto selection = SelectCaptionRegion(teamsWindow, client);
    if (!selection) { EmitState("stopped", "selection-cancelled"); return 2; }
    const std::uint32_t selectionDpi = GetDpiForWindow(teamsWindow);
    const SelectionDecision initial = ValidateSelection(Snapshot(teamsWindow, teamsProcess, *selection), *selection, selectionDpi);
    if (initial != SelectionDecision::Allowed) { EmitState("degraded-caption-missing", DecisionReason(initial)); return 2; }
    if (!EmitState("active-ocr", "capture-started")) return 3;

    const auto rowPrefix = RandomRowPrefix();
    if (!rowPrefix) { EmitState("degraded-caption-missing", "capture-unsupported"); return 2; }
    SpeakerAliasTable aliases;
    CaptionRowTracker tracker(*rowPrefix);
    const auto started = std::chrono::steady_clock::now();
    for (;;) {
        const auto iterationStarted = std::chrono::steady_clock::now();
        const auto observedAtMs = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(iterationStarted - started).count());
        const SelectionDecision decision = ValidateSelection(Snapshot(teamsWindow, teamsProcess, *selection), *selection, selectionDpi);
        if (decision != SelectionDecision::Allowed) { EmitState("degraded-caption-missing", DecisionReason(decision)); return 2; }
        auto bmp = CaptureSelectedBmpBounded(teamsWindow, *selection, selectionDpi);
        if (!bmp) { EmitState("degraded-caption-missing", "capture-unsupported"); return 2; }
        std::string tsv;
        const TesseractResult ocr = RunTesseract(*paths, *bmp, tsv);
        SecureZeroMemory(bmp->data(), bmp->size());
        bmp->clear();
        if (ocr != TesseractResult::Success) {
            SecureZeroMemory(tsv.data(), tsv.size());
            EmitState("degraded-caption-missing", ocr == TesseractResult::Timeout ? "ocr-timeout" : "ocr-unavailable");
            return 2;
        }
        auto parsed = ParseTesseractTsv(tsv);
        std::vector<SafeCaptionLine> safe;
        safe.reserve(parsed.size());
        for (const auto& line : parsed) {
            auto anonymized = aliases.Anonymize(line);
            if (anonymized) safe.push_back(std::move(*anonymized));
        }
        for (auto& line : parsed) {
            SecureZeroMemory(line.text.data(), line.text.size());
            line.text.clear();
        }
        parsed.clear();
        SecureZeroMemory(tsv.data(), tsv.size());
        tsv.clear();
        auto frame = tracker.Apply(safe, observedAtMs);
        for (auto& line : safe) {
            SecureZeroMemory(line.text.data(), line.text.size());
            line.text.clear();
            SecureZeroMemory(line.speakerAlias.data(), line.speakerAlias.size());
            line.speakerAlias.clear();
        }
        if (frame.lowConfidence) { EmitState("degraded-low-confidence", "low-confidence"); return 2; }
        bool eventsWritten = true;
        for (const auto& event : frame.events) if (!EmitRowEvent(event)) { eventsWritten = false; break; }
        for (auto& event : frame.events) {
            SecureZeroMemory(event.text.data(), event.text.size());
            event.text.clear();
            SecureZeroMemory(event.speakerAlias.data(), event.speakerAlias.size());
            event.speakerAlias.clear();
        }
        frame.events.clear();
        if (!eventsWritten) return 3;
        if (!EmitTick(observedAtMs)) return 3;
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - iterationStarted);
        if (elapsed.count() < CaptureCadenceMilliseconds) Sleep(CaptureCadenceMilliseconds - static_cast<DWORD>(elapsed.count()));
    }
}

int RunCaptureFrameWorker(std::uintptr_t windowValue, PixelRect selection, std::uint32_t selectionDpi) {
    if (GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) != FILE_TYPE_PIPE || !ParentIsSameExecutable()) return 2;
    HWND window = reinterpret_cast<HWND>(windowValue);
    DWORD processId = 0;
    if (!IsExpectedTeamsWindow(window, processId) || ValidateSelection(Snapshot(window, processId, selection), selection, selectionDpi) != SelectionDecision::Allowed) return 2;
    auto bmp = CaptureSelectedBmpUnsafe(window, selection);
    if (!bmp) return 2;
    const bool written = std::fwrite(bmp->data(), 1, bmp->size(), stdout) == bmp->size() && std::fflush(stdout) == 0;
    SecureZeroMemory(bmp->data(), bmp->size());
    return written ? 0 : 3;
}

} // namespace techmap::captions
