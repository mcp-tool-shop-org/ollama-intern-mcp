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

**また、[Hermes Agent](https://github.com/NousResearch/hermes-agent) を `hermes3:8b` で動作させます**。エンドツーエンドで検証済み (2026-04-19)。デフォルトのモデルは `hermes3:8b` で、`qwen3:*` が代替モデルです。詳細は、以下の [Hermes との連携](#use-with-hermes) を参照してください。

**ハードウェア要件:** `hermes3:8b` の場合、約 6GB の VRAM が必要です。CPU での推論を行う場合は、約 16GB の RAM が必要です。詳細については、[handbook/getting-started](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/getting-started/#hardware-minimums) を参照してください。

**Claude を使用していませんか？** [`examples/`](./examples/) ディレクトリには、最小限の Node.js および Python MCP クライアントがあり、これらを標準入出力 (stdio) を介して実行できます。また、[handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/) も参照してください。

クラウドは不要。テレメトリーも不要。そして、「自律型」の機能もありません。すべての処理は、その過程を明確に示します。

---

## v2.1.0 での変更点

機能の拡張により、既存のティアが拡張されます。新しいティアクラスは追加されず、atoms+briefs の 18 件の保持は維持されます。

- **`ollama_log_tail`**: MCP セッション内で、NDJSON 形式のログを読み取ります。[handbook/observability](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/observability/#the-ollama_log_tail-tool) を参照してください。
- **`ollama_batch_proof_check`**: 複数のパスに対して、`tsc` / `eslint` / `pytest` を実行します。各チェックの結果 (合格/不合格) をまとめた結果を返します。新しい実行機能です。詳細は、[SECURITY.md](./SECURITY.md) を参照してください。
- **`ollama_code_map`**: コードツリーの構造マップ (エクスポート、コールグラフの概要、TODO)。
- **`ollama_code_citation`**: 指定されたシンボルに対して、定義ファイル、行番号、およびその周辺のコンテキストを返します。
- **`ollama_corpus_amend`**: 既存のコーパスに対して、差分を加えて編集します。後続の回答では、`has_amended_content: true` が設定されます。
- **`ollama_artifact_prune`**: 年齢に基づいて不要なファイルを削除します (デフォルトでは、削除前にテスト実行を行います)。[handbook/artifacts](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/artifacts/#artifact_prune) を参照してください。
- **改善点**: `summarize_deep` は、`source_path` を受け入れるようになりました。`corpus_answer` は、修正されたコンテンツの状態を表示します。エンドツーエンドで検証された新しい監視イベントが追加されました。
- **新しいハンドブックのページ**: [Observability](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/observability/) (NDJSON ログと jq のレシピ) および [Comparison](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/comparison/) (正直な比較と代替案)。

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
  "model": "hermes3:8b",
  "hardware_profile": "dev-rtx5080",
  "tokens_in": 4180, "tokens_out": 612,
  "elapsed_ms": 8410,
  "residency": { "in_vram": true, "evicted": false }
}
```

その Markdown ファイルは、インターンのデスクからの出力です。見出し、引用元 ID が記載された証拠ブロック、調査のための `next_checks`、証拠が不十分な場合は `weak: true` というバナーが表示されます。これは決定論的です。レンダリングはコードによって行われ、プロンプトではありません。明日開いて、来週に差分を確認し、`ollama_artifact_export_to_path` を使用して、ハンドブックにエクスポートします。

このカテゴリの競合製品は、すべて「トークンを節約する」ことを強調しています。私たちは、_インターンが書いたファイル_ を提供することに重点を置いています。

### 2つ目の例：コーパスを作成し、それを使って質問する

```jsonc
// 1. Build a persistent, searchable corpus over your project.
{ "tool": "ollama_corpus_index",
  "arguments": { "name": "sprite-foundry",
                 "paths": ["F:/AI/sprite-foundry/src"],
                 "embed_model": "nomic-embed-text" } }
// → { chunks_written: 1204, paths_indexed: 312, failed_paths: [] }

// 2. Ask an evidence-bound question against it.
{ "tool": "ollama_corpus_answer",
  "arguments": { "name": "sprite-foundry",
                 "query": "how does the worker handle OOM eviction?",
                 "top_k": 8 } }
// → { answer: "...", citations: [{chunk_id, path}...], weak: false }
```

`answer` に含まれるすべての記述は、サーバー側で検証されたチャンク ID を参照しています。詳細な手順は、[handbook/corpora](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/corpora/) を参照してください。

---

## 構成：4つのレベル、28種類のツール

**ジョブ指向**: 各ツールは、インターンに割り当てるべきタスクを定義します。例えば、「これを分類する」「これを抽出する」「これらのログを分析する」「このリリースノートの草稿を作成する」「これをパッケージ化する」などです。ツールの入力はタスク仕様であり、出力は成果物です。トップレベルには、汎用的な `run_model` / `chat_with_llm` のような機能はありません。

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

[Ollama](https://ollama.com) がローカルで実行されており、必要なモデルがダウンロードされている必要があります (詳細は、以下の [モデルのダウンロード](#model-pulls) を参照)。

### Claude Code (推奨)

多くのユーザーは、このツールを Claude Code MCP サーバーの設定に追加することでインストールします。グローバルなインストールは必要ありません。Claude Code は、`npx` を使用してオンデマンドでサーバーを実行します。

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

### グローバルインストール (上級者向け)

Claude Code 以外で、コマンドラインから ad-hoc で使用する場合に、実行ファイルを `PATH` に追加したい場合にのみ必要です。

```bash
npm install -g ollama-intern-mcp
```

### Hermes との連携

この MCP は、[Hermes Agent](https://github.com/NousResearch/hermes-agent) を使用して、Ollama の `hermes3:8b` に対してエンドツーエンドで検証されています (2026-04-19)。Hermes は、この MCP の固定された基本的な機能を利用する外部エージェントです。Hermes は計画を立て、当社は作業を実行します。

リファレンス設定ファイル ([hermes.config.example.yaml](hermes.config.example.yaml) がこのリポジトリにあります):

```yaml
model:
  provider: custom
  base_url: http://localhost:11434/v1
  default: hermes3:8b
  context_length: 65536    # Hermes requires 64K floor under model.*

providers:
  local-ollama:
    name: local-ollama
    base_url: http://localhost:11434/v1
    api_mode: openai_chat
    api_key: ollama
    model: hermes3:8b

mcp_servers:
  ollama-intern:
    command: npx
    args: ["-y", "ollama-intern-mcp"]
    env:
      OLLAMA_HOST: http://localhost:11434
      INTERN_PROFILE: dev-rtx5080
      # hermes3:8b is the default ladder in v2.0.0, so tier overrides are
      # only needed if you're pinning a different local model.
```

**プロンプトの形式が重要です。** 命令的なツール呼び出しプロンプト（「Xを引数…で呼び出す」など）は、統合テストとして機能します。これにより、8Bのローカルモデルでも、適切な構造に基づいて正確な`tool_calls`を生成できます。リスト形式のマルチタスクプロンプト（「Aを実行し、次にBを実行し、次にCを実行する」など）は、より大規模なモデルの性能評価に使用されます。8Bモデルでリスト形式のプロンプトが失敗した場合でも、「システムに問題がある」と解釈するべきではありません。詳細な統合テスト手順と、既知の通信に関する注意点については、[handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/) を参照してください（Ollama `/v1`ストリーミングと、openai-SDKの非ストリーミング互換レイヤーに関する情報が含まれています）。

### モデルのダウンロード

**デフォルトの開発環境 (RTX 5080 16GB 相当):**

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=-1
```

**Qwen 3の代替環境（同じハードウェアを使用し、Qwenのツール連携用）：**

```bash
ollama pull qwen3:8b
ollama pull qwen3:14b
ollama pull nomic-embed-text
export INTERN_PROFILE=dev-rtx5080-qwen3
```

**M5 Max 環境 (128GB 統合メモリ):**

```bash
ollama pull qwen3:14b
ollama pull qwen3:32b
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
  hardware_profile: string,     // "dev-rtx5080" | "dev-rtx5080-qwen3" | "m5-max"
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
| **`dev-rtx5080`** (デフォルト) | hermes3 8B | hermes3 8B | hermes3 8B | nomic-embed-text |
| `dev-rtx5080-qwen3` | qwen3 8B | qwen3 8B | qwen3 14B | nomic-embed-text |
| `m5-max` | qwen3 14B | qwen3 14B | qwen3 32B | nomic-embed-text |

**デフォルトの開発環境**では、すべての開発段階が`hermes3:8b`に統合されています。これは、検証済みのHermes Agent連携パスです。同じモデルを使用することで、管理、コスト、理解すべき動作が統一されます。Qwen 3（`THINK_BY_SHAPE`機能を使用）を希望するユーザーは、`dev-rtx5080-qwen3`環境を選択できます。`m5-max`は、統合メモリ用に最適化されたQwen 3の環境です。

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

- **フェーズ1 — 委譲基盤** ✓ 完了：アトム表面、統一されたインターフェース、階層型ルーティング、安全対策
- **フェーズ2 — 真実基盤** ✓ 完了：スキーマv2によるチャンク分割、BM25 + RRF、動的なコーパス、証拠に基づく要約、検索評価ツール
- **フェーズ3 — パッケージと成果物基盤** ✓ 完了：固定パイプラインによるパッケージングと、永続的な成果物、継続性機能
- **フェーズ4 — 導入基盤** ✓ v2.0.1：3段階の健全性チェックによる強化されたコーパス（TOCTOU対策、50MBファイル制限、シンボリックリンク拒否、アトミック書き込み、ファイルごとのエラーキャプチャ）、ツールパスの探索、監視機能（セマフォ待ちイベント、タイムアウトエラーコンテキスト、プロファイル環境変数オーバーライドログ、コールドスタート時の事前ウォームアップ信号）、テストの安全性（10個のファイルに対するモジュールロード環境のスナップショット、`tools/call`のE2Eテスト）。オペレーター向けに、トラブルシューティングガイドとハードウェアの最低要件を追加しました。
- **フェーズ5 — M5 Maxのベンチマーク** — ハードウェアが利用可能になった時点で、公開可能な数値データを公開します（予定：2026年4月24日頃）。

各フェーズは、機能強化のレイヤーで構成されます。アトム/パッケージ/成果物インターフェースは変更されません。

---

## ライセンス

MIT — [LICENSE](LICENSE) を参照してください。

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
