#include <windows.h>
#include <aclapi.h>
#include <dpapi.h>
#include <knownfolders.h>
#include <shlobj.h>
#include <wincred.h>
#include <winhttp.h>
#include <bcrypt.h>

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
constexpr std::size_t MaximumResponsesRequestBytes = 32 * 1024;
constexpr std::size_t MaximumResponsesResponseBytes = 256 * 1024;
constexpr std::size_t MaximumZoomSignatureInputBytes = 20 * 1024;
constexpr std::wstring_view CredentialTarget = L"TechMapLive/OpenAIApiKey";
constexpr std::wstring_view ZoomClientIdTarget = L"TechMapLive/ZoomClientId";
constexpr std::wstring_view ZoomClientSecretTarget = L"TechMapLive/ZoomClientSecret";
constexpr std::wstring_view ZoomWebhookSecretTarget = L"TechMapLive/ZoomWebhookSecret";
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

struct WinHttpDeleter final {
    void operator()(void* handle) const noexcept { if (handle != nullptr) WinHttpCloseHandle(static_cast<HINTERNET>(handle)); }
};

using UniqueLocal = std::unique_ptr<void, LocalFreeDeleter>;
using UniqueHandle = std::unique_ptr<void, HandleDeleter>;
using UniqueWinHttp = std::unique_ptr<void, WinHttpDeleter>;

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

bool ReadCredentialInput(std::vector<std::uint8_t>& result, const char* prompt) {
    if (_isatty(_fileno(stdin)) == 0) return ReadAll(result, MaximumCredentialBytes);
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    DWORD originalMode = 0;
    if (input == INVALID_HANDLE_VALUE || !GetConsoleMode(input, &originalMode)) return false;
    if (!SetConsoleMode(input, originalMode & ~ENABLE_ECHO_INPUT)) return false;
    std::array<wchar_t, MaximumCredentialBytes + 3> characters{};
    DWORD count = 0;
    std::fputs(prompt, stderr);
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

bool PrintableCredential(const std::vector<std::uint8_t>& value, std::size_t minimum, std::size_t maximum) {
    return value.size() >= minimum && value.size() <= maximum &&
        std::all_of(value.begin(), value.end(), [](std::uint8_t character) { return character >= 0x21 && character <= 0x7e; });
}

bool ValidOpenAiCredential(const std::vector<std::uint8_t>& value) {
    if (value.size() < 20 || value.size() > MaximumCredentialBytes) return false;
    return std::all_of(value.begin(), value.end(), [](std::uint8_t character) { return character >= 0x21 && character <= 0x7e; }) &&
        value[0] == 's' && value[1] == 'k' && value[2] == '-';
}

bool ValidZoomClientId(const std::vector<std::uint8_t>& value) {
    return PrintableCredential(value, 8, 128) && std::all_of(value.begin(), value.end(), [](std::uint8_t character) {
        return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
            (character >= '0' && character <= '9') || character == '_' || character == '-';
    });
}

bool ValidZoomSecret(const std::vector<std::uint8_t>& value) { return PrintableCredential(value, 16, MaximumCredentialBytes); }

using CredentialValidator = bool (*)(const std::vector<std::uint8_t>&);

bool StoreCredential(std::wstring_view target, std::vector<std::uint8_t>& value, CredentialValidator validator, const wchar_t* username) {
    if (!validator(value)) {
        if (!value.empty()) SecureZeroMemory(value.data(), value.size());
        return false;
    }
    CREDENTIALW credential{};
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = const_cast<LPWSTR>(target.data());
    credential.CredentialBlobSize = static_cast<DWORD>(value.size());
    credential.CredentialBlob = value.data();
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    credential.UserName = const_cast<LPWSTR>(username);
    const bool stored = CredWriteW(&credential, 0) != FALSE;
    SecureZeroMemory(value.data(), value.size());
    return stored;
}

bool ReadStoredCredential(std::wstring_view target, std::vector<std::uint8_t>& value, CredentialValidator validator) {
    PCREDENTIALW rawCredential = nullptr;
    if (!CredReadW(target.data(), CRED_TYPE_GENERIC, 0, &rawCredential) || rawCredential == nullptr) return false;
    std::unique_ptr<CREDENTIALW, decltype(&CredFree)> credential(rawCredential, CredFree);
    if (rawCredential->CredentialBlob == nullptr || rawCredential->CredentialBlobSize > MaximumCredentialBytes) return false;
    value.assign(rawCredential->CredentialBlob, rawCredential->CredentialBlob + rawCredential->CredentialBlobSize);
    SecureZeroMemory(rawCredential->CredentialBlob, rawCredential->CredentialBlobSize);
    if (validator(value)) return true;
    if (!value.empty()) SecureZeroMemory(value.data(), value.size());
    value.clear();
    return false;
}

bool HmacSha256(const std::vector<std::uint8_t>& key, const std::vector<std::uint8_t>& input, std::array<std::uint8_t, 32>& digest) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    DWORD objectSize = 0;
    DWORD copied = 0;
    bool succeeded = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, BCRYPT_ALG_HANDLE_HMAC_FLAG) >= 0 &&
        BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectSize), sizeof(objectSize), &copied, 0) >= 0 && objectSize > 0;
    std::vector<std::uint8_t> object(succeeded ? objectSize : 0);
    if (succeeded) succeeded = BCryptCreateHash(algorithm, &hash, object.data(), objectSize,
        const_cast<PUCHAR>(key.data()), static_cast<ULONG>(key.size()), 0) >= 0;
    if (succeeded) succeeded = BCryptHashData(hash, const_cast<PUCHAR>(input.data()), static_cast<ULONG>(input.size()), 0) >= 0 &&
        BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) >= 0;
    if (hash != nullptr) BCryptDestroyHash(hash);
    if (algorithm != nullptr) BCryptCloseAlgorithmProvider(algorithm, 0);
    if (!object.empty()) SecureZeroMemory(object.data(), object.size());
    if (!succeeded) SecureZeroMemory(digest.data(), digest.size());
    return succeeded;
}

