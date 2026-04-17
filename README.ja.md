<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/ollama-intern-mcp/readme.png" alt="Ollama Intern MCP" width="500">
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/ollama-intern-mcp/actions"><img alt="CI" src="https://github.com/mcp-tool-shop-org/ollama-intern-mcp/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://mcp-tool-shop-org.github.io/ollama-intern-mcp/"><img alt="Landing Page" src="https://img.shields.io/badge/landing-page-8b5cf6"></a>
  <a href="https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/"><img alt="Handbook" src="https://img.shields.io/badge/handbook-docs-10b981"></a>
</p>

**Claude Code のローカルインターン**。28種類のツール、証拠に基づいたレポート、永続的な成果物。

Claude Code に、ルール、レベル、デスク、そして書類整理棚を備えたローカルインターンを提供する MCP サーバー。Claude が _ツール_ を選択し、ツールが _レベル_ (Instant / Workhorse / Deep / Embed) を選択します。選択されたレベルは、来週開くことができるファイルを作成します。

クラウドは不要。テレメトリーも不要。そして、「自律型」の機能もありません。すべての処理は、その過程を明確に示します。

---

## 代表的な例：1つの呼び出し、1つの成果物

```jsonc
// Claude → ollama-intern-mcp
{
  "tool": "ollama_incident_pack",
  "arguments": {
    "title": "sprite pipeline 5 AM paging regression",
    "logs": "[2026-04-16 05:07] worker-3 OOM killed\n[2026-04-16 05:07] ollama /api/ps reports evicted=true size=8.1GB\n...",
    "source_paths": ["F:/AI/sprite-foundry/src/worker.ts", "memory/sprite-foundry-visual-mastery.md"]
  }
}
```

ディスク上のファイルへのパスを指すエンベロープを返します。

```jsonc
{
  "result": {
    "pack": "incident",
    "slug": "2026-04-16-sprite-pipeline-5-am-paging-regression",
    "artifact_md":   "~/.ollama-intern/artifacts/incident/2026-04-16-sprite-pipeline-5-am-paging-regression.md",
    "artifact_json": "~/.ollama-intern/artifacts/incident/2026-04-16-sprite-pipeline-5-am-paging-regression.json",
    "weak": false,
    "evidence_count": 6,
    "next_checks": ["residency.evicted across last 24h", "OLLAMA_MAX_LOADED_MODELS vs loaded size"]
  },
  "tier_used": "deep",
  "model": "qwen2.5:14b-instruct-q4_K_M",
  "hardware_profile": "dev-rtx5080",
  "tokens_in": 4180, "tokens_out": 612,
  "elapsed_ms": 8410,
  "residency": { "in_vram": true, "evicted": false }
}
```

その Markdown ファイルは、インターンのデスクからの出力です。見出し、引用元 ID が記載された証拠ブロック、調査のための `next_checks`、証拠が不十分な場合は `weak: true` というバナーが表示されます。これは決定論的です。レンダリングはコードによって行われ、プロンプトではありません。明日開いて、来週に差分を確認し、`ollama_artifact_export_to_path` を使用して、ハンドブックにエクスポートします。

このカテゴリの競合製品は、すべて「トークンを節約する」ことを強調しています。私たちは、_インターンが書いたファイル_ を提供することに重点を置いています。

---

## 構成：4つのレベル、28種類のツール

| レベル | 数 | ここに何があるか |
|---|---|---|
| **Atoms** | 15 | タスク指向の基本的な機能。`classify` (分類)、`extract` (抽出)、`triage_logs` (ログのトリアージ)、`summarize_fast` / `deep` (高速/詳細な要約)、`draft` (草稿作成)、`research` (調査)、`corpus_search` (コーパス検索) / `answer` (回答)、`index` (インデックス作成)、`refresh` (更新)、`list` (リスト表示)、`embed_search` (埋め込み検索)、`embed` (埋め込み)、`chat` (チャット)。バッチ処理に対応した機能 (`classify`、`extract`、`triage_logs`) は、`items: [{id, text}]` の形式で入力を受け付けます。 |
| **Briefs** | 3 | 証拠に基づいた構造化されたレポート。`incident_brief` (インシデントレポート)、`repo_brief` (リポジトリレポート)、`change_brief` (変更レポート)。すべての主張には、証拠 ID が記載されており、不明な点はサーバー側で削除されます。証拠が不十分な場合は、偽の記述ではなく、`weak: true` というフラグが表示されます。 |
| **Packs** | 3 | 固定されたパイプラインを持つ複合タスクで、永続的な Markdown と JSON ファイルを `~/.ollama-intern/artifacts/` に書き込みます。`incident_pack` (インシデントパック)、`repo_pack` (リポジトリパック)、`change_pack` (変更パック)。決定論的なレンダリングエンジンを使用しており、成果物の形状に対してモデルの呼び出しはありません。 |
| **Artifacts** | 7 | パック出力に対する一貫性のあるインターフェース。`artifact_list` (成果物リスト)、`read` (読み込み)、`diff` (差分表示)、`export_to_path` (パスへのエクスポート)、さらに、3つの決定論的なスニペット：`incident_note` (インシデントメモ)、`onboarding_section` (オンボーディングセクション)、`release_note` (リリースノート)。 |

