#include <windows.h>
#include <aclapi.h>
#include <dpapi.h>
#include <knownfolders.h>
#include <shlobj.h>
#include <wincred.h>

#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace {

constexpr std::size_t MaximumSessionBytes = 8 * 1024 * 1024;
constexpr std::size_t MaximumCredentialBytes = 512;
constexpr std::wstring_view CredentialTarget = L"TechMapLive/OpenAIApiKey";
constexpr std::array<std::uint8_t, 24> Entropy{
    0x54, 0x65, 0x63, 0x68, 0x4d, 0x61, 0x70, 0x4c, 0x69, 0x76, 0x65, 0x2d,
    0x73, 0x65, 0x73, 0x73, 0x69, 0x6f, 0x6e, 0x2d, 0x76, 0x31, 0x21, 0x00,
};

struct LocalFreeDeleter final {
    void operator()(void* pointer) const noexcept { if (pointer != nullptr) LocalFree(pointer); }
};

struct HandleDeleter final {
    void operator()(void* handle) const noexcept { if (handle != nullptr && handle != INVALID_HANDLE_VALUE) CloseHandle(handle); }
};

using UniqueLocal = std::unique_ptr<void, LocalFreeDeleter>;
using UniqueHandle = std::unique_ptr<void, HandleDeleter>;

bool WriteAll(const void* data, std::size_t size) {
    const auto* cursor = static_cast<const std::uint8_t*>(data);
    while (size > 0) {
        const std::size_t written = std::fwrite(cursor, 1, size, stdout);
        if (written == 0) return false;
        cursor += written;
        size -= written;
    }
    return std::fflush(stdout) == 0;
}

bool WriteText(std::string_view value) { return WriteAll(value.data(), value.size()); }

bool ReadAll(std::vector<std::uint8_t>& result, std::size_t maximumBytes) {
    std::array<std::uint8_t, 16 * 1024> buffer{};
    while (true) {
        const std::size_t count = std::fread(buffer.data(), 1, buffer.size(), stdin);
        if (count > 0) {
            if (result.size() + count > maximumBytes) return false;
            result.insert(result.end(), buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(count));
        }
        if (count < buffer.size()) return std::feof(stdin) != 0;
    }
}

bool ReadCredentialInput(std::vector<std::uint8_t>& result) {
    if (_isatty(_fileno(stdin)) == 0) return ReadAll(result, MaximumCredentialBytes);
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    DWORD originalMode = 0;
    if (input == INVALID_HANDLE_VALUE || !GetConsoleMode(input, &originalMode)) return false;
    if (!SetConsoleMode(input, originalMode & ~ENABLE_ECHO_INPUT)) return false;
    std::array<wchar_t, MaximumCredentialBytes + 3> characters{};
    DWORD count = 0;
    std::fputs("OpenAI API key (input hidden): ", stderr);
    const bool read = ReadConsoleW(input, characters.data(), static_cast<DWORD>(characters.size() - 1), &count, nullptr) != FALSE;
    SetConsoleMode(input, originalMode);
    std::fputs("\n", stderr);
    if (!read) return false;
    while (count > 0 && (characters[count - 1] == L'\r' || characters[count - 1] == L'\n')) --count;
    result.reserve(count);
    for (DWORD index = 0; index < count; ++index) {
        if (characters[index] < 0x21 || characters[index] > 0x7e) {
            SecureZeroMemory(characters.data(), characters.size() * sizeof(wchar_t));
            if (!result.empty()) SecureZeroMemory(result.data(), result.size());
            return false;
        }
        result.push_back(static_cast<std::uint8_t>(characters[index]));
    }
    SecureZeroMemory(characters.data(), characters.size() * sizeof(wchar_t));
    return true;
}

bool CurrentUserSid(std::vector<std::uint8_t>& sidBuffer) {
    HANDLE rawToken = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &rawToken)) return false;
    UniqueHandle token(rawToken);
    DWORD size = 0;
    GetTokenInformation(token.get(), TokenUser, nullptr, 0, &size);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0) return false;
    sidBuffer.resize(size);
    return GetTokenInformation(token.get(), TokenUser, sidBuffer.data(), size, &size) != FALSE;
}

bool BuildUserOnlyAcl(PSID userSid, PACL* acl) {
    EXPLICIT_ACCESSW access{};
    access.grfAccessPermissions = FILE_ALL_ACCESS;
    access.grfAccessMode = SET_ACCESS;
    access.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access.Trustee.TrusteeType = TRUSTEE_IS_USER;
    access.Trustee.ptstrName = static_cast<LPWSTR>(userSid);
    return SetEntriesInAclW(1, &access, nullptr, acl) == ERROR_SUCCESS;
}

