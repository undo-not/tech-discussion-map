# TechMap Live

TechMap Liveは、技術ディスカッションをリアルタイムに文字起こし・分析し、論点、決定、未解決質問、リスク、アクションを根拠発話付きのマインドマップへ整理する会議ワークスペースです。Microsoft Teams会議での利用を想定しています。

## Product boundary

本番runtimeはWindowsローカルcompanionとして動作し、利用者の明示操作によるマイク入力とTeams processに限定したapplication loopbackを交換可能なadapterで扱います。Microsoft Graphは会議後の照合候補です。Teams media botはlocal-only境界に反するため採用せず、meeting side panelはhosting境界を変更する場合の将来UI候補に限ります。ChatGPT Sitesは合成データのUI review専用です。生音声は保存せず、文字起こしと分析結果はGit working tree外へローカル保存できます。OpenAI API送信はIssue #3と#6のredaction、保持、`store: false`境界に従います。詳細は[ADR-0002](docs/adr/0002-local-windows-teams-audio-boundary.md)を参照してください。

## Repository layout

- `app/`: 共通UI層と、Sites/Vinextによる合成データreview surface
- `native/windows-audio/`: Teams process treeだけを対象にするWindows音声helper
- `native/transcription/`: pinned whisper.cppを使うmemory-only文字起こしworker
- `native/privacy/`: current-user ACL、DPAPI、Windows Credential Managerを所有するprivacy helper
- `app/domain/analysis/`: versioned analysis state/delta、strict schema、prompt contract
- `app/adapters/analysis/`: deterministic mockとprivacy-gated OpenAI analyzer
- `companion/`: browserとnative helperを接続するloopback-only host
- `scripts/`: 会議外で実行する検証付きmodel setup
- `docs/specs/`: 現在のproduct behavior
- `docs/policies/`: Issue、PR、データ、agent協働の運用規約
- `docs/adr/`: 永続的な技術判断
- `.github/`: Issue、PR、CI設定

## Local development

Node.js 22.13以降とpnpmを使用します。

```powershell
cd app
pnpm install
pnpm run dev --hostname 127.0.0.1 --port 3000
```

検証コマンドは[AGENTS.md](AGENTS.md)を参照してください。

Windows音声helperのbuildと非capturing capability checkは[Windows Teams audio adapter](docs/specs/windows-audio-adapter.md)を参照してください。実会議captureはIssue #6の同意・privacy gateが完成するまで実行しません。

ローカル文字起こしは[local transcription specification](docs/specs/local-transcription.md)に従います。会議前に`powershell -ExecutionPolicy Bypass -File scripts/setup-whisper-model.ps1`でchecksum検証済みmodelを導入し、native workerをbuildしてから`node companion/local-transcription-host.mjs`を起動します。companionが表示する一度限りの`#techmap-launch=...`付きURLを同じWindows userのbrowserで開いてください。fragmentはHTTPへ送られず、UIがmemoryへ取り込んだ直後にaddress barから消去します。公開URLではマイク入力は無効で、合成デモだけが動作します。

会議dataの同意、暗号化保存、保持、削除、redaction、OpenAI保持条件は[privacy boundary](docs/specs/privacy-boundary.md)に従います。API keyは`powershell -ExecutionPolicy Bypass -File scripts/setup-openai-key.ps1`の非表示promptからWindows Credential Managerへ保存します。keyを`.env`、browser、command line、Issue、PR、logへ入れないでください。
