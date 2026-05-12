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

一个 MCP 服务器，为 Claude Code 提供一个**本地实习生**，它具有规则、层级、办公桌和文件柜。Claude 选择 _工具_；工具选择 _层级_（即时/工作马/深度/嵌入）；层级会生成一个文件，您可以在下周打开。

**同时运行 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 在 `hermes3:8b` 上** — 已于 2026 年 4 月 19 日进行端到端验证。默认层级是 `hermes3:8b`；`qwen3:*` 是备选方案。请参阅下面的 [与 Hermes 的使用](#use-with-hermes)。

**硬件要求：** `hermes3:8b` 需要约 6 GB 的 VRAM，或者 CPU 推理需要约 16 GB 的 RAM。请参阅 [handbook/getting-started](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/getting-started/#hardware-minimums) 以获取详细信息。

**不使用 Claude？** `examples/` 目录包含一个最小的 Node.js 和 Python MCP 客户端，可以通过 stdio 启动。另请参阅 [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/)。

无云服务。无遥测。没有任何“自主”功能。每个调用都会显示其工作过程。

---

## 新功能，版本 2.3.0

在基于 LLM 的原子工具中，实现了每个调用的模型覆盖。这是一个小版本更新，不会影响 v2.2.0 的调用者。详细信息请参阅 [CHANGELOG.md](./CHANGELOG.md) 和 [docs/release-notes/v2.3.0.md](./docs/release-notes/v2.3.0.md)。

- **8 个原子工具的 `model: string` 可选输入** — `ollama_extract`, `ollama_classify`, `ollama_summarize_fast`, `ollama_summarize_deep`, `ollama_research`, `ollama_corpus_answer`, `ollama_chat`, `ollama_code_citation`。 首次尝试使用工具的层级时，会使用调用者指定的模型；如果超时，则现有的 `TIER_FALLBACK` 机制会解析更低层级的模型（而不是调用者的覆盖）。 组合/简报/打包工具故意不接受 `model` 参数 — 原子工具可以进行每个调用的控制，而组合工具使用默认层级。
- **新的 envelope 字段 `model_requested?: string`** — 仅在提供了覆盖时才存在。 经过校准的调用者将 `model_requested` 与 `model` 进行比较，以检测回退替换：`if (env.model_requested && env.model !== env.model_requested) { /* substitution */ }`。 空输入或仅包含空格的输入会引发 `ZodError` 错误，而不是静默地跳过。
- **Bug 修复 — `src/version.ts` 的版本信息错误。** 运行时 `VERSION` 常量现在从模块加载时读取 `package.json` 中的值；v2.1.0 和 v2.2.0 报告了过时的 `"2.0.0"` 字符串。 新的 `tests/version.test.ts` 确保 `VERSION === pkg.version`。

### 每个调用的模型覆盖（新功能，版本 2.3.0）

```jsonc
{
  "tool": "ollama_classify",
  "arguments": {
    "text": "patch null pointer in auth",
    "labels": ["feat", "fix", "chore"],
    "frame": "what is the change kind?",
    "model": "hermes3:8b"
  }
}
```

Envelope:

```jsonc
{
  "result": { "label": "fix", "confidence": 0.9, "off_topic": false, ... },
  "tier_used": "instant",
  "model": "hermes3:8b",
  "model_requested": "hermes3:8b",       // present because override was supplied
  // ... rest of envelope unchanged
}
```

如果工作马/深度层级超时，并且调用已回退到即时层级，则 `env.model` 将是即时层级的解析模型，并且 `env.fallback_from` 将是 `"workhorse"` — `env.model_requested` 仍然是 `"hermes3:8b"`，并且 `env.model !== env.model_requested` 是替换的信号。 覆盖不会传递到更低层级；所选的模型可能完全不适合该层级的角色。

### 历史 — v2.2.0 的功能

请参阅 [CHANGELOG.md](./CHANGELOG.md) 和 [docs/release-notes/v2.2.0.md](./docs/release-notes/v2.2.0.md) 以获取 v2.2.0 的完整信息（基于上下文的主题性和结构化拒绝）。

## 新功能，版本 2.2.0

本地证据处理器的角色规范：基于上下文的主题性和结构化拒绝。 这是一个小版本更新，不会影响 v2.1.0 的调用者。 详细信息请参阅 [CHANGELOG.md](./CHANGELOG.md) 和 [docs/release-notes/v2.2.0.md](./docs/release-notes/v2.2.0.md)。

- **基于上下文的提取**：`ollama_extract`、`ollama_classify`、`ollama_summarize_fast`、`ollama_summarize_deep` - 可选的 `frame: string` 输入，以及结构化的 `frame_alignment` / `on_topic` / `frame_addressed` 输出。与主题无关的来源不会被重述到 schema 中，而是会被标记。
- **结构化拒绝**：`ollama_research` - `weak` / `abstained` / `sources_address_question` 字段。即使 `answer` 不为空，`citations[]` 字段为空也不再被视为成功。
- **主题相关性阈值**：`ollama_corpus_answer` - 可选的 `min_top_score`。如果低于阈值，工具会直接拒绝 (`abstained: true`) 并跳过合成过程。每个引用的 `score` 现在在每个引用中都可见。
- **检索分数保留**：通过简要的证据 - `corpusHitsToEvidence` 包含 `score` (以及 `corpus_min_evidence_score` 参数，用于在 `incident_brief` / `repo_brief` / `change_brief` 的组装阶段进行过滤)。
- **引用范围限制**：`guardrails/citations.ts` 拒绝 `ollama_research` 中超出范围的引用，这与 `ollama_code_citation` 的现有策略一致。
- **操作文档校正**：README 文件中的 `chunk_id`/`chunk_index` 已修复，"validated server-side" 已重写，"Evidence Laws" 部分已进行限定，营销口号已添加注释。

### 回归测试 — 验证过程

该切片的合约已针对 "research-os" 的全新版本进行验证，以重现以下问题：arxiv 2112.10422 (Cosmological Standard Timers)，在 section-01 框架 *"What does evidence custody mean in local-first vs cloud LLM deep-research workflows?"* 下。9 个 mocked-LLM 合约测试确认，与主题无关的来源现在已被包含 (`frame_alignment.on_topic = false` 在 extract 中; `off_topic: true` 在 classify 中; `frame_addressed: false` 在 summarize_deep 中; `abstained: true` 在 corpus_answer 中，并且 `min_top_score` 已设置)。

### 历史版本 — v2.1.0 的交付成果

请参阅 [CHANGELOG.md](./CHANGELOG.md) 以获取 v2.1.0 的完整更新内容（功能更新：13 个新工具 + 4 个改进 + 冻结版本）。

---

## 示例 — 一个调用，一个结果

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

→ `weak: false` 表示已收集到 ≥2 个证据项；但这并不意味着假设已经过验证。请参阅下面的 [Evidence laws](#evidence-laws)。

该 markdown 文件是实习生生成的输出 — 包含标题、带有引用 ID 的证据块、用于后续检查的 `next_checks`，以及如果证据不足时显示的 `weak: true` 提示。它是确定的：渲染器是代码，而不是提示。 (渲染器是确定的；假设和表面的 *内容* 是生成的——将其视为草稿，而不是经过验证的内容。) 稍后打开它，下周进行差异比较，并使用 `ollama_artifact_export_to_path` 将其导出到手册中。

在这个类别中的每个竞争对手都以 "节省令牌" 为口号。我们以 _这里是实习生编写的文件_ 为口号。

### 第二个示例 — 构建一个语料库，然后进行提问

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

服务器验证引用的身份，并确保每个 `chunk_index` 都在检索到的结果范围内。但这并不能证明生成的每个声明都由引用的 chunk 内容在语义上支持——这是模型的责任，即使是弱检索也可能产生带有引用形状的答案。完整的操作指南请参阅 [handbook/corpora](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/corpora/)。

---

## 基于上下文的提取 (v2.2.0 新增)

`ollama_extract`、`ollama_classify`、`ollama_summarize_fast` 和 `ollama_summarize_deep` 接受一个可选的 `frame: string` 输入。`frame` 指的是来源被要求回答的问题；如果来源没有涉及该框架，模型将指示拒绝，而不是输出虽然正确但与主题无关的内容。

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

如果省略 `frame` 参数，行为将保持与 v2.1.0 版本相同。如果提供了 `frame` 参数，`frame_alignment.on_topic = false` 表示提取的字段可能与原始数据相关，但可能与当前上下文不相关。在这种情况下，将其视为 `weak: true` 的一种情况：有用，但需要仔细检查后再将其用于后续的证据生成。

---

## 弃权协议（新功能，v2.2.0 版本）

`ollama_research` 返回结构化的弃权字段：`weak: boolean`（弱提示），`abstained: boolean`（是否弃权），`sources_address_question: boolean | null`（来源是否回答了问题）。如果 `citations[]` 为空，但 `answer` 不为空，则不会再保持沉默，`abstained: true` 表示模型拒绝生成结果，因为调用者提供的路径没有回答问题。将弃权视为成功，而不是失败：它表示工具拒绝将弱检索结果转化为权威输出。

`ollama_corpus_answer` 接受一个可选的 `min_top_score: number` 主题相关性阈值（0.0–1.0）。当查询的最高检索分数低于 `min_top_score` 时，该工具会立即停止并返回 `abstained: true`，并跳过生成过程，从而避免出现“即使有 5 个不相关的内容，但分数仅为 0.21，仍然会生成完整的答案”的情况，而 v2.1.0 版本的 `weak: true` 规则无法捕捉到这种情况（`weak: true` 仅在 `hits.length < 2` 时才生效）。结合每个引用的 `score` 字段，可以直接从结果中审计检索质量。

---

## 这里包含的内容：四个层级，41 个工具

**任务型**：这意味着每个工具都代表一个您可以交给实习生的任务，例如：对这进行分类，提取那，对这些日志进行分级，起草这份发布说明，打包这个事件。工具的输入是任务规范，输出是交付成果。没有通用的 `run_model` / `chat_with_llm` 基础功能。

| 层级 | 数量 | 包含的内容 |
|---|---|---|
| **Atoms** | 15 | 任务型基础功能。`classify`（分类），`extract`（提取），`triage_logs`（日志分级），`summarize_fast` / `deep`（快速/深度摘要），`draft`（起草），`research`（研究），`corpus_search`（语料库搜索），`answer`（回答），`index`（索引），`refresh`（刷新），`list`（列表），`embed_search`（嵌入搜索），`embed`（嵌入），`chat`（聊天）。支持批量处理的基础功能（`classify`、`extract`、`triage_logs`）接受 `items: [{id, text}]` 格式的输入。 |
| **Briefs** | 3 | 基于证据的结构化操作说明。`incident_brief`（事件说明），`repo_brief`（仓库说明），`change_brief`（变更说明）。每个声明都引用一个证据 ID；未知信息在服务器端被移除。弱证据会显示 `weak: true`，而不是虚构的叙述。 |
| **Packs** | 3 | 将持久的 Markdown + JSON 写入到 `~/.ollama-intern/artifacts/` 目录中的复合任务。`incident_pack`（事件打包），`repo_pack`（仓库打包），`change_pack`（变更打包）。具有确定性的渲染器，不会在生成结果时调用任何模型。 |
| **Artifacts** | 7 | 在打包结果之上构建的连续性界面。`artifact_list`（工件列表），`read`（读取），`diff`（差异），`export_to_path`（导出到路径），以及三个确定性的片段：`incident_note`（事件说明），`onboarding_section`（入职部分），`release_note`（发布说明）。 |

总计：**18 个基础功能 + 3 个打包工具 + 7 个工件工具 = 28 个**。

冻结的组件：
- 基础功能冻结在 18 个（基础功能 + 说明）。没有新的基础功能工具。
- 打包工具冻结在 3 个。没有新的打包工具类型。
- 工件层级冻结在 7 个。

完整的工具参考文档位于 [手册](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/tools/)。

---

## 安装

需要安装 [Ollama](https://ollama.com) 并运行本地，以及下载所需的模型（请参阅下面的 [模型下载](#model-pulls)）。

### Claude Code (推荐)

大多数用户通过将其添加到 Claude Code MCP 服务器的配置文件中来安装此工具，无需全局安装。Claude Code 会根据需要通过 `npx` 命令运行服务器。

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

与上述相同，写入到 `~/Library/Application Support/Claude/claude_desktop_config.json`（macOS）或 `%APPDATA%\Claude\claude_desktop_config.json`（Windows）。

### 全局安装（高级）

只有当您希望在 Claude Code 之外，通过 ad-hoc 使用将二进制文件添加到您的 `PATH` 环境变量时，才需要进行全局安装：

```bash
npm install -g ollama-intern-mcp
```

### 使用与 Hermes 配合

此 MCP（模型控制点）已使用 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 在 Ollama 上的 `hermes3:8b` 模型上进行了端到端验证（2026-04-19）。Hermes 是一个外部代理，它*调用*此 MCP 的冻结的原始表面接口——它负责规划，我们负责执行。

参考配置（此仓库中的 [hermes.config.example.yaml](hermes.config.example.yaml)）：

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

**提示的结构很重要。** 强制性的工具调用提示（例如：“调用 X，参数为……”）是集成测试，它为 8B 的本地模型提供了足够的结构，使其能够生成清晰的 `tool_calls`。列表形式的多任务提示（例如：“执行 A，然后 B，然后 C”）是更大模型的性能基准；不要将 8B 模型上列表形式的失败解释为“连接出现问题”。请参阅 [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/)，了解完整的集成指南以及已知的传输注意事项（Ollama `/v1` 流式传输 + openai-SDK 非流式传输 shim）。

### 模型下载

**默认开发配置 (RTX 5080 16GB 及类似配置):**

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=-1
```

**Qwen 3 替代方案 (相同硬件，用于 Qwen 工具):**

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

每个层级的环境变量 (`INTERN_TIER_INSTANT`, `INTERN_TIER_WORKHORSE`, `INTERN_TIER_DEEP`, `INTERN_EMBED_MODEL`) 仍然可以覆盖配置文件，用于一次性配置。

---

## 统一的接口

每个工具都返回相同的结构：

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

`residency`（驻留状态）来自 Ollama 的 `/api/ps` 接口。当 `evicted: true`（已驱逐）或 `size_vram < size`（VRAM 大小小于模型大小）时，模型会被分页到磁盘，推理速度会下降 5-10 倍。请将此信息显示给用户，以便他们知道需要重启 Ollama 或减少加载的模型数量。

每个调用都会记录为一行 NDJSON 数据，保存在 `~/.ollama-intern/log.ndjson` 文件中。通过 `hardware_profile` 进行过滤，以防止开发环境的指标影响可发布的基准测试。

---

## 硬件配置

| 配置 | Instant | Workhorse | Deep | Embed |
|---|---|---|---|---|
| **`dev-rtx5080`** (默认) | hermes3 8B | hermes3 8B | hermes3 8B | nomic-embed-text |
| `dev-rtx5080-qwen3` | qwen3 8B | qwen3 8B | qwen3 14B | nomic-embed-text |
| `m5-max` | qwen3 14B | qwen3 14B | qwen3 32B | nomic-embed-text |

**默认开发配置** 将所有三个工作层都映射到 `hermes3:8b`，这是经过验证的 Hermes Agent 集成路径。使用相同的模型可以简化操作，减少资源消耗，并更容易理解其行为。 喜欢使用 Qwen 3（及其 `THINK_BY_SHAPE` 功能）的用户可以选择 `dev-rtx5080-qwen3` 配置。 `m5-max` 配置是为统一内存量设计的 Qwen 3 版本。

---

## 证据规则

这些规则在服务器端强制执行，而不是在提示中：

- **必须提供引用。** 每个简短的声明都必须引用一个证据 ID。
- **服务器端删除未知内容。** 如果模型引用了不在证据包中的 ID，则服务器会在结果返回之前删除这些 ID，并发出警告。
- **验证 ID，而不是验证内容。** 服务器会检查每个引用的 `evidence_ref` 是否指向已组装集合中的有效证据 ID。 它不会验证声明文本是否可以从引用的证据中推断出来——这是模型的任务。 有时，简短的声明可能包含未经证实的说法，但引用是有效的。 使用 `weak: true` + `coverage_notes` + 包含的 `excerpt` 字段进行检查。
- **“弱”就是“弱”。** 证据标记为 `weak: true`，并附带覆盖说明。 永远不会将其融入虚假的叙述中。
- **用于调查，而不是用于规定。** 仅提供 `next_checks` / `read_next` / `likely_breakpoints`。 提示中禁止使用“应用此修复”。
- **确定性的渲染器。** 标记的 Markdown 结构是代码，而不是提示。 `draft` 仍然保留用于需要模型措辞的文本。
- **仅限同一包的差异。** 拒绝跨包的 `artifact_diff`；每个包的数据保持独立。

---

## 工件和连续性

Packs 将数据写入到 `~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)` 目录。 这种架构提供了一种连续性，而无需将其变成一个文件管理工具：

- `artifact_list`：仅包含元数据的索引，可以按 pack、日期、slug 进行过滤。
- `artifact_read`：按 `{pack, slug}` 或 `{json_path}` 读取数据。
- `artifact_diff`：对同一 pack 进行结构化比较，并显示潜在问题。
- `artifact_export_to_path`：将现有数据（包含来源信息头）写入到调用者指定的 `allowed_roots` 目录。 除非 `overwrite: true`，否则拒绝写入已存在的文件。
- `artifact_incident_note_snippet`：操作员备注片段。
- `artifact_onboarding_section_snippet`：新手指南片段。
- `artifact_release_note_snippet`：草稿版本的发布说明片段。

此层级中没有模型调用。 所有内容都从存储的数据中渲染。

---

## 威胁模型和遥测

**访问的数据：** 调用者明确提供的文件路径（`ollama_research`、语料库工具），内联文本，以及调用者请求写入到 `~/.ollama-intern/artifacts/` 目录或调用者指定的 `allowed_roots` 目录的数据。

**未访问的数据：** 任何位于 `source_paths` / `allowed_roots` 之外的数据。 `..` 会在标准化之前被拒绝。 `artifact_export_to_path` 除非 `overwrite: true`，否则拒绝写入已存在的文件。 针对受保护路径（`memory/`, `.claude/`, `docs/canon/` 等）的草稿需要明确设置 `confirm_write: true`，并在服务器端强制执行。

**网络出站流量：** **默认情况下禁用。** 唯一的出站流量是发送到本地 Ollama HTTP 端点。 不会进行任何云端调用、更新检查或崩溃报告。

**遥测：** **无。** 每次调用都会记录为一条 NDJSON 行，写入到您机器上的 `~/.ollama-intern/log.ndjson` 文件。 没有任何数据会离开本地。

**错误：** 结构化的错误信息，格式为 `{ code, message, hint, retryable }`。 堆栈跟踪信息不会通过工具结果暴露。

完整策略：[SECURITY.md](SECURITY.md)。

---

## 标准

遵循 [Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck) 标准。 通过 A-D 级别的检查；请参阅 [SHIP_GATE.md](SHIP_GATE.md) 和 [SCORECARD.md](SCORECARD.md)。

- **A. 安全性**：SECURITY.md，威胁模型，无遥测，路径安全，针对受保护路径使用 `confirm_write`。
- **B. 错误**：所有工具结果都采用结构化格式；不暴露原始堆栈信息。
- **C. 文档**：README、CHANGELOG、LICENSE；工具模式具有自文档功能。
- **D. 稳定性**：`npm run verify`（完整的 vitest 测试套件），CI 包含依赖项扫描，Dependabot，lockfile，`engines.node`。

---

## 路线图（加强，而非范围扩展）

- **第一阶段 — 委托核心** ✓ 已完成：原子表面，统一接口，分层路由，安全防护。
- **第二阶段 — 真实性核心** ✓ 已完成：模式 v2 分块，BM25 + RRF，动态语料库，基于证据的简报，检索评估 pack。
- **第三阶段 — Pack 和 Artifact 核心** ✓ 已完成：具有持久数据的固定流水线 pack，以及连续性层。
- **第四阶段 — 采用核心** ✓ v2.0.1：三阶段健康检查，强化语料库（TOCTOU，50 MB 文件大小限制，符号链接拒绝，原子写入，每个文件失败捕获），工具路径遍历，可观察性（信号量等待事件，超时错误上下文，配置文件覆盖日志，预热冷启动信号），测试安全性（跨 10 个文件进行模块加载环境快照，`tools/call` 端到端测试）。 为操作员添加了故障排除手册和硬件最低要求。
- **第五阶段 — M5 Max 基准测试** — 在硬件到位后发布可公开的指标（预计 2026 年 4 月 24 日）。

按加强层级进行。 原子/pack/artifact 表面保持不变。

---

## 许可证

MIT — 参见 [LICENSE](LICENSE)。

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
