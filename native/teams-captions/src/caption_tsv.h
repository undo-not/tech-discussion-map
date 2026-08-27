#pragma once

#include <algorithm>
#include <charconv>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace techmap::captions {

struct ParsedCaptionLine final {
    std::string lineKey;
    std::string text;
    int confidence;
};

namespace detail {

inline bool ParseBoundedInt(std::string_view text, int minimum, int maximum, int& output) {
    if (text.empty()) return false;
    int value = 0;
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), value);
    if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size() || value < minimum || value > maximum) return false;
    output = value;
    return true;
}

inline std::vector<std::string_view> Split(std::string_view value, char separator) {
    std::vector<std::string_view> fields;
    std::size_t start = 0;
    while (start <= value.size()) {
        const std::size_t next = value.find(separator, start);
        fields.push_back(value.substr(start, next == std::string_view::npos ? value.size() - start : next - start));
        if (next == std::string_view::npos) break;
        start = next + 1;
    }
    return fields;
}

inline bool HasUnsafeControl(std::string_view value) {
    return std::any_of(value.begin(), value.end(), [](unsigned char character) {
        return character < 0x20 || character == 0x7f;
    });
}

} // namespace detail

inline std::vector<ParsedCaptionLine> ParseTesseractTsv(std::string_view tsv) {
    constexpr std::string_view Header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
    constexpr std::size_t MaximumTsvBytes = 512 * 1024;
    constexpr std::size_t MaximumCaptionTextBytes = 8'000;
    if (tsv.empty() || tsv.size() > MaximumTsvBytes) return {};

    std::vector<ParsedCaptionLine> lines;
    std::vector<int> confidenceTotals;
    std::vector<int> confidenceCounts;
    std::size_t offset = 0;
    bool headerSeen = false;
    while (offset <= tsv.size()) {
        const std::size_t newline = tsv.find('\n', offset);
        std::string_view row = tsv.substr(offset, newline == std::string_view::npos ? tsv.size() - offset : newline - offset);
        if (!row.empty() && row.back() == '\r') row.remove_suffix(1);
        offset = newline == std::string_view::npos ? tsv.size() + 1 : newline + 1;
        if (!headerSeen) {
            if (row != Header) return {};
            headerSeen = true;
            continue;
        }
        if (row.empty()) continue;
        const auto fields = detail::Split(row, '\t');
        if (fields.size() != 12) continue;
        int level = 0;
        int page = 0;
        int block = 0;
        int paragraph = 0;
        int line = 0;
        int confidence = 0;
        if (!detail::ParseBoundedInt(fields[0], 1, 5, level) || level != 5 ||
            !detail::ParseBoundedInt(fields[1], 0, 9'999, page) ||
            !detail::ParseBoundedInt(fields[2], 0, 9'999, block) ||
            !detail::ParseBoundedInt(fields[3], 0, 9'999, paragraph) ||
            !detail::ParseBoundedInt(fields[4], 0, 9'999, line) ||
            !detail::ParseBoundedInt(fields[10], 0, 100, confidence) ||
            fields[11].empty() || detail::HasUnsafeControl(fields[11])) {
            continue;
        }
        const std::string key = std::to_string(page) + '-' + std::to_string(block) + '-' + std::to_string(paragraph) + '-' + std::to_string(line);
        auto existing = std::find_if(lines.begin(), lines.end(), [&](const ParsedCaptionLine& candidate) { return candidate.lineKey == key; });
        std::size_t index = 0;
        if (existing == lines.end()) {
            lines.push_back({key, {}, 0});
            confidenceTotals.push_back(0);
            confidenceCounts.push_back(0);
            index = lines.size() - 1;
        } else {
            index = static_cast<std::size_t>(std::distance(lines.begin(), existing));
        }
        auto& text = lines[index].text;
        const std::size_t required = text.size() + (text.empty() ? 0 : 1) + fields[11].size();
        if (required > MaximumCaptionTextBytes) {
            text.clear();
            confidenceCounts[index] = -1;
            continue;
        }
        if (confidenceCounts[index] < 0) continue;
        if (!text.empty()) text.push_back(' ');
        text.append(fields[11]);
        confidenceTotals[index] += confidence;
        confidenceCounts[index] += 1;
    }

    std::vector<ParsedCaptionLine> accepted;
    for (std::size_t index = 0; index < lines.size(); ++index) {
        if (lines[index].text.empty() || confidenceCounts[index] <= 0) continue;
        lines[index].confidence = confidenceTotals[index] / confidenceCounts[index];
        accepted.push_back(std::move(lines[index]));
    }
    return accepted;
}

} // namespace techmap::captions
