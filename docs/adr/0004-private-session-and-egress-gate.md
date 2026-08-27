# ADR-0004: 会議dataはDPAPI session storeと単一redaction gateで保護する

- Status: Accepted
- Source: Issue #6

## Context

repositoryと合成Sites reviewはpublicにできる一方、実会話、文字起こし、分析、参加者情報、credentialは公開できない。生音声はmemory-onlyで、textだけが利用者の許可後にOpenAI Responses APIへ送信できる。`store: false`はOpenAI側のすべての保持を保証せず、既定のabuse monitoring retentionとproject data controlsを利用者へ説明する必要がある。

## Decision

実入力開始にはversion付きの全参加者同意recordを要求し、同意解除時はpendingを含むcaptureを停止して現在sessionを削除する。capture、OpenAI request、local persistenceの実状態を常時indicatorに表示する。

local sessionは`%LOCALAPPDATA%\TechMapLive\sessions`に限定する。Windows native privacy helperがdirectory作成時からcurrent userのACEだけを持つprotected DACLを設定し、session JSONをDPAPI CurrentUser scopeで暗号化する。ACLまたはDPAPIを検証できない場合はplaintextへ縮退せずmemory-onlyにする。API keyはWindows Credential Managerの`TechMapLive/OpenAIApiKey`へ非表示入力で保存し、browser、command line、environment、repository、logへ渡さない。

OpenAIへ渡せる値はdeterministic redactionを通ったbranded `RedactedText`だけとする。request factoryは`https://api.openai.com/v1/responses`、`store: false`、必要最小限のtext inputだけを許可する。background、conversation、previous response、file、tool、automatic retryを許可しない。Issue #3はこのcontractの外側へ別のrequest construction pathを作らない。

利用者は外部分析を許可する前に対象API projectのdata controlsと保持条件を確認する。本アプリはZDR／MAM設定を自動検証した、または保持がないと断定しない。`store: false`でも既定ではabuse monitoring logが最大30日保持され得ることを表示する。

## Consequences

- 未保存sessionはdiskへ書かず、終了後はmemoryだけに残り、削除または明示exportできる。
- 保存sessionは1／7／30／90日の期限を持ち、起動時sweepと即時全体削除を行う。
- exportだけは利用者がOS pickerで選択したlocal pathへplaintext JSONを作成でき、別copyとして削除責任を説明する。
- current-user DACLとDPAPIは別Windows userからの通常accessを遮断するが、管理者によるtake ownership、backup、pagefile、既に作られたexportのsecure erasureを保証しない。
- Sitesではreal captureが無効で、synthetic dataだけを扱う。

## Official OpenAI references

- [Data controls in the OpenAI platform](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint)
- [Create a model response](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
