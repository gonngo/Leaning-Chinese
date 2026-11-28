# PCを使わない教材取り込み

GitHub Actions の `Sync HSK5 materials` が、日本時間の毎朝6:15頃に共有チャットを確認します。PC・スマホが起動していなくてもGitHubのクラウドで実行されます。

- 共有元: https://chatgpt.com/share/6b03eff6-6970-83ec-851b-4e539558a317
- 実行履歴・手動実行: https://github.com/gonngo/Leaning-Chinese/actions/workflows/sync-hsk5.yml
- 公開アプリ: https://gonngo.github.io/Leaning-Chinese/

新しい日付の例文だけを取り込みます。単語は全履歴との重複を除き、ピンイン・日本語訳・元の読解文からの例文を保存します。既存の教材は保持します。共有画面に新出語の例文がない場合や、表示形式が変わって安全に解析できない場合は更新せずエラーにします。別の教材を生成して補いません。

定期取り込みの対象は共有リンクに掲載されている教材です。個人アカウントの共有リンクには、その後のメッセージが自動では追加されません。元チャットで教材が完成したら「共有」→「リンクを更新」を選ぶと、次回の定期実行で取り込まれます。すぐに取り込む場合は、リンクの更新後に GitHub の実行履歴から `Run workflow` を選びます。[OpenAI の共有リンク案内](https://help.openai.com/ja-jp/articles/7925741-sharing-conversations-and-scheduled-tasks-in-chatgpt)

取得処理と公開処理を分け、ブラウザーで教材を読む処理にはリポジトリの書き込み権限を付けません。パスワードやChatGPT APIキーは使用しません。取得・検証に失敗しても公開済みデータは保持されます。処理結果はGitHubの実行履歴に表示されます。

公開設定は Settings → Pages → Source: GitHub Actions を使います。スマホではアプリの「最新教材を確認」またはページの再読み込みで公開済みの追加分を取得できます。

GitHubの定期実行は開始が遅れることがあります。公開リポジトリで長期間活動がないと、GitHub側で定期実行が無効化される場合があります。その場合は実行履歴から再有効化してください。