bool ApplyUserOnlyAcl(const std::wstring& path, PSID userSid) {
    PACL rawAcl = nullptr;
    if (!BuildUserOnlyAcl(userSid, &rawAcl)) return false;
    UniqueLocal acl(rawAcl);
    return SetNamedSecurityInfoW(
        const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, rawAcl, nullptr) == ERROR_SUCCESS;
}

bool CreateSecureDirectory(const std::wstring& path, PSID userSid) {
    PACL rawAcl = nullptr;
    if (!BuildUserOnlyAcl(userSid, &rawAcl)) return false;
    UniqueLocal acl(rawAcl);
    SECURITY_DESCRIPTOR descriptor{};
    if (!InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorDacl(&descriptor, TRUE, rawAcl, FALSE)) return false;
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), &descriptor, FALSE};
    if (!CreateDirectoryW(path.c_str(), &attributes) && GetLastError() != ERROR_ALREADY_EXISTS) return false;
    const DWORD fileAttributes = GetFileAttributesW(path.c_str());
    if (fileAttributes == INVALID_FILE_ATTRIBUTES || (fileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || (fileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return false;
    return ApplyUserOnlyAcl(path, userSid);
}

bool VerifyUserOnlyAcl(const std::wstring& path, PSID userSid) {
    PACL rawAcl = nullptr;
    PSECURITY_DESCRIPTOR rawDescriptor = nullptr;
    const DWORD result = GetNamedSecurityInfoW(
        const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, &rawAcl, nullptr, &rawDescriptor);
    UniqueLocal descriptor(rawDescriptor);
    if (result != ERROR_SUCCESS || rawAcl == nullptr || rawAcl->AceCount != 1) return false;
    void* rawAce = nullptr;
    if (!GetAce(rawAcl, 0, &rawAce)) return false;
    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(rawAce);
    if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || (ace->Header.AceFlags & INHERITED_ACE) != 0) return false;
    const PSID aceSid = const_cast<DWORD*>(&ace->SidStart);
    return EqualSid(aceSid, userSid) != FALSE && (ace->Mask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS;
}

std::wstring LocalSessionRoot() {
    PWSTR rawPath = nullptr;
    if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_CREATE, nullptr, &rawPath))) return {};
    UniqueLocal path(rawPath);
    return std::wstring(rawPath) + L"\\TechMapLive\\sessions";
}

bool ProvisionRoot(const std::wstring& root) {
    std::vector<std::uint8_t> sidBuffer;
    if (!CurrentUserSid(sidBuffer)) return false;
    const PSID sid = reinterpret_cast<TOKEN_USER*>(sidBuffer.data())->User.Sid;
    const std::size_t separator = root.find_last_of(L"\\/");
    if (separator == std::wstring::npos) return false;
    const std::wstring parent = root.substr(0, separator);
    return CreateSecureDirectory(parent, sid) && VerifyUserOnlyAcl(parent, sid) && CreateSecureDirectory(root, sid) && VerifyUserOnlyAcl(root, sid);
}

bool Protect(const std::vector<std::uint8_t>& input, std::vector<std::uint8_t>& output) {
    DATA_BLOB inputBlob{static_cast<DWORD>(input.size()), const_cast<BYTE*>(input.data())};
    DATA_BLOB entropyBlob{static_cast<DWORD>(Entropy.size()), const_cast<BYTE*>(Entropy.data())};
    DATA_BLOB outputBlob{};
    if (!CryptProtectData(&inputBlob, L"TechMap Live local session", &entropyBlob, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &outputBlob)) return false;
    UniqueLocal protectedMemory(outputBlob.pbData);
    output.assign(outputBlob.pbData, outputBlob.pbData + outputBlob.cbData);
    return true;
}

bool Unprotect(const std::vector<std::uint8_t>& input, std::vector<std::uint8_t>& output) {
    DATA_BLOB inputBlob{static_cast<DWORD>(input.size()), const_cast<BYTE*>(input.data())};
    DATA_BLOB entropyBlob{static_cast<DWORD>(Entropy.size()), const_cast<BYTE*>(Entropy.data())};
    DATA_BLOB outputBlob{};
    if (!CryptUnprotectData(&inputBlob, nullptr, &entropyBlob, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &outputBlob)) return false;
    UniqueLocal clearMemory(outputBlob.pbData);
    output.assign(outputBlob.pbData, outputBlob.pbData + outputBlob.cbData);
    return true;
}