合計：**18種類の基本的な機能 + 3種類のパック + 7種類の成果物ツール = 28種類**。

固定された項目：
- 基本的な機能は 18 個 (基本的な機能 + レポート)。新しい基本的な機能は追加されません。
- パックの種類は 3 種類。新しいパックの種類は追加されません。
- 成果物のレベルは 7 種類。

ツールの詳細な参照は、[ハンドブック](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/reference/) に記載されています。

---

## インストール

```bash
npm install -g ollama-intern-mcp
```

ローカルに [Ollama](https://ollama.com) がインストールされており、各レベルのモデルがダウンロードされている必要があります。

### Claude Code

```json
{
  "mcpServers": {
    "ollama-intern": {
      "command": "npx",
      "args": ["-y", "ollama-intern-mcp"],
      "env": {
        "OLLAMA_HOST": "http://127.0.0.1:11434",
        "INTERN_PROFILE": "dev-rtx5080"
      }
    }
  }
}
```

### Claude Desktop

同じ内容で、`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) または `%APPDATA%\Claude\claude_desktop_config.json` (Windows) に書き込まれます。

### モデルのダウンロード

**デフォルトの開発環境 (RTX 5080 16GB 相当):**

```bash
ollama pull qwen2.5:7b-instruct-q4_K_M
ollama pull qwen2.5-coder:7b-instruct-q4_K_M
ollama pull qwen2.5:14b-instruct-q4_K_M
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=4
export OLLAMA_KEEP_ALIVE=-1
```

**M5 Max 環境 (128GB 統合メモリ):**

```bash
ollama pull qwen2.5:14b-instruct-q4_K_M
ollama pull qwen2.5-coder:32b-instruct-q4_K_M
ollama pull llama3.3:70b-instruct-q4_K_M
ollama pull nomic-embed-text
export INTERN_PROFILE=m5-max
```

各レベルごとの環境変数 (`INTERN_TIER_INSTANT`, `INTERN_TIER_WORKHORSE`, `INTERN_TIER_DEEP`, `INTERN_EMBED_MODEL`) は、個別の設定を行う場合に、プロファイル設定を上書きします。

---

## 一貫性のあるエンベロープ

すべてのツールは、同じ形式で結果を返します。

```ts
{
  result: <tool-specific>,
  tier_used: "instant" | "workhorse" | "deep" | "embed",
  model: string,
  hardware_profile: string,     // "dev-rtx5080" | "dev-rtx5080-llama" | "m5-max"
  tokens_in: number,
  tokens_out: number,
  elapsed_ms: number,
  residency: {
    in_vram: boolean,
    size_bytes: number,
    size_vram_bytes: number,
    evicted: boolean
  } | null
}
```

`residency` (常駐) は、Ollama の `/api/ps` から取得されます。`evicted: true` (追い出された) または `size_vram < size` (VRAM のサイズが小さい) の場合、モデルがディスクにページアウトされ、推論速度が 5～10 倍低下します。ユーザーにこの状況を通知し、Ollama を再起動するか、ロードされているモデルの数を減らすように促します。

すべての呼び出しは、`~/.ollama-intern/log.ndjson` に 1 行の NDJSON として記録されます。`hardware_profile` でフィルタリングすることで、開発環境の数値を公開ベンチマークから除外できます。

---

## ハードウェアプロファイル

| プロファイル | Instant | Workhorse | Deep | Embed |
|---|---|---|---|---|
| **`dev-rtx5080`** (デフォルト) | qwen2.5 7B | qwen2.5-coder 7B | qwen2.5 14B | nomic-embed-text |
| `dev-rtx5080-llama` | qwen2.5 7B | qwen2.5-coder 7B | **llama3.1 8B** | nomic-embed-text |
| `m5-max` | qwen2.5 14B | qwen2.5-coder 32B | llama3.3 70B | nomic-embed-text |

**同じファミリー内のモデルを使用した場合、** 期待される出力が得られない場合でも、それはツールの設計上の問題である可能性が高く、異なるファミリーのモデル間の不整合によるものではありません。 `dev-rtx5080-llama` は基準となる環境です。Llama 8B を使用して同じ評価を実行し、M5 Max で Llama を使用する前に、問題がないことを確認してください。

---

## 証拠に関する規定

これらの規定は、プロンプトではなくサーバー側で適用されます。

- **引用の必要性:** すべての主張には、証拠のIDが必ず記載されています。
- **不明なIDの削除:** 証拠のセットに含まれていないIDを参照するモデルの場合、そのIDは警告とともに削除されます。
- **信頼性の低い情報は信頼性の低いまま:** 信頼性の低い証拠には、`weak: true` というフラグと、その範囲に関する注釈が付けられます。これは、虚偽の情報を生成するために修正されることはありません。
- **調査目的、指示目的ではない:** `next_checks`、`read_next`、`likely_breakpoints` は、あくまで調査のための情報です。プロンプトで「この修正を適用してください」という指示は禁止されています。
- **決定的なレンダリング:** アーティファクトのマークダウン形式はコードであり、プロンプトではありません。`draft` は、モデルの表現が重要な文章のために予約されています。
- **同一のパッケージ内での差分のみ:** 異なるパッケージ間の `artifact_diff` は拒否されます。ペイロードは常に独立しています。

---

## アーティファクトと継続性

パッケージは、`~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)` に書き込みます。このアーティファクト機能は、ファイル管理ツールにするのではなく、継続性を確保するためのものです。

- `artifact_list`: メタデータのみを含むインデックスで、パッケージ、日付、slugのglobでフィルタリングできます。
- `artifact_read`: `{pack, slug}` または `{json_path}` で型付きの読み込みを行います。
- `artifact_diff`: 同じパッケージ内の構造化された比較で、信頼性の低い情報の変更点が強調表示されます。
- `artifact_export_to_path`: 既存のアーティファクト（プロベナンスヘッダー付き）を、呼び出し元が指定した `allowed_roots` に書き込みます。既存のファイルは、`overwrite: true` が指定されていない限り拒否されます。
- `artifact_incident_note_snippet`: オペレーター向けのメモの断片。
- `artifact_onboarding_section_snippet`: ハンドブックの断片。
- `artifact_release_note_snippet`: DRAFT（下書き）のリリースノートの断片。

この階層には、モデルの呼び出しは含まれません。すべて、保存されたコンテンツからレンダリングされます。

---

## 脅威モデルとテレメトリ

**アクセスされるデータ:** 呼び出し元が明示的に指定するファイルパス (`ollama_research`、コーパスツール）、インラインテキスト、および、呼び出し元が `~/.ollama-intern/artifacts/` または呼び出し元が指定した `allowed_roots` に書き込むように要求するアーティファクト。

**アクセスされないデータ:** `source_paths` / `allowed_roots` の外部にあるデータ。 `..` は正規化の前に拒否されます。 `artifact_export_to_path` は、`overwrite: true` が指定されていない限り、既存のファイルを拒否します。 保護されたパス (`memory/`, `.claude/`, `docs/canon/` など) をターゲットとする下書きは、サーバー側で強制される `confirm_write: true` が必要です。

**ネットワークからの送信:** **デフォルトでは無効です。** 送信されるトラフィックは、ローカルの Ollama HTTP エンドポイントへのものだけです。クラウドへのアクセス、アップデートの確認、クラッシュレポートは行われません。

**テレメトリ:** **ありません。** すべての呼び出しは、`~/.ollama-intern/log.ndjson` に1行のNDJSON形式で記録されます。システム外にデータは送信されません。

**エラー:** 構造化された形式 `{ code, message, hint, retryable }` で返されます。スタックトレースは、ツールからの結果には表示されません。

詳細なポリシー: [SECURITY.md](SECURITY.md)。

---

## 基準

[Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck) の基準を満たしています。 A～Dの基準をすべてクリアする必要があります。詳細は [SHIP_GATE.md](SHIP_GATE.md) および [SCORECARD.md](SCORECARD.md) を参照してください。

- **A. セキュリティ:** SECURITY.md、脅威モデル、テレメトリなし、パスの安全性、保護されたパスでの `confirm_write`
- **B. エラー:** すべてのツール結果で構造化された形式、生のスタックトレースなし
- **C. ドキュメント:** README (最新)、CHANGELOG、LICENSE; ツールのスキーマは自己記述的
- **D. 衛生:** `npm run verify` (395テスト)、CIによる依存関係のスキャン、Dependabot、lockfile、`engines.node`

---

## ロードマップ（機能強化、スコープの拡大ではない）

- **フェーズ1：委譲基盤** ✓ 完了：アトムインターフェース、統一されたエンベロープ、階層型ルーティング、安全対策
- **フェーズ2：真実基盤** ✓ 完了：スキーマv2のチャンク化、BM25 + RRF、動的なコーパス、根拠に基づいた概要、検索評価パッケージ
- **フェーズ3：パッケージと成果物基盤** ✓ 完了：安定した成果物と継続性を持つ固定パイプラインパッケージ
- **フェーズ4：導入基盤** — RTX 5080での実際の利用状況を観察し、表面化する問題点を改善
- **フェーズ5：M5 Maxのベンチマーク** — ハードウェアが提供されたら、公開可能な数値を出力します（～2026年4月24日頃）

各フェーズは、機能強化のレイヤーで構成されます。アトム/パッケージ/成果物インターフェースは変更されません。

---

## ライセンス

MIT — [LICENSE](LICENSE) を参照してください。

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
