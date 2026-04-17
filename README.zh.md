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

**Claude Code 的本地实习生。** 28 个工具，以证据为基础的简报，持久的成果。

一个 MCP 服务器，为 Claude Code 提供一个**本地实习生**，它具有规则、层级、办公桌和文件柜。Claude 选择 _工具_；工具选择 _层级_（即时/工作型/深度/嵌入）；层级会生成一个文件，您可以在下周打开它。

无云。无遥测。没有任何“自主”功能。每个调用都会显示其工作过程。

---

## 示例：一个调用，一个成果

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

返回一个指向磁盘上文件的“信封”：

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

该 Markdown 文件是实习生的办公桌输出，包含标题、带有引用的证据块、用于后续检查的 `next_checks`，以及如果证据不足则显示 `weak: true` 的提示。它具有确定性：渲染器是代码，而不是提示。明天打开它，下周进行差异比较，然后使用 `ollama_artifact_export_to_path` 将其导出到手册中。

在这个类别中的每个竞争对手都以“节省令牌”为卖点。我们以 _这里是实习生编写的文件_ 为卖点。

---

## 内容：四个层级，28 个工具

| 层级 | 数量 | 包含的内容 |
|---|---|---|
| **Atoms** | 15 | 具有工作功能的原始模块。`classify`（分类）、`extract`（提取）、`triage_logs`（日志分级）、`summarize_fast` / `deep`（快速/深度摘要）、`draft`（草稿）、`research`（研究）、`corpus_search`（语料库搜索）/ `answer`（回答）/ `index`（索引）/ `refresh`（刷新）/ `list`（列表）、`embed_search`（嵌入式搜索）、`embed`（嵌入）、`chat`（聊天）。支持批量处理的原子模块（`classify`、`extract`、`triage_logs`）接受 `items: [{id, text}]`。 |
| **Briefs** | 3 | 基于证据的结构化简报。`incident_brief`（事件简报）、`repo_brief`（仓库简报）、`change_brief`（变更简报）。每个声明都引用一个证据 ID；未知的条目在服务器端被删除。如果证据不足，会显示 `weak: true`，而不是虚假的叙述。 |
| **Packs** | 3 | 固定流水线，用于生成持久的 Markdown + JSON 文件，保存在 `~/.ollama-intern/artifacts/` 目录下。`incident_pack`（事件包）、`repo_pack`（仓库包）、`change_pack`（变更包）。具有确定性的渲染器，不会对成果形状进行模型调用。 |
| **Artifacts** | 7 | 提供对包输出的统一界面。`artifact_list`（成果列表）/ `read`（读取）/ `diff`（差异比较）/ `export_to_path`（导出到路径），以及三个确定性的片段：`incident_note`（事件说明）、`onboarding_section`（入职部分）、`release_note`（发布说明）。 |

总计：**18 个原始模块 + 3 个包 + 7 个成果工具 = 28 个**。

冻结的模块：
- 原始模块冻结在 18 个（原始模块 + 简报）。没有新的原始模块工具。
- 包冻结在 3 个。没有新的包类型。
- 成果层级冻结在 7 个。

完整的工具参考位于 [手册](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/reference/) 中。

---

## 安装

```bash
npm install -g ollama-intern-mcp
```