bool WriteHexDigest(const std::array<std::uint8_t, 32>& digest) {
    constexpr char digits[] = "0123456789abcdef";
    std::array<char, 65> encoded{};
    for (std::size_t index = 0; index < digest.size(); ++index) {
        encoded[index * 2] = digits[digest[index] >> 4];
        encoded[index * 2 + 1] = digits[digest[index] & 0x0f];
    }
    encoded[64] = '\n';
    return WriteAll(encoded.data(), encoded.size());
}

bool DecodeHexDigest(std::string_view encoded, std::array<std::uint8_t, 32>& digest) {
    if (encoded.size() != 64) return false;
    const auto nibble = [](char value) -> int {
        if (value >= '0' && value <= '9') return value - '0';
        if (value >= 'a' && value <= 'f') return value - 'a' + 10;
        return -1;
    };
    for (std::size_t index = 0; index < digest.size(); ++index) {
        const int high = nibble(encoded[index * 2]);
        const int low = nibble(encoded[index * 2 + 1]);
        if (high < 0 || low < 0) { SecureZeroMemory(digest.data(), digest.size()); return false; }
        digest[index] = static_cast<std::uint8_t>((high << 4) | low);
    }
    return true;
}

bool ConstantTimeEqual(const std::array<std::uint8_t, 32>& left, const std::array<std::uint8_t, 32>& right) {
    std::uint8_t difference = 0;
    for (std::size_t index = 0; index < left.size(); ++index) difference |= left[index] ^ right[index];
    return difference == 0;
}

bool ValidZoomOpaque(const std::uint8_t* begin, std::size_t size) {
    if (size == 0 || size > 256) return false;
    return std::all_of(begin, begin + size, [](std::uint8_t character) {
        return character >= 0x21 && character <= 0x7e && character != ',';
    });
}

bool SignZoomClient(std::vector<std::uint8_t>& framed) {
    if (framed.size() < 6) { if (!framed.empty()) SecureZeroMemory(framed.data(), framed.size()); return false; }
    const std::size_t meetingSize = static_cast<std::size_t>(framed[0]) | (static_cast<std::size_t>(framed[1]) << 8);
    const std::size_t streamOffset = 2 + meetingSize;
    if (streamOffset + 2 > framed.size()) { SecureZeroMemory(framed.data(), framed.size()); return false; }
    const std::size_t streamSize = static_cast<std::size_t>(framed[streamOffset]) | (static_cast<std::size_t>(framed[streamOffset + 1]) << 8);
    const std::size_t streamDataOffset = streamOffset + 2;
    if (streamDataOffset + streamSize != framed.size() || !ValidZoomOpaque(framed.data() + 2, meetingSize) ||
        !ValidZoomOpaque(framed.data() + streamDataOffset, streamSize)) {
        SecureZeroMemory(framed.data(), framed.size());
        return false;
    }
    std::vector<std::uint8_t> clientId;
    std::vector<std::uint8_t> secret;
    std::array<std::uint8_t, 32> digest{};
    bool succeeded = ReadStoredCredential(ZoomClientIdTarget, clientId, ValidZoomClientId) &&
        ReadStoredCredential(ZoomClientSecretTarget, secret, ValidZoomSecret);
    if (succeeded) {
        std::vector<std::uint8_t> message;
        message.reserve(clientId.size() + meetingSize + streamSize + 2);
        message.insert(message.end(), clientId.begin(), clientId.end());
        message.push_back(',');
        message.insert(message.end(), framed.begin() + 2, framed.begin() + static_cast<std::ptrdiff_t>(streamOffset));
        message.push_back(',');
        message.insert(message.end(), framed.begin() + static_cast<std::ptrdiff_t>(streamDataOffset), framed.end());
        succeeded = HmacSha256(secret, message, digest);
        if (!message.empty()) SecureZeroMemory(message.data(), message.size());
    }
    if (!clientId.empty()) SecureZeroMemory(clientId.data(), clientId.size());
    if (!secret.empty()) SecureZeroMemory(secret.data(), secret.size());
    SecureZeroMemory(framed.data(), framed.size());
    const bool written = succeeded && WriteHexDigest(digest);
    SecureZeroMemory(digest.data(), digest.size());
    return written;
}

