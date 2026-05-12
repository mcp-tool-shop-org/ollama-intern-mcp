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

**Claude Code用のローカルインターン。** 41種類のツール、証拠に基づいたレポート、永続的な成果物。

Claude Codeに、ルール、階層、デスク、そして書類整理棚を備えた**ローカルインターン**を提供するMCPサーバー。Claudeが_ツール_を選択し、ツールが_階層_（Instant / Workhorse / Deep / Embed）を選択します。階層が、来週開くことができるファイルを作成します。

**また、`hermes3:8b`上で[Hermes Agent](https://github.com/NousResearch/hermes-agent)も実行します**。2026年4月19日にエンドツーエンドで検証済み。デフォルトの階層は`hermes3:8b`で、`qwen3:*`が代替のオプションです。詳細は、以下の[Hermesとの連携](#use-with-hermes)を参照してください。

**必要なハードウェア:** `hermes3:8b`の場合は約6GBのVRAM、CPU推論の場合は約16GBのRAM。詳細については、[handbook/getting-started](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/getting-started/#hardware-minimums)を参照してください。

**Claudeを使用していませんか？** [`examples/`](./examples/)ディレクトリには、最小限のNode.jsとPythonのMCPクライアントがあり、stdio経由で利用できます。また、[handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/)も参照してください。

クラウドは不要。テレメトリーも不要。また、「自律的な」機能もありません。すべての処理は、その過程を明確に示します。

---

## v2.2.0で追加

ローカルの証拠収集機能に関する契約：主題に特化した内容と、構造化された拒否。マイナーな変更であり、v2.1.0からの呼び出し元は変更ありません。詳細は、[CHANGELOG.md](./CHANGELOG.md)と[docs/release-notes/v2.2.0.md](./docs/release-notes/v2.2.0.md)を参照してください。

- `ollama_extract`, `ollama_classify`, `ollama_summarize_fast`, `ollama_summarize_deep`における**主題に特化した抽出**：オプションで`frame: string`を入力し、構造化された`frame_alignment` / `on_topic` / `frame_addressed`の出力を行います。関連性の低いソースは、スキーマに変換するのではなく、フラグが立てられます。
- `ollama_research`における**構造化された拒否**：`weak` / `abstained` / `sources_address_question`のフィールド。空の`citations[]`で`answer`が空でない場合、成功として認識されなくなりました。
- `ollama_corpus_answer`における**主題の閾値**：オプションで`min_top_score`を設定できます。閾値を下回ると、ツールは`abstained: true`となり、合成処理をスキップします。各引用元に対する`score`が、各引用元で表示されるようになりました。
- 簡潔な証拠による**検索スコアの保持**：`corpusHitsToEvidence`は`score`（および`corpus_min_evidence_score`パラメータ）を保持し、`incident_brief` / `repo_brief` / `change_brief`の組み立て時にフィルタリングを行います。
- **引用元の範囲制限**：`guardrails/citations.ts`は、`ollama_research`における範囲外の引用元を拒否し、既存の`ollama_code_citation`における同様の制限と一致します。
- **オペレーター契約に関するドキュメントの修正**：READMEの`chunk_id`/`chunk_index`の修正、"validated server-side"の書き換え、Evidence Lawsセクションの注釈、マーケティングスローガンの注釈。

### シードの回帰テスト - 検証

このスライスの契約は、literal research-osの新しい環境における失敗（arxiv 2112.10422、Cosmological Standard Timers）に対して検証されています。セクション01のフレーム *"What does evidence custody mean in local-first vs cloud LLM deep-research workflows?"* において、9件のLLM契約テストがすべて合格し、関連性の低いソースが適切に扱われることを確認しました（extractでは`frame_alignment.on_topic = false`、classifyでは`off_topic: true`、summarize_deepでは`frame_addressed: false`、corpus_answerでは`abstained: true`で、`min_top_score`が設定されています）。

### 過去のバージョン - v2.1.0の機能

詳細については、[CHANGELOG.md](./CHANGELOG.md)を参照してください（新機能：13種類のツール + 4つの改善 + freeze lift）。

---

## 代表的な例 - 1回の呼び出し、1つの成果物

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

→ `weak: false`は、2つ以上の証拠が収集されたことを意味します。ただし、これは仮説が検証されたことを意味するものではありません。詳細は、[Evidence laws](#evidence-laws)を参照してください。

そのマークダウンファイルは、インターンの作成したドキュメントです。見出し、引用元IDが記載された証拠ブロック、調査における次のステップ (`next_checks`)、証拠が不十分な場合は「注意: 不確実」というバナーが表示されます。これは決定論的な動作で、レンダリングはコードによって行われ、プロンプトによるものではありません。（レンダリングは決定論的ですが、仮説や表面の内容は生成されます。これらは草案として読み、検証されていないことを理解してください。）明日開いて、来週に差分を確認し、`ollama_artifact_export_to_path` を使用して、ハンドブックにエクスポートしてください。

このカテゴリの競合製品はすべて、「トークンを節約する」という文言を強調しています。私たちは、「ここにインターンが作成したファイルがあります」ということを強調しています。

### 2つ目の例：まずコーパスを作成し、次にそれを使用します

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
// → { answer: "...", citations: [{chunk_index, path}...], weak: false }
```

サーバーは、引用元の同一性を検証し、各 `chunk_index` が取得された結果の範囲内にあることを確認します。ただし、生成されたすべての主張が、引用されたチャンクの内容によって意味的に裏付けられていることを証明するものではありません。それはモデルの責任であり、検索の精度が低い場合でも、引用のような回答が生成される可能性があります。詳細な手順は、[ハンドブック/コーパス](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/corpora/) に記載されています。

---

## フレームに依存した抽出（v2.2.0で新機能）

`ollama_extract`、`ollama_classify`、`ollama_summarize_fast`、および `ollama_summarize_deep` は、オプションの `frame: string` 入力を受け入れます。`frame` は、ソースが回答するように求められている質問の名前を示します。ソースが質問に答えない場合、モデルは、関連性のない内容を生成するのではなく、回答を拒否するように指示されます。

```jsonc
{
  "tool": "ollama_extract",
  "arguments": {
    "text": "<long source document>",
    "schema": { /* your fields */ },
    "frame": "section purpose here — e.g. 'OOM eviction behavior in the sprite worker'"
  }
}
// → result includes frame_alignment: { on_topic: boolean, reason: string, unaddressed_aspects: string[] }
```

`frame` が省略された場合、v2.1.0 との動作は変わりません。`frame` が指定された場合、`frame_alignment.on_topic = false` は、抽出されたフィールドがソースの内容に基づいているものの、フレームに関連しない可能性があることを示します。これは、`weak: true` の場合と同様に扱います。つまり、有用ですが、最終的な証拠として使用する前に、必ず確認してください。

---

## 回答拒否のルール（v2.2.0で新機能）

`ollama_research` は、構造化された回答拒否のフィールドを返します。`weak: boolean`、`abstained: boolean`、`sources_address_question: boolean | null`。空の `citations[]` と非空の `answer` が同時に存在する場合、以前は何も出力されませんでしたが、現在は `abstained: true` となり、モデルが、呼び出し元が提供した情報が質問に答えていないため、回答を生成できなかったことを示します。回答拒否を、失敗ではなく成功として扱ってください。これは、ツールが、検索の精度が低い情報を、信頼できる出力に変換することを拒否していることを意味します。

`ollama_corpus_answer` は、オプションの `min_top_score: number` というトピックに関連する閾値（0.0～1.0）を受け入れます。クエリのトップ検索スコアが `min_top_score` を下回ると、ツールは `abstained: true` となり、回答の生成をスキップします。これにより、v2.1.0 の `weak: true` ルールでは検出できなかった、「スコア0.21の5つの関連性の低いチャンクが、完全な回答を生成する」という問題を回避できます。（`weak: true` は、`hits.length < 2` の場合にのみ有効でした。）各引用元に新たに表示される `score` フィールドと組み合わせて、引用元から直接検索の品質を監査できます。

---

## ここに何があるか：4つのレベル、41のツール

**ジョブ指向**とは、各ツールが、インターンに割り当てるべきタスクを指すことを意味します。たとえば、「これを分類する」「これを抽出する」「これらのログを分析する」「このリリースノートの草稿を作成する」「このインシデントを処理する」などです。ツールの入力は、そのタスクの仕様であり、出力は成果物です。最上位に、汎用的な `run_model` / `chat_with_llm` のような機能はありません。

| レベル | 数 | ここに何があるか |
|---|---|---|
| **Atoms** | 15 | ジョブ指向の機能。`classify`、`extract`、`triage_logs`、`summarize_fast` / `deep`、`draft`、`research`、`corpus_search` / `answer` / `index` / `refresh` / `list`、`embed_search`、`embed`、`chat`。バッチ処理に対応した機能 (`classify`、`extract`、`triage_logs`) は、`items: [{id, text}]` を入力として受け入れます。 |
| **Briefs** | 3 | 証拠に基づいた構造化された説明。`incident_brief`、`repo_brief`、`change_brief`。すべての主張には、証拠のIDが引用されています。不明な点は、サーバー側で削除されます。証拠が不十分な場合は、偽の記述ではなく、`weak: true` が表示されます。 |
| **Packs** | 3 | 固定されたパイプラインを持つ複合ジョブで、永続的なマークダウンとJSONを`~/.ollama-intern/artifacts/`に書き込みます。`incident_pack`、`repo_pack`、`change_pack`。決定論的なレンダラーを使用しており、アーティファクトの形状に対してはモデルの呼び出しを行いません。 |
| **Artifacts** | 7 | パックの出力に対する連続性。`artifact_list` / `read` / `diff` / `export_to_path`に加え、3つの決定論的なスニペットがあります：`incident_note`、`onboarding_section`、`release_note`。 |

合計：**18の基本要素 + 3つのパック + 7つのアーティファクトツール = 28**。

固定された要素：
- 18の要素（要素と簡単な説明）。新しい要素ツールはありません。
- 3つのパック。新しいパックの種類はありません。
- アーティファクトの階層は7つに固定。

ツールの詳細な参照は、[マニュアル](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/tools/)に記載されています。

---

## インストール

ローカルで実行中の[Ollama](https://ollama.com)と、以下の手順でモデルをダウンロードする必要があります（下記「モデルのダウンロード」を参照）。

### Claude Code (推奨)

多くのユーザーは、Claude CodeのMCPサーバーの設定に追加することでインストールします。グローバルなインストールは不要です。Claude Codeは、`npx`を使用してオンデマンドでサーバーを実行します。

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

同じブロックが、macOSの場合は`~/Library/Application Support/Claude/claude_desktop_config.json`、Windowsの場合は`%APPDATA%\Claude\claude_desktop_config.json`に書き込まれます。

### グローバルインストール（上級者向け）

これは、Claude Code以外で、アドホックに使用する場合に、実行ファイルを`PATH`に追加したい場合にのみ必要です。

```bash
npm install -g ollama-intern-mcp
```

### Hermesとの連携

このMCPは、[Hermes Agent](https://github.com/NousResearch/hermes-agent)を使用して、Ollama上の`hermes3:8b`に対してエンドツーエンドで検証されています（2026-04-19）。Hermesは外部エージェントであり、このMCPの固定された基本要素のインターフェースを呼び出します。Hermesは計画を行い、私たちは作業を行います。

設定ファイルの例（このリポジトリ内の`hermes.config.example.yaml`）：

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

**プロンプトの形式が重要です。** ツール呼び出しを指示するプロンプト（例：「Xを引数…で呼び出す」）は、統合テストに使用されます。これにより、8Bのローカルモデルが、クリーンな`tool_calls`を生成するのに十分な情報が提供されます。リスト形式のマルチタスクプロンプト（例：「Aを実行し、次にBを実行し、次にCを実行する」）は、より大きなモデルの機能ベンチマークに使用されます。8Bモデルでリスト形式のプロンプトが失敗した場合でも、「接続が切れている」と解釈しないでください。詳細については、[handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/)を参照してください。このページでは、統合テストの完全な手順と、既知の転送に関する注意点（Ollama `/v1`ストリーミングとopenai-SDKの非ストリーミングの互換性）が記載されています。

### モデルのダウンロード

**デフォルトの開発環境（RTX 5080 16GB相当）：**

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=-1
```

**Qwen 3の代替環境（同じハードウェア、Qwenのツール用）：**

```bash
ollama pull qwen3:8b
ollama pull qwen3:14b
ollama pull nomic-embed-text
export INTERN_PROFILE=dev-rtx5080-qwen3
```

**M5 Max環境（128GBユニファイド）：**

```bash
ollama pull qwen3:14b
ollama pull qwen3:32b
ollama pull nomic-embed-text
export INTERN_PROFILE=m5-max
```

各階層の環境変数（`INTERN_TIER_INSTANT`、`INTERN_TIER_WORKHORSE`、`INTERN_TIER_DEEP`、`INTERN_EMBED_MODEL`）は、一時的な設定の場合、プロファイル設定を上書きします。

---

## 一貫したインターフェース

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

`residency`は、Ollamaの`/api/ps`から取得されます。`evicted: true`または`size_vram < size`の場合、モデルがディスクにページングされ、推論速度が5〜10倍低下します。ユーザーにこの状況を通知し、Ollamaを再起動するか、ロードされているモデルの数を減らすように促してください。

すべての呼び出しは、`~/.ollama-intern/log.ndjson`に1行のNDJSON形式で記録されます。`hardware_profile`でフィルタリングすることで、開発環境の数値が公開ベンチマークに含まれないようにします。

---

## ハードウェアプロファイル

| プロファイル | Instant | Workhorse | Deep | Embed |
|---|---|---|---|---|
| **`dev-rtx5080`** (デフォルト) | hermes3 8B | hermes3 8B | hermes3 8B | nomic-embed-text |
| `dev-rtx5080-qwen3` | qwen3 8B | qwen3 8B | qwen3 14B | nomic-embed-text |
| `m5-max` | qwen3 14B | qwen3 14B | qwen3 32B | nomic-embed-text |

**デフォルト設定**では、すべてのワーク層が`hermes3:8b`に統合されます。これは、検証済みのHermes Agent統合パスです。同じモデルを使用することで、参照すべきものが一つ、運用コストが一つ、理解すべき動作が一つになります。Qwen 3（`THINK_BY_SHAPE`機能を備えたモデル）を使用したいユーザーは、`dev-rtx5080-qwen3`を選択します。`m5-max`は、統合メモリ用にサイズ調整されたQwen 3モデルです。

---

## 証拠に関する規定

これらの規定は、プロンプトではなくサーバー側で適用されます。

- **引用が必要。** 各簡潔な記述には、証拠IDが必ず含まれています。
- **不明なIDはサーバー側で削除。** 証拠バンドルに含まれていないIDを参照するモデルの場合、そのIDは警告とともに削除されます。
- **IDの検証は、コンテンツの検証ではありません。** サーバーは、参照されているすべての`evidence_ref`が、組み立てられたセット内の有効な証拠IDを指していることを確認します。ただし、記述テキストが参照された証拠から導出できるかどうかは検証しません。これはモデルの役割であり、場合によっては、有効な参照を含んでいるにもかかわらず、根拠のない記述が含まれていることがあります。`weak: true`、`coverage_notes`、および含まれている`excerpt`フィールドを使用して、検証を行うことを推奨します。
- **「弱い」とは「弱い」。** 証拠が「弱い」と判断された場合、関連する説明が追加されます。これは、虚偽の記述として解釈されることはありません。
- **調査目的、指示目的ではない。** `next_checks`、`read_next`、`likely_breakpoints`は、あくまで調査のためのものです。プロンプトで「この修正を適用してください」という指示は禁止されています。
- **決定論的なレンダリング。** アーティファクトのマークダウン形式はコードであり、プロンプトではありません。`draft`は、モデルの表現が重要な文章のために予約されています。
- **同一パッケージ内の差分のみ。** 異なるパッケージ間の`artifact_diff`は拒否されます。ペイロードは常に独立しています。

---

## アーティファクトと継続性

パッケージは、`~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)`に書き込みます。このアーティファクト層は、ファイル管理ツールにするのではなく、継続性を確保するためのものです。

- `artifact_list`：メタデータのみを含むインデックス。パッケージ、日付、slugのglobでフィルタリングできます。
- `artifact_read`：`{pack, slug}`または`{json_path}`で指定された型付きの読み込み。
- `artifact_diff`：同一パッケージ内の構造化された比較。弱い要素の変更点が強調表示されます。
- `artifact_export_to_path`：既存のアーティファクト（プロベナンスヘッダー付き）を、呼び出し元が指定した`allowed_roots`に書き込みます。既存のファイルは、`overwrite: true`が指定されていない限り拒否されます。
- `artifact_incident_note_snippet`：オペレーター向けのメモの断片。
- `artifact_onboarding_section_snippet`：ハンドブックの断片。
- `artifact_release_note_snippet`：DRAFT版のリリースノートの断片。

この層では、モデルの呼び出しは行われません。すべて、保存されたコンテンツからレンダリングされます。

---

## 脅威モデルとテレメトリー

**アクセスされるデータ：** 呼び出し元が明示的に指定するファイルパス（`ollama_research`、コーパスツール）、インラインテキスト、および呼び出し元が`~/.ollama-intern/artifacts/`または呼び出し元が指定した`allowed_roots`に書き込むように要求するアーティファクト。

**アクセスされないデータ：** `source_paths`または`allowed_roots`の外部にあるデータ。`..`は、正規化処理の前に拒否されます。`artifact_export_to_path`は、`overwrite: true`が指定されていない限り、既存のファイルを拒否します。保護されたパス（`memory/`、`.claude/`、`docs/canon/`など）をターゲットとするドラフトは、明示的に`confirm_write: true`を指定する必要があります。これは、サーバー側で強制されます。

**ネットワークからの送信：** **デフォルトでは無効。** 送信されるトラフィックは、ローカルのOllama HTTPエンドポイントへのものだけです。クラウドへのアクセス、アップデートの確認、クラッシュレポートは行われません。

**テレメトリー：** **なし。** すべての呼び出しは、`~/.ollama-intern/log.ndjson`に1行のNDJSON形式でログとして記録されます。データはすべてローカルに保存されます。

**エラー：** 構造化された形式 `{ code, message, hint, retryable }`。スタックトレースは、ツールからの結果には表示されません。

詳細なポリシー：[SECURITY.md](SECURITY.md)。

---

## 基準

[Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck)の基準に準拠しています。A～Dの基準をクリアする必要があります。詳細は、[SHIP_GATE.md](SHIP_GATE.md)および[SCORECARD.md](SCORECARD.md)を参照してください。

- **A. セキュリティ** — SECURITY.md、脅威モデル、テレメトリーなし、パスの安全性、保護されたパスでの `confirm_write`
- **B. エラー** — 全てのツール結果における構造化されたエラー情報; スタックトレースは生データではない
- **C. ドキュメント** — README (最新版)、CHANGELOG、LICENSE; ツールのスキーマは自己完結型
- **D. 品質** — `npm run verify` (完全な vitest スイート)、依存関係スキャンを含む CI、Dependabot、ロックファイル、`engines.node`

---

## ロードマップ（機能強化、スコープの拡大ではない）

- **フェーズ1 — 委譲基盤** ✓ 完了: atom 表面、統一されたエンベロープ、階層型ルーティング、ガードレール
- **フェーズ2 — 真実基盤** ✓ 完了: スキーマ v2 のチャンク化、BM25 + RRF、動的なコーパス、証拠に基づく概要、検索評価パッケージ
- **フェーズ3 — パッケージとアーティファクト基盤** ✓ 完了: 永続的なアーティファクトと継続性層を持つ固定パイプラインのパッケージ
- **フェーズ4 — 導入基盤** ✓ v2.0.1: 三段階の健全性チェック済みコーパス（TOCTOU、50MB ファイル制限、シンボリックリンク拒否、アトミック書き込み、ファイルごとのエラーキャプチャ）、ツールパスのトラバーサル、可観測性（セマフォ待ちイベント、タイムアウトエラーコンテキスト、プロファイル環境オーバーライドのログ、コールドスタートの事前ウォームアップ信号）、テストの安全性（10個のファイルにわたるモジュールロード環境のスナップショット、`tools/call` のエンドツーエンドテスト）。オペレーター向けトラブルシューティングハンドブックとハードウェアの最小要件を追加。
- **フェーズ5 — M5 Max のベンチマーク** — ハードウェアが利用可能になったら、公開可能な数値（約2026年4月24日）

各フェーズは、セキュリティ強化のレイヤーとして構成されます。atom/pack/artifact の表面は変更されません。

---

## ライセンス

MIT — [LICENSE](LICENSE) を参照してください。

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
