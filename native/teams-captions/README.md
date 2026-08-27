# Teams caption UI Automation probe

Issue #17のWindows専用read-only capability probeです。Teamsのvisible top-level windowからUI Automation rootを取得できるか確認しますが、`probe`はsubtreeを走査せず、要素名、表示文字、window title、PIDを読み出し・表示しません。UIA callはstdoutを持たない使い捨てworker processで実行され、providerが応答しなくても親processが5秒で終了させます。

```powershell
cmake -S native/teams-captions -B native/teams-captions/build -A x64
cmake --build native/teams-captions/build --config Release
ctest --test-dir native/teams-captions/build -C Release --output-on-failure
native/teams-captions/build/Release/techmap-captions.exe probe
```

本人だけの合成テスト会議で字幕行にマウスポインタを置き、参加者同意を確認した場合に限って次を実行できます。

```powershell
native/teams-captions/build/Release/techmap-captions.exe probe-at-cursor --consent-confirmed
```

このコマンドは選択位置が`ms-teams.exe`のUI要素であることを検証し、文字列の有無と上限内かどうかだけを返します。文字列そのもの、正確な長さ、hash、PID、window titleは出力せず、取得したBSTRを解放前に消去します。画面画像は取得しません。実会議での実行結果やローカル診断JSONをGitHubへ記録しないでください。

このprobeはTeams UIの正式なAPI互換性を保証しません。字幕の文字イベント取得は、実機で対象要素の安定性を確認してから別コミットで有効化します。
