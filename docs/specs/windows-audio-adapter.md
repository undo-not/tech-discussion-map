# Windows Teams audio adapter

## Outcome

The Windows helper captures only the audio rendered by a user-confirmed `ms-teams.exe` process tree. It never records a WAV file and never widens capture to system-wide loopback. PCM frames remain in memory and cross the native boundary only through the helper process standard-output pipe.

This adapter supplies the remote-participant group stream. The selected microphone and local transcription pipeline are implemented by Issue #2.

## Startup contract

The local host must complete all of the following before it starts the helper:

1. Show the participant-consent confirmation owned by Issue #6.
2. Run `techmap-audio probe --activate` and display the detected Windows build, Teams process count, selected PID, and activation result.
3. Let the user confirm the selected Teams process.
4. Start `techmap-audio capture --pid <pid> --consent-confirmed` from an explicit user action.

The helper rejects Windows builds below 20348, a missing or non-Teams PID, and a missing `--consent-confirmed` flag. Capture never falls back to an endpoint-wide loopback source.

`probe --activate` activates the process-loopback audio interface but does not start it or read audio frames. Its JSON report is local diagnostic state and must not be committed to GitHub.

## Binary IPC protocol

Every stdout message in capture mode is one binary frame. The 12-byte little-endian header is:

| Offset | Size | Meaning |
|---:|---:|---|
| 0 | 4 | ASCII magic `TMA1` |
| 4 | 1 | protocol version, currently `1` |
| 5 | 1 | frame type |
| 6 | 2 | reserved, zero |
| 8 | 4 | payload byte length |

Frame types are:

- `1`: UTF-8 JSON state, `{ "state": CaptureState, "reason": string }`.
- `2`: raw PCM bytes matching the most recent format frame.
- `3`: UTF-8 JSON format metadata. MVP output is 48 kHz, stereo, signed 16-bit little-endian PCM.

The TypeScript consumer rejects an invalid magic value, unsupported version, unknown type, invalid state schema, or payload larger than 1 MiB. A protocol failure closes the adapter rather than attempting to reinterpret bytes.

## State behavior

- `active`: the process-scoped stream has been established.
- `remote-audio-undetected`: the stream remains established but no non-zero sample has been observed for 15 seconds. A later non-zero frame clears this warning.
- `degraded-microphone-only`: the selected Teams process exited or the active audio stream/device failed. Signal alone cannot recover this state.
- `stopped`: capture did not start, was explicitly stopped, or has been reset before a user-requested reconnect.

After a degraded transition, the host must stop the old helper and require the user to reconnect. Only a newly successful helper start associated with that explicit reconnect may return the workspace to `active`.

## Privacy boundary

- The native code has no audio file, temporary file, or diagnostic audio path.
- Capture frames are written only to the inherited stdout pipe. The local host must not redirect that pipe to a file or log it.
- State reasons are fixed non-sensitive identifiers. Audio bytes and transcript text never appear on stderr.
- The helper verifies that the requested executable is `ms-teams.exe`; it does not accept an arbitrary process name or an exclude-tree mode.
- Actual meeting validation remains prohibited until Issue #6 is complete and every participant has consented.

## Build and capability check

Build with Visual Studio Build Tools and a current Windows SDK:

```powershell
cmake -S native/windows-audio -B native/windows-audio/build -A x64
cmake --build native/windows-audio/build --config Release
ctest --test-dir native/windows-audio/build -C Release --output-on-failure
```

Then run the non-capturing capability check:

```powershell
native/windows-audio/build/Release/techmap-audio.exe probe --activate
```

Do not run the `capture` command against a real meeting until the consent and privacy gate in Issue #6 is available.
