#include "protocol.h"
#include "whisper.h"

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace {

constexpr int SampleRate = 16'000;
constexpr int PartialIntervalSamples = SampleRate * 2;
constexpr int MinimumSpeechSamples = SampleRate;
constexpr int FinalSilenceSamples = SampleRate * 8 / 10;
constexpr int MaximumUtteranceSamples = SampleRate * 15;
constexpr float SpeechThreshold = 0.008F;

struct Options final {
    std::string model;
    std::string source;
    std::string language;
};

bool ReadExact(void* destination, std::size_t size) {
    auto* cursor = static_cast<std::uint8_t*>(destination);
    while (size > 0) {
        const std::size_t read = std::fread(cursor, 1, size, stdin);
        if (read == 0) return false;
        cursor += read;
        size -= read;
    }
    return true;
}

bool WriteExact(const void* source, std::size_t size) {
    const auto* cursor = static_cast<const std::uint8_t*>(source);
    while (size > 0) {
        const std::size_t written = std::fwrite(cursor, 1, size, stdout);
        if (written == 0) return false;
        cursor += written;
        size -= written;
    }
    return std::fflush(stdout) == 0;
}

std::string EscapeJson(std::string_view value) {
    std::string escaped;
    escaped.reserve(value.size());
    for (const unsigned char character : value) {
        switch (character) {
            case '\\': escaped += "\\\\"; break;
            case '"': escaped += "\\\""; break;
            case '\b': escaped += "\\b"; break;
            case '\f': escaped += "\\f"; break;
            case '\n': escaped += "\\n"; break;
            case '\r': escaped += "\\r"; break;
            case '\t': escaped += "\\t"; break;
            default:
                if (character >= 0x20) escaped += static_cast<char>(character);
                break;
        }
    }
    return escaped;
}

std::string Trim(std::string value) {
    const auto notSpace = [](unsigned char value) { return std::isspace(value) == 0; };
    value.erase(value.begin(), std::find_if(value.begin(), value.end(), notSpace));
    value.erase(std::find_if(value.rbegin(), value.rend(), notSpace).base(), value.end());
    return value;
}

bool EmitUtterance(
    std::string_view id,
    int revision,
    std::string_view phase,
    std::string_view source,
    std::int64_t startMs,
    std::int64_t endMs,
    std::string_view text) {
    const std::string speaker = source == "local" ? "self" : "remote-group";
    std::string json = "{\"id\":\"" + EscapeJson(id) + "\",\"revision\":" + std::to_string(revision) +
        ",\"phase\":\"" + std::string(phase) + "\",\"source\":\"" + std::string(source) +
        "\",\"speaker\":\"" + speaker + "\",\"startMs\":" + std::to_string(startMs) +
        ",\"endMs\":" + std::to_string(endMs) + ",\"text\":\"" + EscapeJson(text) + "\"}";
    if (json.size() > techmap::transcription::MaximumOutputBytes) return false;
    const auto header = techmap::transcription::EncodeHeader("TMO1", static_cast<std::uint8_t>(techmap::transcription::OutputType::Utterance), static_cast<std::uint32_t>(json.size()));
    return WriteExact(header.data(), header.size()) && WriteExact(json.data(), json.size());
}

Options ParseOptions(int argc, char** argv) {
    Options options;
    for (int index = 1; index + 1 < argc; index += 2) {
        const std::string_view name(argv[index]);
        const std::string value(argv[index + 1]);
        if (name == "--model") options.model = value;
        else if (name == "--source") options.source = value;
        else if (name == "--language") options.language = value;
        else return {};
    }
    if (options.model.empty() || (options.source != "local" && options.source != "remote") || options.language.empty()) return {};
    return options;
}

std::string Transcribe(whisper_context* context, const std::vector<float>& samples, const Options& options) {
    whisper_full_params parameters = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    parameters.n_threads = static_cast<int>(std::max(1U, std::min(8U, std::thread::hardware_concurrency())));
    parameters.language = options.language.c_str();
    parameters.translate = false;
    parameters.no_context = true;
    parameters.no_timestamps = true;
    parameters.single_segment = false;
    parameters.print_progress = false;
    parameters.print_special = false;
    parameters.print_realtime = false;
    parameters.print_timestamps = false;
    parameters.suppress_blank = true;
    if (whisper_full(context, parameters, samples.data(), static_cast<int>(samples.size())) != 0) return {};
    std::string text;
    const int segments = whisper_full_n_segments(context);
    for (int index = 0; index < segments; ++index) text += whisper_full_get_segment_text(context, index);
    return Trim(text);
}

} // namespace

