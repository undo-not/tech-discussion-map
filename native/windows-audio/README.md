# TechMap Windows audio helper

This Windows-only helper implements the process-scoped Teams render-audio boundary from [ADR-0002](../../docs/adr/0002-local-windows-teams-audio-boundary.md). See the normative [adapter specification](../../docs/specs/windows-audio-adapter.md) for startup, protocol, privacy, and build requirements.

The implementation is based on the `ActivateAudioInterfaceAsync` process-loopback pattern demonstrated by Microsoft's [Application Loopback sample](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback). It deliberately removes the sample's WAV output path.