bool ValidCredential(const std::vector<std::uint8_t>& value) {
    if (value.size() < 20 || value.size() > MaximumCredentialBytes) return false;
    return std::all_of(value.begin(), value.end(), [](std::uint8_t character) { return character >= 0x21 && character <= 0x7e; }) &&
        value[0] == 's' && value[1] == 'k' && value[2] == '-';
}

bool StoreCredential(std::wstring_view target, std::vector<std::uint8_t>& value) {
    if (!ValidCredential(value)) {
        if (!value.empty()) SecureZeroMemory(value.data(), value.size());
        return false;
    }
    CREDENTIALW credential{};
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = const_cast<LPWSTR>(target.data());
    credential.CredentialBlobSize = static_cast<DWORD>(value.size());
    credential.CredentialBlob = value.data();
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    credential.UserName = const_cast<LPWSTR>(L"OpenAI API");
    const bool stored = CredWriteW(&credential, 0) != FALSE;
    SecureZeroMemory(value.data(), value.size());
    return stored;
}

bool CredentialExists(std::wstring_view target) {
    PCREDENTIALW credential = nullptr;
    if (!CredReadW(target.data(), CRED_TYPE_GENERIC, 0, &credential)) return false;
    CredFree(credential);
    return true;
}

bool DeleteCredential(std::wstring_view target) {
    return CredDeleteW(target.data(), CRED_TYPE_GENERIC, 0) != FALSE || GetLastError() == ERROR_NOT_FOUND;
}

bool SelfTest() {
    std::vector<std::uint8_t> clear{'s', 'y', 'n', 't', 'h', 'e', 't', 'i', 'c'};
    std::vector<std::uint8_t> sealed;
    std::vector<std::uint8_t> opened;
    if (!Protect(clear, sealed) || !Unprotect(sealed, opened) || clear != opened) return false;

    std::wstring target = L"TechMapLive/Test/" + std::to_wstring(GetCurrentProcessId());
    std::vector<std::uint8_t> key{'s','k','-','s','y','n','t','h','e','t','i','c','-','t','e','s','t','-','o','n','l','y','-','0','0','0','1'};
    if (!StoreCredential(target, key) || !CredentialExists(target) || !DeleteCredential(target)) return false;

    wchar_t temporary[MAX_PATH]{};
    if (GetTempPathW(MAX_PATH, temporary) == 0) return false;
    const std::wstring root = std::wstring(temporary) + L"TechMapLivePrivacyTest-" + std::to_wstring(GetCurrentProcessId());
    std::vector<std::uint8_t> sidBuffer;
    if (!CurrentUserSid(sidBuffer)) return false;
    const PSID sid = reinterpret_cast<TOKEN_USER*>(sidBuffer.data())->User.Sid;
    const bool secure = CreateSecureDirectory(root, sid) && VerifyUserOnlyAcl(root, sid);
    RemoveDirectoryW(root.c_str());
    return secure;
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    if (_setmode(_fileno(stdin), _O_BINARY) == -1 || _setmode(_fileno(stdout), _O_BINARY) == -1) return 2;
    if (argc != 2) return 2;
    const std::wstring_view command(argv[1]);

    if (command == L"provision-store") {
        const std::wstring root = LocalSessionRoot();
        return !root.empty() && ProvisionRoot(root) && WriteText("{\"secure\":true,\"location\":\"%LOCALAPPDATA%\\\\TechMapLive\\\\sessions\"}\n") ? 0 : 3;
    }
    if (command == L"seal" || command == L"unseal") {
        std::vector<std::uint8_t> input;
        std::vector<std::uint8_t> output;
        if (!ReadAll(input, MaximumSessionBytes) || input.empty()) return 4;
        const bool succeeded = command == L"seal" ? Protect(input, output) : Unprotect(input, output);
        SecureZeroMemory(input.data(), input.size());
        const bool written = succeeded && output.size() <= MaximumSessionBytes && WriteAll(output.data(), output.size());
        if (!output.empty()) SecureZeroMemory(output.data(), output.size());
        return written ? 0 : 5;
    }
    if (command == L"store-key") {
        std::vector<std::uint8_t> value;
        if (!ReadCredentialInput(value)) return 4;
        return StoreCredential(CredentialTarget, value) ? 0 : 5;
    }
    if (command == L"key-status") return WriteText(CredentialExists(CredentialTarget) ? "{\"configured\":true}\n" : "{\"configured\":false}\n") ? 0 : 5;
    if (command == L"delete-key") return DeleteCredential(CredentialTarget) ? 0 : 5;
    if (command == L"self-test") return SelfTest() && WriteText("{\"selfTest\":true}\n") ? 0 : 6;
    return 2;
}