bool VerifyZoomWebhook(std::vector<std::uint8_t>& framed) {
    constexpr std::size_t prefixSize = 10 + 67;
    if (framed.size() <= prefixSize || framed.size() > MaximumZoomSignatureInputBytes ||
        !std::all_of(framed.begin(), framed.begin() + 10, [](std::uint8_t value) { return value >= '0' && value <= '9'; }) ||
        framed[10] != 'v' || framed[11] != '0' || framed[12] != '=') {
        if (!framed.empty()) SecureZeroMemory(framed.data(), framed.size());
        return false;
    }
    std::array<std::uint8_t, 32> supplied{};
    if (!DecodeHexDigest(std::string_view(reinterpret_cast<const char*>(framed.data() + 13), 64), supplied)) {
        SecureZeroMemory(framed.data(), framed.size());
        return false;
    }
    std::vector<std::uint8_t> key;
    std::vector<std::uint8_t> message;
    std::array<std::uint8_t, 32> expected{};
    message.reserve(framed.size() - prefixSize + 14);
    message.insert(message.end(), {'v', '0', ':'});
    message.insert(message.end(), framed.begin(), framed.begin() + 10);
    message.push_back(':');
    message.insert(message.end(), framed.begin() + static_cast<std::ptrdiff_t>(prefixSize), framed.end());
    const bool verified = ReadStoredCredential(ZoomWebhookSecretTarget, key, ValidZoomSecret) &&
        HmacSha256(key, message, expected) && ConstantTimeEqual(expected, supplied);
    if (!key.empty()) SecureZeroMemory(key.data(), key.size());
    if (!message.empty()) SecureZeroMemory(message.data(), message.size());
    SecureZeroMemory(expected.data(), expected.size());
    SecureZeroMemory(supplied.data(), supplied.size());
    SecureZeroMemory(framed.data(), framed.size());
    return WriteText(verified ? "{\"valid\":true}\n" : "{\"valid\":false}\n");
}

