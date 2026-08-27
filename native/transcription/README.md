# Local whisper.cpp transcription worker

`techmap-transcriber` consumes 16 kHz mono signed 16-bit PCM through stdin and emits typed partial/final utterance frames through stdout. Audio remains in process memory; this component has no recording, temporary WAV, telemetry, or network code.

The build pins whisper.cpp v1.9.1 to commit `f049fff95a089aa9969deb009cdd4892b3e74916`.

## Build on Windows

```powershell
cmake -S native/transcription -B native/transcription/build -A x64
cmake --build native/transcription/build --config Release
ctest --test-dir native/transcription/build -C Release --output-on-failure
```

## Install the model before a meeting

Run `scripts/setup-whisper-model.ps1`. It downloads the multilingual `ggml-tiny.bin` model to `%LOCALAPPDATA%\TechMapLive\models`, verifies SHA-256 `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21`, and atomically moves it into place. The meeting runtime never downloads a model.

The tiny model is selected for the MVP's latency and installation size. Accuracy and latency are evaluated under Issue #7 before changing the pinned model.
