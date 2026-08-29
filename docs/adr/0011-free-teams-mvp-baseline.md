# ADR-0011: 無料MVPの成立判定をTeams字幕OCRへ戻す

- Status: Accepted
- Source: Issue #40
- Amends: ADR-0007, ADR-0010

## Context

ADR-0010はZoom RTMSを第一入力候補としたが、Zoom RTMS credential、Developer Pack credit、meeting host側設定を要求する。そのため「無償accountの利用者またはguestが別PCへportable packageを導入し、会議中の議論整理を試す」というMVP成立条件を満たすとは限らない。

Microsoft Teams Freeは通常live captionsを提供する。TechMap LiveはTeams公開APIやtranscription保存へ依存せず、利用者自身に表示された字幕の明示選択矩形だけをlocal OCRできる。ただしTeams UIに依存するため、code completionだけで成立を宣言できない。

## Decision

無料MVPの成立判定では、サインイン済みTeams desktopの通常日本語captionを第一入力とする。Zoom RTMS adapterは削除せず、有償・管理済み環境向けoptional integrationとする。

起動前にcontent-free probeを行うが、`candidate-found`はOCR成功の証明ではない。会議ごとのsupport checklistと全参加者同意を別に確認し、両方が揃わなければcaption captureを開始しない。外部account、Entra guest、anonymous/browser参加は実会議acceptanceが終わるまでsupport対象に含めない。

実Teams captionの話者名と本文が現在のstrict parser contractで安全に取得できない場合はMVP不成立と判定する。raw identityが混入し得る複数行heuristicを追加して成立扱いにしてはならない。

## Consequences

- 無料ライセンスで成立し得る最小経路が明確になる。
- Zoom RTMSのcredentialとcreditは無料MVPの必須条件から外れる。
- 実会議acceptanceが未完了の間、製品は「実装済み・成立未確認」と表示する。
- Teams UI変更はsupported baselineを壊し得るため、portable releaseごとに実会議acceptanceを再実行する。