bool SignZoomUrlValidation(std::vector<std::uint8_t>& token) {
    if (!PrintableCredential(token, 1, 256)) { if (!token.empty()) SecureZeroMemory(token.data(), token.size()); return false; }
    std::vector<std::uint8_t> key;
    std::array<std::uint8_t, 32> digest{};
    const bool signedValue = ReadStoredCredential(ZoomWebhookSecretTarget, key, ValidZoomSecret) && HmacSha256(key, token, digest);
    if (!key.empty()) SecureZeroMemory(key.data(), key.size());
    SecureZeroMemory(token.data(), token.size());
    const bool written = signedValue && WriteHexDigest(digest);
    SecureZeroMemory(digest.data(), digest.size());
    return written;
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

bool LooksLikePolicyBoundRequest(const std::vector<std::uint8_t>& input) {
    const std::string_view value(reinterpret_cast<const char*>(input.data()), input.size());
    if (value.empty() || value.front() != '{' || value.back() != '}') return false;
    constexpr std::array<std::string_view, 4> required{R"("store":false)", R"("input":)", R"("type":"json_schema")", R"("strict":true)"};
    constexpr std::array<std::string_view, 7> forbidden{R"("store":true)", R"("previous_response_id":)", R"("conversation":)", R"("background":)", R"("tools":)", R"("file_ids":)", R"("metadata":)"};
    return std::all_of(required.begin(), required.end(), [&](std::string_view token) { return value.find(token) != std::string_view::npos; }) &&
        std::none_of(forbidden.begin(), forbidden.end(), [&](std::string_view token) { return value.find(token) != std::string_view::npos; });
}

bool SendResponsesRequest(const std::vector<std::uint8_t>& input, std::vector<std::uint8_t>& output) {
    if (!LooksLikePolicyBoundRequest(input)) return false;
    PCREDENTIALW rawCredential = nullptr;
    if (!CredReadW(CredentialTarget.data(), CRED_TYPE_GENERIC, 0, &rawCredential) || rawCredential == nullptr) return false;
    std::unique_ptr<CREDENTIALW, decltype(&CredFree)> credential(rawCredential, CredFree);
    if (rawCredential->CredentialBlobSize < 20 || rawCredential->CredentialBlobSize > MaximumCredentialBytes) {
        if (rawCredential->CredentialBlob != nullptr && rawCredential->CredentialBlobSize > 0) SecureZeroMemory(rawCredential->CredentialBlob, rawCredential->CredentialBlobSize);
        return false;
    }
    std::vector<std::uint8_t> key(rawCredential->CredentialBlob, rawCredential->CredentialBlob + rawCredential->CredentialBlobSize);
    SecureZeroMemory(rawCredential->CredentialBlob, rawCredential->CredentialBlobSize);
    if (!ValidOpenAiCredential(key)) { if (!key.empty()) SecureZeroMemory(key.data(), key.size()); return false; }

    constexpr std::wstring_view authorizationPrefix = L"Authorization: Bearer ";
    constexpr std::wstring_view authorizationSuffix = L"\r\nContent-Type: application/json";
    std::wstring authorization;
    authorization.reserve(authorizationPrefix.size() + key.size() + authorizationSuffix.size());
    authorization.append(authorizationPrefix);
    for (const std::uint8_t character : key) authorization.push_back(static_cast<wchar_t>(character));
    authorization.append(authorizationSuffix);

    UniqueWinHttp session(WinHttpOpen(L"TechMapLive/0.1", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
    bool succeeded = session != nullptr;
    if (succeeded) {
        DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
        succeeded = WinHttpSetOption(session.get(), WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols)) != FALSE &&
            WinHttpSetTimeouts(session.get(), 5'000, 5'000, 20'000, 20'000) != FALSE;
    }
    UniqueWinHttp connection(succeeded ? WinHttpConnect(session.get(), L"api.openai.com", INTERNET_DEFAULT_HTTPS_PORT, 0) : nullptr);
    succeeded = succeeded && connection != nullptr;
    UniqueWinHttp request(succeeded ? WinHttpOpenRequest(connection.get(), L"POST", L"/v1/responses", nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE) : nullptr);
    succeeded = succeeded && request != nullptr;
    if (succeeded) {
        DWORD redirectPolicy = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
        succeeded = WinHttpSetOption(request.get(), WINHTTP_OPTION_REDIRECT_POLICY, &redirectPolicy, sizeof(redirectPolicy)) != FALSE;
    }
    if (succeeded) {
        succeeded = WinHttpSendRequest(request.get(), authorization.c_str(), static_cast<DWORD>(authorization.size()),
            const_cast<std::uint8_t*>(input.data()), static_cast<DWORD>(input.size()), static_cast<DWORD>(input.size()), 0) != FALSE &&
            WinHttpReceiveResponse(request.get(), nullptr) != FALSE;
    }
    DWORD status = 0;
    DWORD statusSize = sizeof(status);
    if (succeeded) succeeded = WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX) != FALSE && status == 200;
    while (succeeded) {
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(request.get(), &available)) { succeeded = false; break; }
        if (available == 0) break;
        if (output.size() + available > MaximumResponsesResponseBytes) { succeeded = false; break; }
        const std::size_t offset = output.size();
        output.resize(offset + available);
        DWORD read = 0;
        if (!WinHttpReadData(request.get(), output.data() + offset, available, &read) || read == 0) { succeeded = false; break; }
        output.resize(offset + read);
    }
    if (!key.empty()) SecureZeroMemory(key.data(), key.size());
    if (!authorization.empty()) SecureZeroMemory(authorization.data(), authorization.size() * sizeof(wchar_t));
    if (!succeeded || output.empty()) { if (!output.empty()) SecureZeroMemory(output.data(), output.size()); output.clear(); return false; }
    return true;
}

