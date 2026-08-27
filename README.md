# TechMap Live

TechMap Liveは、技術ディスカッションをリアルタイムに文字起こし・分析し、論点、決定、未解決質問、リスク、アクションを根拠発話付きのマインドマップへ整理する会議ワークスペースです。Microsoft Teams会議での利用を想定しています。

## Product boundary

初期MVPは、利用者の明示操作によるマイク入力とローカルのデモ会話を扱います。Teams、Microsoft Graph、外部AI model、永続保存は交換可能なadapterとして分離し、対応するIssueの許可と受入条件が整うまで接続しません。生音声は既定で保存しません。

## Repository layout

- `app/`: Sites/VinextによるWebアプリ
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
