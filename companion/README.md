# Local transcription companion

This Node.js host is the only browser-to-native bridge used by the MVP. It binds to `127.0.0.1:43117`, accepts requests only from the local UI origins, issues short-lived in-memory bearer tokens, and streams bounded PCM frames to `techmap-transcriber.exe`. It does not persist or log audio.

Build the native worker and install the model before a meeting, then run:

```powershell
node companion/local-transcription-host.mjs
```

The browser UI remains a separate Vinext process bound to loopback. Model setup is described in `native/transcription/README.md`.