int main(int argc, char** argv) {
#ifdef _WIN32
    if (_setmode(_fileno(stdin), _O_BINARY) == -1 || _setmode(_fileno(stdout), _O_BINARY) == -1) return 2;
#endif
    const Options options = ParseOptions(argc, argv);
    if (options.model.empty()) return 2;

    whisper_context_params contextParameters = whisper_context_default_params();
    contextParameters.use_gpu = true;
    whisper_context* context = whisper_init_from_file_with_params(options.model.c_str(), contextParameters);
    if (context == nullptr) return 3;

    std::vector<float> utterance;
    utterance.reserve(MaximumUtteranceSamples);
    std::int64_t streamSamples = 0;
    std::int64_t utteranceStartSample = 0;
    int silenceSamples = 0;
    int samplesAtLastPartial = 0;
    int utteranceNumber = 1;
    int revision = 0;
    bool hasSpeech = false;
    std::string lastPartial;

    const auto finishUtterance = [&]() {
        if (!hasSpeech || static_cast<int>(utterance.size()) < MinimumSpeechSamples) {
            utterance.clear();
        } else {
            const std::string text = Transcribe(context, utterance, options);
            if (!text.empty()) {
                char id[48]{};
                std::snprintf(id, sizeof(id), "%s-%06d", options.source.c_str(), utteranceNumber);
                if (!EmitUtterance(id, revision + 1, "final", options.source, utteranceStartSample * 1000 / SampleRate, streamSamples * 1000 / SampleRate, text)) return false;
                utteranceNumber += 1;
            }
            utterance.clear();
        }
        utteranceStartSample = streamSamples;
        silenceSamples = 0;
        samplesAtLastPartial = 0;
        revision = 0;
        hasSpeech = false;
        lastPartial.clear();
        return true;
    };

    while (true) {
        std::array<std::uint8_t, techmap::transcription::HeaderSize> headerBytes{};
        if (!ReadExact(headerBytes.data(), headerBytes.size())) break;
        techmap::transcription::Header header{};
        if (!techmap::transcription::DecodeHeader(headerBytes, "TMI1", techmap::transcription::MaximumAudioBytes, header)) {
            whisper_free(context);
            return 4;
        }
        if (header.type == static_cast<std::uint8_t>(techmap::transcription::InputType::Flush)) {
            if (header.payloadSize != 0 || !finishUtterance()) { whisper_free(context); return 5; }
            break;
        }
        if (header.type != static_cast<std::uint8_t>(techmap::transcription::InputType::Audio) || header.payloadSize == 0 || header.payloadSize % 2 != 0) {
            whisper_free(context);
            return 4;
        }
        std::vector<std::int16_t> pcm(header.payloadSize / 2);
        if (!ReadExact(pcm.data(), header.payloadSize)) { whisper_free(context); return 4; }
        if (utterance.empty()) utteranceStartSample = streamSamples;
        const float energy = techmap::transcription::RootMeanSquare(pcm.data(), pcm.size());
        hasSpeech = hasSpeech || energy >= SpeechThreshold;
        silenceSamples = energy >= SpeechThreshold ? 0 : silenceSamples + static_cast<int>(pcm.size());
        for (const std::int16_t sample : pcm) utterance.push_back(static_cast<float>(sample) / 32768.0F);
        streamSamples += static_cast<std::int64_t>(pcm.size());

        if (hasSpeech && static_cast<int>(utterance.size()) >= MinimumSpeechSamples &&
            static_cast<int>(utterance.size()) - samplesAtLastPartial >= PartialIntervalSamples) {
            const std::string text = Transcribe(context, utterance, options);
            samplesAtLastPartial = static_cast<int>(utterance.size());
            if (!text.empty() && text != lastPartial) {
                char id[48]{};
                std::snprintf(id, sizeof(id), "%s-%06d", options.source.c_str(), utteranceNumber);
                revision += 1;
                if (!EmitUtterance(id, revision, "partial", options.source, utteranceStartSample * 1000 / SampleRate, streamSamples * 1000 / SampleRate, text)) {
                    whisper_free(context);
                    return 5;
                }
                lastPartial = text;
            }
        }
        if ((hasSpeech && silenceSamples >= FinalSilenceSamples) || static_cast<int>(utterance.size()) >= MaximumUtteranceSamples) {
            if (!finishUtterance()) { whisper_free(context); return 5; }
        } else if (!hasSpeech && silenceSamples >= FinalSilenceSamples) {
            utterance.clear();
            utteranceStartSample = streamSamples;
            silenceSamples = 0;
        }
    }

    whisper_free(context);
    return 0;
}
