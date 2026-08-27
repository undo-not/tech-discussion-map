# ADR-0003: PCMをローカルwhisper.cpp workerで逐次文字起こしする

- Status: Accepted
- Source: Issue #2
- Reassessment: Issue #17 / ADR-0007がAcceptedになった場合、本方式は字幕を利用できないときの明示的fallbackになる。

## Context

MVPは利用者のマイクとTeams process loopbackのPCMを逐次文字起こしする。生音声を外部serviceへ送信せず、録音fileや一時WAVも作らない。公開UIから実音声を扱わず、model downloadを会議runtimeから分離する必要がある。

## Decision

whisper.cpp v1.9.1をcommit `f049fff95a089aa9969deb009cdd4892b3e74916`へ固定し、Windows local process `techmap-transcriber.exe`として使用する。MVP modelはmultilingual `ggml-tiny.bin`とし、会議前の明示setupで`%LOCALAPPDATA%\TechMapLive\models`へ取得する。setupはSHA-256 `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21`を検証してから配置する。

browser microphoneはAudioWorkletで16 kHz mono PCMへ変換する。Issue #10の48 kHz stereo Teams PCMは同じ16 kHz mono transcription portへdownmix／resampleする。音声はbounded binary frameとしてmemory／pipeだけを通過し、workerはtyped partial／final utterance frameだけをstdoutへ返す。

browserとnative workerのbridgeはNode companionとする。`127.0.0.1:43117`だけへbindし、許可したloopback UI Origin、短寿命のmemory-only bearer token、固定content type、payload上限を検証する。public URLではmicrophone操作を無効化し、synthetic adapterだけを許可する。Web Speech API、cloud STT、WebSocket、LAN listener、audio persistenceは採用しない。

確定文字起こしは利用者がUIでopt-inした場合だけbrowser profileのIndexedDBへ保存できる。保存先、保持、全削除を同じUIで示す。これはGit working tree外であり、生音声は含まない。Issue #6がより厳密なsession lifecycle、redaction、exportを追加する。

## Consequences

- Node、browser AudioWorklet、Windows native workerの3境界を自動テストする。
- HTTP chunkingは200 ms PCM単位、順序化したPOST、200 ms long pollでMVPの低遅延要件を満たす。負荷評価はIssue #7で行う。
- tiny modelの日本語精度は最終品質ではない。model変更はdownload size、hash、latency、品質の再評価を必要とする。
- Issue #6完了前の確認はsynthetic audioと利用者自身の単独マイクだけに限定する。

## Official references

- [whisper.cpp v1.9.1](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.1)
- [whisper.cpp real-time microphone example](https://github.com/ggml-org/whisper.cpp/tree/master/examples/stream)