bool SelfTest() {
    std::vector<std::uint8_t> clear{'s', 'y', 'n', 't', 'h', 'e', 't', 'i', 'c'};
    std::vector<std::uint8_t> sealed;
    std::vector<std::uint8_t> opened;
    if (!Protect(clear, sealed) || !Unprotect(sealed, opened) || clear != opened) return false;

    std::wstring target = L"TechMapLive/Test/" + std::to_wstring(GetCurrentProcessId());
    std::vector<std::uint8_t> key{'s','k','-','s','y','n','t','h','e','t','i','c','-','t','e','s','t','-','o','n','l','y','-','0','0','0','1'};
    if (!StoreCredential(target, key, ValidOpenAiCredential, L"Synthetic test") || !CredentialExists(target) || !DeleteCredential(target)) return false;

    std::vector<std::uint8_t> hmacKey{'s','y','n','t','h','e','t','i','c','-','z','o','o','m','-','s','e','c','r','e','t'};
    std::vector<std::uint8_t> hmacInput{'s','y','n','t','h','e','t','i','c','-','m','e','s','s','a','g','e'};
    std::array<std::uint8_t, 32> hmacDigest{};
    const bool hmacSucceeded = HmacSha256(hmacKey, hmacInput, hmacDigest) &&
        std::any_of(hmacDigest.begin(), hmacDigest.end(), [](std::uint8_t value) { return value != 0; });
    SecureZeroMemory(hmacKey.data(), hmacKey.size());
    SecureZeroMemory(hmacInput.data(), hmacInput.size());
    SecureZeroMemory(hmacDigest.data(), hmacDigest.size());
    if (!hmacSucceeded) return false;

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
        if (!ReadCredentialInput(value, "OpenAI API key (input hidden): ")) return 4;
        return StoreCredential(CredentialTarget, value, ValidOpenAiCredential, L"OpenAI API") ? 0 : 5;
    }
    if (command == L"store-zoom-client-id" || command == L"store-zoom-client-secret" || command == L"store-zoom-webhook-secret") {
        std::vector<std::uint8_t> value;
        const bool isClientId = command == L"store-zoom-client-id";
        const bool isClientSecret = command == L"store-zoom-client-secret";
        const char* prompt = isClientId ? "Zoom RTMS Client ID (input hidden): " :
            isClientSecret ? "Zoom RTMS Client Secret (input hidden): " : "Zoom Webhook Secret Token (input hidden): ";
        if (!ReadCredentialInput(value, prompt)) return 4;
        const auto target = isClientId ? ZoomClientIdTarget : isClientSecret ? ZoomClientSecretTarget : ZoomWebhookSecretTarget;
        const auto validator = isClientId ? ValidZoomClientId : ValidZoomSecret;
        return StoreCredential(target, value, validator, L"Zoom RTMS") ? 0 : 5;
    }
    if (command == L"zoom-client-signature" || command == L"zoom-webhook-verify" || command == L"zoom-url-validation") {
        std::vector<std::uint8_t> input;
        if (!ReadAll(input, MaximumZoomSignatureInputBytes) || input.empty()) return 4;
        return (command == L"zoom-client-signature" ? SignZoomClient(input) :
            command == L"zoom-webhook-verify" ? VerifyZoomWebhook(input) : SignZoomUrlValidation(input)) ? 0 : 5;
    }
    if (command == L"responses") {
        std::vector<std::uint8_t> input;
        std::vector<std::uint8_t> output;
        if (!ReadAll(input, MaximumResponsesRequestBytes) || input.empty()) return 4;
        const bool requested = SendResponsesRequest(input, output);
        SecureZeroMemory(input.data(), input.size());
        const bool written = requested && WriteAll(output.data(), output.size());
        if (!output.empty()) SecureZeroMemory(output.data(), output.size());
        return written ? 0 : 7;
    }
    if (command == L"key-status") return WriteText(CredentialExists(CredentialTarget) ? "{\"configured\":true}\n" : "{\"configured\":false}\n") ? 0 : 5;
    if (command == L"delete-key") return DeleteCredential(CredentialTarget) ? 0 : 5;
    if (command == L"zoom-credentials-status") {
        const bool configured = CredentialExists(ZoomClientIdTarget) && CredentialExists(ZoomClientSecretTarget) && CredentialExists(ZoomWebhookSecretTarget);
        return WriteText(configured ? "{\"configured\":true}\n" : "{\"configured\":false}\n") ? 0 : 5;
    }
    if (command == L"delete-zoom-credentials") {
        return DeleteCredential(ZoomClientIdTarget) && DeleteCredential(ZoomClientSecretTarget) && DeleteCredential(ZoomWebhookSecretTarget) ? 0 : 5;
    }
    if (command == L"self-test") return SelfTest() && WriteText("{\"selfTest\":true}\n") ? 0 : 6;
    return 2;
}