需要安装 [Ollama](https://ollama.com)，并且已下载相应的模型。

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

相同的配置块，写入到 `~/Library/Application Support/Claude/claude_desktop_config.json`（macOS）或 `%APPDATA%\Claude\claude_desktop_config.json`（Windows）。

### 模型下载

**默认开发环境 (RTX 5080 16GB 及类似配置):**

```bash
ollama pull qwen2.5:7b-instruct-q4_K_M
ollama pull qwen2.5-coder:7b-instruct-q4_K_M
ollama pull qwen2.5:14b-instruct-q4_K_M
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=4
export OLLAMA_KEEP_ALIVE=-1
```

**M5 Max 环境 (128GB 统一内存):**

```bash
ollama pull qwen2.5:14b-instruct-q4_K_M
ollama pull qwen2.5-coder:32b-instruct-q4_K_M
ollama pull llama3.3:70b-instruct-q4_K_M
ollama pull nomic-embed-text
export INTERN_PROFILE=m5-max
```

每个层级的环境变量（`INTERN_TIER_INSTANT`、`INTERN_TIER_WORKHORSE`、`INTERN_TIER_DEEP`、`INTERN_EMBED_MODEL`）仍然可以覆盖配置文件，用于一次性使用。

---

## 统一的“信封”

每个工具都返回相同的结构：

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

`residency`（驻留状态）来自 Ollama 的 `/api/ps`。当 `evicted: true` 或 `size_vram < size` 时，模型会被分页到磁盘，推理速度下降 5-10 倍。向用户显示此信息，以便他们知道需要重启 Ollama 或减少已加载的模型数量。

每个调用都会记录为一行 NDJSON 数据，保存在 `~/.ollama-intern/log.ndjson` 中。通过 `hardware_profile` 进行过滤，以将开发环境的数据排除在可发布的基准测试之外。

---

## 硬件配置文件

| 配置文件 | 即时 | 工作型 | 深度 | 嵌入 |
|---|---|---|---|---|
| **`dev-rtx5080`**（默认） | qwen2.5 7B | qwen2.5-coder 7B | qwen2.5 14B | nomic-embed-text |
| `dev-rtx5080-llama` | qwen2.5 7B | qwen2.5-coder 7B | **llama3.1 8B** | nomic-embed-text |
| `m5-max` | qwen2.5 14B | qwen2.5-coder 32B | llama3.3 70B | nomic-embed-text |

**同一系列模型在默认开发环境下的表现** 如果输出结果不理想，通常是工具或设计问题，而不是不同系列模型之间的不兼容。`dev-rtx5080-llama` 是一个基准，在将 Llama 模型部署到 M5 Max 之前，应该先在 Llama 8B 上运行相同的评估。

---

## 证据法

这些规则在服务器端执行，而不是在提示词中：

- **必须提供引用。** 每一个简短的陈述都必须引用一个证据 ID。
- **未知内容在服务器端被移除。** 如果模型引用了不在证据包中的 ID，这些 ID 会在返回结果之前被移除，并会显示警告。
- **“弱”的证据就是“弱”的。** 弱证据会用 `weak: true` 标记，并附带说明。不会将其伪装成完整的叙述。
- **用于调查，而非提供指令。** 仅限于 `next_checks` / `read_next` / `likely_breakpoints`。 提示词禁止使用“应用此修复”。
- **确定性的渲染器。** 标记的文本格式是代码，而不是提示词。`draft` 仍然保留用于需要模型进行措辞调整的文本。
- **仅限同一包的差异。** 跨包的 `artifact_diff` 会被明确拒绝；每个包的数据保持独立。

---

## 工件与连续性

每个包会将数据写入到 `~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)`。 工件层提供了一个连续性界面，但不会将其变成一个文件管理工具：

- `artifact_list` — 仅包含元数据的索引，可以按包、日期、slug 进行过滤。
- `artifact_read` — 通过 `{pack, slug}` 或 `{json_path}` 进行类型读取。
- `artifact_diff` — 对同一包的结构化比较；会显示弱化情况。
- `artifact_export_to_path` — 将现有工件（包含来源信息头）写入到调用者声明的 `allowed_roots`。 除非 `overwrite: true`，否则会拒绝写入已存在的文件。
- `artifact_incident_note_snippet` — 操作员备注片段。
- `artifact_onboarding_section_snippet` — 引导手册片段。
- `artifact_release_note_snippet` — DRAFT 版本说明片段。

此层中没有模型调用。 所有内容都从存储的内容中渲染。

---

## 安全模型与遥测

**访问的数据：** 调用者明确传递的文件路径（`ollama_research`、语料库工具），内联文本，以及调用者请求写入到 `~/.ollama-intern/artifacts/` 或调用者声明的 `allowed_roots` 的工件。

**未访问的数据：** 任何位于 `source_paths` / `allowed_roots` 之外的数据。 `..` 会在归一化之前被拒绝。 除非 `overwrite: true`，否则 `artifact_export_to_path` 会拒绝写入已存在的文件。 针对受保护路径（`memory/`、`.claude/`、`docs/canon/` 等）的草稿需要明确声明 `confirm_write: true`，并在服务器端强制执行。

**网络出站：** **默认情况下禁用。** 唯一的外部流量是发送到本地 Ollama HTTP 端点。 不会进行任何云端调用、更新提示或崩溃报告。

**遥测：** **无。** 每次调用都会被记录为一行 NDJSON 数据，写入到你的机器上的 `~/.ollama-intern/log.ndjson`。 没有任何数据会离开本地。

**错误：** 结构化格式为 `{ code, message, hint, retryable }`。 堆栈跟踪永远不会通过工具结果暴露。

完整策略：[SECURITY.md](SECURITY.md)。

---

## 标准

遵循 [Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck) 标准。 通过 A–D 级别的硬性检查；请参阅 [SHIP_GATE.md](SHIP_GATE.md) 和 [SCORECARD.md](SCORECARD.md)。

- **A. 安全性** — SECURITY.md，安全模型，无遥测，路径安全，针对受保护路径使用 `confirm_write`
- **B. 错误** — 所有工具结果的结构化格式；不暴露原始堆栈信息
- **C. 文档** — README 保持最新，CHANGELOG，LICENSE；工具模式具有自文档功能
- **D. 清洁性** — `npm run verify` (395 个测试)，CI 包含依赖项扫描，Dependabot，lockfile，`engines.node`

---

## 路线图（重点是增强安全性，而非范围扩大）

- **第一阶段 — 授权核心** 已完成：原子层、统一接口、分层路由、安全措施。
- **第二阶段 — 真实性核心** 已完成：模式 v2 分块、BM25 + RRF、动态语料库、基于证据的简报、检索评估工具包。
- **第三阶段 — 软件包和工件核心** 已完成：具有持久工件和连续性层的固定流水线软件包。
- **第四阶段 — 采用核心** 正在进行：在 RTX 5080 上进行实际使用观察，并优化出现的问题。
- **第五阶段 — M5 Max 性能基准测试** 计划发布：硬件到位后，发布可公开的性能数据（预计 2026 年 4 月 24 日）。

各阶段以安全增强层为基础进行。原子层、软件包和工件接口保持不变。

---

## 许可证

MIT 协议 — 参见 [LICENSE](LICENSE)。

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
