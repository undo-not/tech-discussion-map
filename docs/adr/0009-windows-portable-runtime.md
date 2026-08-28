# ADR-0009: Windows x64ポータブルruntimeをCIで組み立てる

## Status

Accepted

## Context

実Teams字幕を利用できる別PCでMVPを試すには、従来のsource build手順ではNode.js、pnpm、GitHub CLI、Visual Studio/CMakeと個別OCR導入が必要だった。これは試験導入の障壁が高く、各PCのtoolchain差も持ち込む。一方でrepositoryはpublicであり、会議data、資格情報、local sessionを配布資源へ混入させてはならない。

## Decision

Windows GitHub-hosted runnerでsourceからnative helper、ポータブルbuild時だけ有効化するVinext standalone server、固定Tesseractをbuildし、hash固定したNode.js公式Windows x64 ZIPから必要runtimeとlicenseだけを取り出す。通常buildは既存のSites/Worker出力を維持する。新規staging directoryへ明示allowlistでコピーし、全fileのsize/SHA-256 manifestとprivacy filename/content scanを作成して、単一ZIPを一時artifactとして提供する。

起動時はmanifest全件、Node version、OCR build manifestを検証する。OCRが未導入の場合だけLocalAppDataへoffline copyし、既存directoryは自動置換しない。serverとcompanionは既存launcherを再利用し、standalone serverを`127.0.0.1`へbindする。main artifactのprovenance attestationは、unprivileged build jobと分離したjobで付与する。

Whisper modelは大容量の任意fallbackであるため同梱しない。API key、会議data、保存sessionも含めず、各PCのWindows保護領域で別管理する。

## Consequences

利用者はZIP展開と起動だけでOCR-first MVPを試せる。CI時間とartifact容量は増える。Windows x64以外は対象外で、SmartScreen向けcode signingと永続Release配布は別判断になる。manifestは偶発的な欠損・改変を検出するが、manifestを含む配布元の真正性にはGitHub attestation検証が必要である。
