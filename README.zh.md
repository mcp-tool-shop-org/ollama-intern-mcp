<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.md">English</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

**Claude Code 的本地实习生。** 41 个工具，基于证据的简报，持久的成果。

一个 MCP 服务器，为 Claude Code 提供一个**本地实习生**，包括规则、等级、办公桌和文件柜。 Claude 选择 _工具_；工具选择 _等级_（即时/工作型/深度/嵌入式）；等级会生成一个文件，您可以在下周打开它。

**同时在 `hermes3:8b` 上运行 [Hermes Agent](https://github.com/NousResearch/hermes-agent)** — 已于 2026 年 4 月 19 日进行端到端验证。 默认等级为 `hermes3:8b`；`qwen3:*` 是备选方案。 详情请参阅下方的 [与 Hermes 的使用](#use-with-hermes)。

**硬件要求：** `hermes3:8b` 需要约 6 GB 的 VRAM，或者 CPU 推理需要约 16 GB 的 RAM。 详细信息请参阅 [handbook/getting-started](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/getting-started/#hardware-minimums)。

**不使用 Claude？** `examples/` 目录包含一个最小的 Node.js 和 Python MCP 客户端，可以通过标准输入/输出进行交互。 另请参阅 [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/)。

无云服务。无遥测。没有任何“自主”功能。 每个调用都会显示其工作过程。

---

## 新功能，版本 2.2.0

本地证据处理器的角色规范：基于上下文的主题相关性和结构化拒绝。 这是一个小版本更新，v2.1.0 的调用者未发生变化。 详细信息请参阅 [CHANGELOG.md](./CHANGELOG.md) 和 [docs/release-notes/v2.2.0.md](./docs/release-notes/v2.2.0.md)。

- **基于上下文的提取**：在 `ollama_extract`、`ollama_classify`、`ollama_summarize_fast`、`ollama_summarize_deep` 上，可选的 `frame: string` 输入，以及结构化的 `frame_alignment` / `on_topic` / `frame_addressed` 输出。 与其将不相关的主题来源进行释义，不如将其标记为不相关。
- **结构化拒绝**：在 `ollama_research` 上，`weak` / `abstained` / `sources_address_question` 字段。 空的 `citations[]` 且 `answer` 不为空，不再表示成功。
- **主题相关性阈值**：在 `ollama_corpus_answer` 上，可选的 `min_top_score`。 如果低于阈值，该工具将直接跳过，并设置 `abstained: true`，从而跳过合成过程。 每个引用的 `score` 现在可以在每个引用中看到。
- **检索分数保留**：通过简短的证据进行，`corpusHitsToEvidence` 携带 `score`（以及 `corpus_min_evidence_score` 参数，可以在 `incident_brief` / `repo_brief` / `change_brief` 的组装时进行过滤）。
- **引用范围限制**：`guardrails/citations.ts` 会拒绝 `ollama_research` 中超出范围的引用，这与 `ollama_code_citation` 现有的限制相同。
- **操作规范文档已更正**：README 文件中的 `chunk_id`/`chunk_index` 已修复，"validated server-side" 已重写，证据法律部分已进行限定，营销口号已进行注释。

### 种子回归 — 验证

该切片的规范已针对字面意义上的研究操作系统的新版本失败进行验证：arxiv 2112.10422 (Cosmological Standard Timers)，在 section-01 框架 *"What does evidence custody mean in local-first vs cloud LLM deep-research workflows?"* 下，9 个模拟的 LLM 规范测试确认，不相关的主题来源现在已被包含 (`frame_alignment.on_topic = false` 在提取时；`off_topic: true` 在分类时；`frame_addressed: false` 在深度摘要时；`abstained: true` 在 `corpus_answer` 中，并且 `min_top_score` 已设置)。

### 历史 — v2.1.0 的交付成果

请参阅 [CHANGELOG.md](./CHANGELOG.md) 以获取完整的 v2.1.0 版本信息（功能更新：13 个新工具 + 4 个增强 + 版本升级）。

---

## 示例 — 一个调用，一个成果

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

返回一个指向磁盘上文件的指针：

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

→ `weak: false` 表示已收集到 ≥2 个证据项；但这并不意味着假设已得到验证。 详情请参阅下方的 [证据法律](#evidence-laws)。

那个 Markdown 文件是实习生生成的报告 — 包含标题、带有引文 ID 的证据块，以及如果证据不足时显示的“弱：true”提示。它的输出是确定的：渲染器是代码，而不是提示。 （渲染器是确定的；假设和表面的*内容*是生成的，请将其视为草稿，而不是经过验证的内容。）明天打开它，下周进行差异比较，然后使用 `ollama_artifact_export_to_path` 将其导出到手册中。

在这个类别中的每个竞争对手都以“节省令牌”为口号。我们以“这是实习生编写的文件”为口号。

### 第二个示例 — 构建一个语料库，然后向它提问

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

服务器验证引文的身份，并确保每个 `chunk_index` 都在检索到的结果范围内。它*不*证明生成的每个声明都由引用的内容在语义上支持 — 这是模型的责任，而且即使是弱检索也可能产生看起来像引文的答案。 完整的说明请参见 [手册/语料库](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/corpora/)。

---

## 基于上下文的提取（新功能，v2.2.0 版本）

`ollama_extract`、`ollama_classify`、`ollama_summarize_fast` 和 `ollama_summarize_deep` 接受一个可选的 `frame: string` 输入。 `frame` 参数指定了源需要回答的问题；如果源没有涉及该问题，模型将避免输出与问题相关的内容，而是输出其他内容。

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

如果省略 `frame`，行为将与 v2.1.0 版本相同。 如果提供了 `frame`，`frame_alignment.on_topic = false` 表示提取的字段可能与源相关，但与 `frame` 不相关 — 将其视为与 `weak: true` 简报相同的含义：有用，但在推广到下游证据之前，请进行重点检查。

---

## 拒绝协议（新功能，v2.2.0 版本）

`ollama_research` 返回结构化的拒绝字段：`weak: boolean`、`abstained: boolean`、`sources_address_question: boolean | null`。 即使 `answer` 不为空，但 `citations[]` 为空，也不会再保持沉默 — `abstained: true` 表示模型拒绝合成，因为调用者提供的路径没有涉及该问题。 将拒绝视为成功，而不是失败：这是工具拒绝将弱检索转化为权威输出。

`ollama_corpus_answer` 接受一个可选的 `min_top_score: number` 主题相关性阈值（0.0–1.0）。 当某个查询的最高检索分数低于 `min_top_score` 时，该工具将使用 `abstained: true` 立即停止，并跳过合成 — 从而防止出现“即使有 5 个得分仅为 0.21 的不相关片段，仍然会生成完整的答案”的情况，而 v2.1.0 版本的 `weak: true` 规则未能捕捉到这种情况（`weak: true` 仅在 `hits.length < 2` 时触发）。 将其与每个引文中的 `score` 字段结合使用，可以直接从结果中审计检索质量。

---

## 这里包含的内容：四个层级，41 个工具

**任务型**意味着每个工具都代表着您可以交给实习生的任务 — 对此进行分类，提取那个，对这些日志进行分级，起草这个发布说明，打包这个事件。 工具的输入是任务规范；输出是交付成果。 没有通用的 `run_model` / `chat_with_llm` 基础功能。

| 层级 | 数量 | 包含的内容 |
|---|---|---|
| **Atoms** | 15 | 任务型基础功能。 `classify`、`extract`、`triage_logs`、`summarize_fast` / `deep`、`draft`、`research`、`corpus_search` / `answer` / `index` / `refresh` / `list`、`embed_search`、`embed`、`chat`。 批量处理能力的基础功能 (`classify`、`extract`、`triage_logs`) 接受 `items: [{id, text}]`。 |
| **Briefs** | 3 | 基于证据的结构化简报。 `incident_brief`、`repo_brief`、`change_brief`。 每个声明都引用一个证据 ID；未知内容在服务器端被删除。 弱证据会显示 `weak: true`，而不是虚构的叙述。 |
| **Packs** | 3 | 固定流水线，用于将持久化的 Markdown + JSON 写入到 `~/.ollama-intern/artifacts/` 目录。包括 `incident_pack`、`repo_pack` 和 `change_pack`。采用确定性渲染方式，不直接调用模型，仅处理数据形状。 |
| **Artifacts** | 7 | 提供一个连续的接口，用于处理打包输出。包括 `artifact_list`、`read`、`diff`、`export_to_path`，以及三个确定性的代码片段：`incident_note`、`onboarding_section` 和 `release_note`。 |

总计：**18 个基本组件 + 3 个打包模块 + 7 个工具 = 28 个**。

冻结状态：
- 18 个原子组件（原子组件 + 简报）。没有新的原子组件工具。
- 3 个打包模块。没有新的打包模块类型。
- 7 个工具层级。

完整的工具参考文档位于 [手册](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/tools/)。

---

## 安装

需要安装并运行 [Ollama](https://ollama.com)，并且需要下载相应的模型（参见下面的 [模型下载](#model-pulls)）。

### Claude Code (推荐)

大多数用户通过将其添加到 Claude Code MCP 服务器的配置文件中来安装此工具，无需全局安装。Claude Code 通过 `npx` 命令按需运行服务器。

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

与上述类似，写入到 `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) 或 `%APPDATA%\Claude\claude_desktop_config.json` (Windows)。

### 全局安装 (高级)

只有当您希望在 Claude Code 之外，将二进制文件添加到 `PATH` 环境变量中，以便进行临时使用时，才需要进行全局安装。

```bash
npm install -g ollama-intern-mcp
```

### 使用方法：与 Hermes 配合使用

此 MCP 已使用 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 对 `hermes3:8b` 模型进行了端到端的验证，并在 Ollama 上运行（日期：2026-04-19）。Hermes 是一个外部代理，它会 *调用* 此 MCP 的确定性基本组件接口，它负责规划，我们负责执行。

参考配置文件 ([hermes.config.example.yaml](hermes.config.example.yaml) 位于此仓库中)：

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

**提示的格式很重要。** 强制性的工具调用提示（例如：“调用 X，参数为…”）是集成测试，它为 8B 的本地模型提供了足够的结构，使其能够输出干净的 `tool_calls`。列表形式的多任务提示（例如：“执行 A，然后 B，然后 C”）是更大模型的性能基准。不要将 8B 模型上列表形式的失败解释为“底层连接出现问题”。请参阅 [手册/与 Hermes 配合使用](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/)，以获取完整的集成指南以及已知的传输注意事项（Ollama `/v1` 流式传输 + openai-SDK 非流式传输 shim）。

### 模型下载

**默认开发环境配置 (RTX 5080 16GB 及类似配置):**

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=-1
```

**Qwen 3 备选配置 (相同硬件，用于 Qwen 工具):**

```bash
ollama pull qwen3:8b
ollama pull qwen3:14b
ollama pull nomic-embed-text
export INTERN_PROFILE=dev-rtx5080-qwen3
```

**M5 Max 配置 (128GB 统一内存):**

```bash
ollama pull qwen3:14b
ollama pull qwen3:32b
ollama pull nomic-embed-text
export INTERN_PROFILE=m5-max
```

每个层级的环境变量 (`INTERN_TIER_INSTANT`、`INTERN_TIER_WORKHORSE`、`INTERN_TIER_DEEP`、`INTERN_EMBED_MODEL`) 仍然可以覆盖配置文件中的选择，用于临时使用。

---

## 统一接口

每个工具都返回相同的格式：

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

`residency` (驻留状态) 来自 Ollama 的 `/api/ps` 接口。当 `evicted: true` 或 `size_vram < size` 时，模型会被分页到磁盘，推理速度会下降 5-10 倍。将此信息显示给用户，以便他们知道需要重启 Ollama 或减少已加载的模型数量。

每个调用都会记录为一行 NDJSON 数据，写入到 `~/.ollama-intern/log.ndjson` 文件。通过 `hardware_profile` 过滤，以将开发环境的数据排除在可发布的基准测试之外。

---

## 硬件配置

| 配置 | 快速 | 工作马 | 深度 | 嵌入 |
|---|---|---|---|---|
| **`dev-rtx5080` (默认)** | hermes3 8B | hermes3 8B | hermes3 8B | nomic-embed-text |
| `dev-rtx5080-qwen3` | qwen3 8B | qwen3 8B | qwen3 14B | nomic-embed-text |
| `m5-max` | qwen3 14B | qwen3 14B | qwen3 32B | nomic-embed-text |

**默认开发模式** 将所有三个工作层级合并到 `hermes3:8b` 上，即经过验证的 Hermes Agent 集成路径。 采用相同的模型架构，从上到下，这意味着只需要一个模型，成本相同，行为也更容易理解。 那些更喜欢 Qwen 3（及其 `THINK_BY_SHAPE` 功能）的用户可以选择 `dev-rtx5080-qwen3`。 `m5-max` 是针对统一内存优化的 Qwen 3 版本。

---

## 证据相关规则

这些规则在服务器端执行，而不是在提示词中：

- **必须提供引用。** 每一个简短的陈述都必须引用一个证据 ID。
- **未知的 ID 会在服务器端被移除。** 如果模型引用了不在证据包中的 ID，这些 ID 会在结果返回之前被移除，并会显示警告。
- **验证的是 ID，而不是内容。** 服务器会检查每一个引用的 `evidence_ref` 是否指向一个有效的证据 ID。 它不会验证陈述文本是否可以从引用的证据中推导出来——这是模型的任务。 有时，简短的陈述可能包含未经支持的断言，但引用是有效的。 使用 `weak: true` + 覆盖说明 + 包含的 `excerpt` 字段进行检查。
- **“弱”就是“弱”。** 证据标记为 `weak: true` 时，会附带覆盖说明，不会被修改成虚假的叙述。
- **用于调查，而不是规定。** 仅提供 `next_checks` / `read_next` / `likely_breakpoints`。 提示词禁止使用“应用此修复”之类的指令。
- **确定性的渲染器。** 标记文本的形状是代码，而不是提示词。 `draft` 仍然保留用于需要模型进行措辞调整的文本。
- **仅支持同一包的差异比较。** 跨包的 `artifact_diff` 会被明确拒绝；每个包的数据是独立的。

---

## 数据和连续性

每个包会将数据写入 `~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)`。 数据层为您提供数据连续性的保障，但它不是一个文件管理工具：

- `artifact_list`：仅包含元数据的索引，可以按包、日期、slug glob 进行过滤。
- `artifact_read`：按 `{pack, slug}` 或 `{json_path}` 进行类型读取。
- `artifact_diff`：对同一包的结构化比较，会显示“弱”级别的差异。
- `artifact_export_to_path`：将现有数据（包含来源信息头）写入调用者指定的 `allowed_roots`。 如果文件已存在，除非 `overwrite: true`，否则会拒绝写入。
- `artifact_incident_note_snippet`：操作员备注片段。
- `artifact_onboarding_section_snippet`：入门指南片段。
- `artifact_release_note_snippet`：草稿版本的发布说明片段。

此层级中没有模型调用。 所有数据都从存储的内容中读取。

---

## 安全模型和遥测

**访问的数据：** 调用者明确提供的文件路径（`ollama_research`、语料库工具），内联文本，以及调用者请求写入到 `~/.ollama-intern/artifacts/` 或调用者指定的 `allowed_roots` 的数据。

**未访问的数据：** 任何位于 `source_paths` / `allowed_roots` 之外的数据。 `..` 在归一化之前会被拒绝。 `artifact_export_to_path` 会拒绝写入已存在的文件，除非 `overwrite: true`。 针对受保护路径（`memory/`、`.claude/`、`docs/canon/` 等）的草稿需要明确指定 `confirm_write: true`，并在服务器端强制执行。

**网络出站流量：** **默认情况下禁用。** 唯一的出站流量是到本地 Ollama HTTP 端点。 不会进行任何云端调用、更新提示或崩溃报告。

**遥测：** **无。** 每次调用都会被记录为一行 NDJSON 数据，写入到您机器上的 `~/.ollama-intern/log.ndjson` 文件。 没有任何数据会离开本地。

**错误：** 结构化的错误信息，格式为 `{ code, message, hint, retryable }`。 堆栈跟踪信息不会通过工具结果暴露。

完整策略：[SECURITY.md](SECURITY.md)。

---

## 标准

遵循 [Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck) 标准。 通过 A-D 级别的测试；请参阅 [SHIP_GATE.md](SHIP_GATE.md) 和 [SCORECARD.md](SCORECARD.md)。

- **A. 安全性** — SECURITY.md，威胁模型，无遥测功能，路径安全，对受保护路径使用 `confirm_write`。
- **B. 错误** — 所有工具结果采用结构化格式；不包含原始堆栈信息。
- **C. 文档** — README（当前版本），CHANGELOG，LICENSE；工具的 schema 自带文档。
- **D. 规范性** — `npm run verify`（完整的 vitest 测试套件），CI 包含依赖项扫描，Dependabot，lockfile，`engines.node`。

---

## 路线图（加强现有功能，而非扩大范围）

- **第一阶段 — 授权核心** ✓ 已完成：atom 界面，统一的封装方式，分层路由，安全机制。
- **第二阶段 — 真实性核心** ✓ 已完成：schema v2 分块，BM25 + RRF，动态语料库，基于证据的简报，检索评估工具包。
- **第三阶段 — 打包与制品核心** ✓ 已完成：具有持久制品和连续性层的固定流水线打包。
- **第四阶段 — 采用核心** ✓ v2.0.1：三阶段健康检查，强化语料库（防止时间窗口攻击，文件大小限制为 50MB，拒绝符号链接，原子写入，每个文件失败捕获），工具路径遍历，可观察性（信号量等待事件，超时错误上下文，配置文件覆盖日志，预热冷启动信号），测试安全性（跨 10 个文件进行模块加载环境快照，`tools/call` 端到端测试）。为操作员添加了故障排除手册和硬件最低要求。
- **第五阶段 — M5 Max 性能基准测试** — 硬件到位后发布可公开的性能数据（预计 2026 年 4 月 24 日左右）。

阶段划分基于安全加固层。atom/pack/artifact 接口保持不变。

---

## 许可证

MIT — 参见 [LICENSE](LICENSE)。

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
