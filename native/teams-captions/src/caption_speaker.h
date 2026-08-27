#pragma once

#include "caption_tsv.h"

#include <algorithm>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace techmap::captions {

struct SafeCaptionLine final {
    std::string lineKey;
    std::string speaker;
    std::string speakerAlias;
    std::string text;
    int confidence;
};

class SpeakerAliasTable final {
public:
    SpeakerAliasTable() = default;
    SpeakerAliasTable(const SpeakerAliasTable&) = delete;
    SpeakerAliasTable& operator=(const SpeakerAliasTable&) = delete;
    ~SpeakerAliasTable() { Clear(); }

    SafeCaptionLine Anonymize(const ParsedCaptionLine& input) {
        const std::size_t asciiColon = input.text.find(':');
        const std::size_t fullWidthColon = input.text.find("：");
        const std::size_t separator = std::min(asciiColon, fullWidthColon);
        if (separator == std::string::npos || separator == 0 || separator > 256) {
            return {input.lineKey, "unknown", {}, input.text, input.confidence};
        }
        const std::size_t colonBytes = separator == fullWidthColon ? std::string_view("：").size() : 1;
        std::string_view name(input.text.data(), separator);
        std::string_view body(input.text.data() + separator + colonBytes, input.text.size() - separator - colonBytes);
        Trim(name);
        Trim(body);
        if (name.empty() || body.empty() || HasUnsafeName(name)) {
            return {input.lineKey, "unknown", {}, input.text, input.confidence};
        }
        const std::string alias = AliasFor(name);
        if (alias.empty()) return {input.lineKey, "unknown", {}, std::string(body), input.confidence};
        return {input.lineKey, "displayed-alias", alias, std::string(body), input.confidence};
    }

    void Clear() noexcept {
        for (auto& entry : entries_) {
            std::fill(entry.name.begin(), entry.name.end(), '\0');
            std::fill(entry.alias.begin(), entry.alias.end(), '\0');
        }
        entries_.clear();
    }

    std::size_t Size() const noexcept { return entries_.size(); }

private:
    struct Entry final { std::string name; std::string alias; };
    std::vector<Entry> entries_;

    static void Trim(std::string_view& value) {
        while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) value.remove_prefix(1);
        while (!value.empty() && (value.back() == ' ' || value.back() == '\t')) value.remove_suffix(1);
    }

    static bool HasUnsafeName(std::string_view value) {
        return std::any_of(value.begin(), value.end(), [](unsigned char character) {
            return character < 0x20 || character == 0x7f;
        });
    }

    std::string AliasFor(std::string_view name) {
        const auto existing = std::find_if(entries_.begin(), entries_.end(), [&](const Entry& entry) { return entry.name == name; });
        if (existing != entries_.end()) return existing->alias;
        if (entries_.size() >= 999) return {};
        std::string alias = "speaker-" + std::to_string(entries_.size() + 1);
        entries_.push_back({std::string(name), alias});
        return alias;
    }
};

} // namespace techmap::captions
