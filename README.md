# TechMap Live

TechMap Liveは、技術ディスカッションをリアルタイムに文字起こし・分析し、論点、決定、未解決質問、リスク、アクションを根拠発話付きのマインドマップへ整理する会議ワークスペースです。Microsoft Teams会議での利用を想定しています。

## Product boundary

本番runtimeはWindowsローカルcompanionとして動作し、利用者の明示操作によるマイク入力とTeams processに限定したapplication loopbackを交換可能なadapterで扱います。Microsoft Graphは会議後の照合候補です。Teams media botはlocal-only境界に反するため採用せず、meeting side panelはhosting境界を変更する場合の将来UI候補に限ります。ChatGPT Sitesは合成データのUI review専用です。生音声は保存せず、文字起こしと分析結果はGit working tree外へローカル保存できます。OpenAI API送信はIssue #3と#6のredaction、保持、`store: false`境界に従います。詳細は[ADR-0002](docs/adr/0002-local-windows-teams-audio-boundary.md)を参照してください。

## Repository layout

- `app/`: 共通UI層と、Sites/Vinextによる合成データreview surface
- `docs/specs/`: 現在のproduct behavior
- `docs/policies/`: Issue、PR、データ、agent協働の運用規約
- `docs/adr/`: 永続的な技術判断
- `.github/`: Issue、PR、CI設定

## Local development

Node.js 22.13以降とpnpmを使用します。

```powershell
cd app
pnpm install
pnpm run dev
```

検証コマンドは[AGENTS.md](AGENTS.md)を参照してください。
