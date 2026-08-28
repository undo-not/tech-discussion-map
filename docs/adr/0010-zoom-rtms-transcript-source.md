# ADR-0010: Zoom RTMS transcriptを第一級入力sourceとして追加する

- Status: Accepted
- Date: 2026-08-28
- Issue: #31

## Context

Teams字幕OCRはWindows local-only境界を保てる一方、画面layout、DPI、字幕表示状態に依存する。Zoom RTMSは発話者情報付きtranscriptを会議中にprotocolとして配信でき、OCRを経由しない入力候補になる。ただしsigned webhookには公開HTTPS endpointが必要で、Zoom credentialとraw identityを新たに扱う。

## Decision

Zoom RTMSのtranscript media type 8だけを追加し、Teams経路はfallbackとして残す。利用者の明示armを15分・one-shotで行い、Zoom started eventを任意会議へ自動bindしない。

公開tunnelの転送先は1 routeだけを持つ`127.0.0.1:43118`の専用Webhook listenerとする。Host／Origin／bearerで守られたbrowser companion `127.0.0.1:43117`とはprocess内でcontrollerを共有してもHTTP surfaceを共有しない。

CredentialはWindows Credential Managerに保存する。native helperは目的別に、client handshake signature、Webhook verify boolean、endpoint validation tokenの3操作だけを公開する。汎用HMAC commandは設けない。

Zoom packetのraw ID/nameはNode memoryを一時通過する点を残余riskとして明示し、同packetの処理中にsession-only aliasへ変換する。output exact-schema validationによりraw identifierをbrowser/event storeへ通さない。

## Consequences

- Zoom transcriptionの精度・話者情報をOCRなしで利用できる。
- Developer Pack、General App設定、会議権限、一時HTTPS tunnelが利用者側の前提となる。
- tunnelのlifetime中は専用Webhook portがInternetから到達可能だが、browser APIとdata APIは公開されない。
- Zoomのproduction RTMS hostname一覧は固定契約として公開されていない。現在のdot-suffix allowlistが実配信と一致しない場合は受入でfail closedし、公式evidenceを得てから仕様と実装を狭く更新する。
- Teams OCR、process audio、microphoneは削除せず、Zoomが使えない環境のfallbackとして維持する。
