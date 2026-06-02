# 🏢 DStyle DX フォーム管理システム（汎用運用マニュアル）

このリポジトリは、Azure Static Web Apps と Azure Cosmos DB を活用した、部署内の各種アンケートや入力フォームを一元管理・量量するための基盤システムです。
バックエンド（API）が汎用設計になっているため、**データベースやサーバーの設定を変更することなく、HTMLファイルを追加するだけで新しいフォームを無限に量産できます。**

---

## 📂 フォルダ構成

```text
dstyle-survey/
 ├── .github/workflows/   # Azureへの自動デプロイ設定（触らない）
 ├── api/                 # 汎用API（送信・読込）プログラム（触らない）
 ├── index.html           # 門外不出の「管理ポータル画面」（玄関口）
 ├── test.html            # サーバーの健康診断・通信テスト用画面
 ├── survey-herbelle.html # 【事例】Herbelle 体験後アンケート（お客様用）
 └── admin-herbelle.html  # 【事例】Herbelle 回答確認画面（スタッフ用）
🚀 新しいフォームを量産する手順（3ステップ）
新しい店舗や別のアンケートを作成したくなった場合は、以下の手順を踏むだけで数分で本番公開できます。

【ステップ 1】入力フォーム用のHTMLを作成する
１．既存の survey-herbelle.html をコピーして、新しいファイル（例: survey-projectB.html）を作成します。

２．HTML内のJavaScript部分（下部の <script> タグ内）にある、payload の中身を新しい案件用に書き換えます。

JavaScript
// ⚠️ ここを書き換えるだけでデータベース内で自動的に仕分けされます
const payload = {
    tenant: "project-b",       // 👈 新しいプロジェクト名や店舗名（英小文字・ハイフン推奨）
    type: "customer_voice",    // 👈 フォームの種類（例: survey, contact, entry など）
    data: inputData            // 👈 画面から集めた入力データ
};
【ステップ 2】管理画面用のHTMLを作成する
１．既存の admin-herbelle.html をコピーして、新しいファイル（例: admin-projectB.html）を作成します。

２．必要に応じて、最下部スクリプト内の SECRET_PW（パスワード） を上書きします。

３．データを読み出すための APIのURL（パラメータ） を、ステップ1で決めた文字列と完全に一致させます。

JavaScript
// ⚠️ tenant と type をステップ1と全く同じにすることで、そのデータだけを狙って取得します
const response = await fetch('/api/log?tenant=project-b&type=customer_voice');

４．テーブルの項目名（<th> や <td> の中身）を、新しいフォームの項目に合わせて調整します。

【ステップ 3】ポータル（index.html）にリンクを追記してPushする
１．index.html を開き、新しいプロジェクトのブロックを追加して、作成した2つのHTMLへのリンクボタンを設置します。

２．変更が完了したら、ターミナルで以下のコマンドを実行してGitHubへ送信します。

Bash
git add .
git commit -m "feat: 新しいフォーム(ProjectB)を追加"
git push origin main

３．数分後、自動的にデプロイが完了し、https://form.dstylegroup.jp/index.html から新しい画面へアクセスできるようになります。

🔐 運用上のセキュリティ・権限ルール
安全にシステムを維持するため、部署内で以下の管理ルールを徹底してください。
　・Azure管理画面へのアクセス制限
　　・Azureポータル（環境変数やCosmos DBの生データ）を操作する権限は、システム管理者（市川など）のみに限定します。
　　・一般のメンバーは、作成された admin-xxxx.html からパスワード認証を経てデータを確認するため、Azureの裏側に入れる権限を持たせる必要はありません。

・GitHubリポジトリの権限
　・コードを直接編集して本番環境に反映（Push）できるメンバーは、誤操作防止のため最小限に留めてください。

・環境変数の厳守
　・Cosmos DBへの接続文字列などの重要機密は、Azure側の環境変数で安全に隠蔽されています。絶対にHTMLコード内に生のパスワードや接続文字列を直接書き込まないでください。

🩺 困ったときは（健康診断機能）
・もし「アンケートが送信できない」「管理画面にデータが来ない」といった不具合が起きた場合は、トップページの最下部にある test.html（接続テスト用）を開いて送信テストを行ってください。
・test.html が成功する場合：Azureの裏側は正常です。新しく作ったHTMLの記述（大文字小文字のミスやJavaScriptのバグ）が原因です。
・test.html も失敗する場合：AzureのサーバーやCosmos DBの接続（環境変数など）に問題が発生している可能性があります。