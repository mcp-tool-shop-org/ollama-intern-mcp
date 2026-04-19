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

**Claude Code 的本地实习生。** 28 种实用工具，以证据为基础的简报，以及经久耐用的成果。

一个名为“MCP”的服务器，为“Claude Code”提供了一个“本地实习生”角色，该角色拥有规则、等级、办公桌和文件柜。 “Claude”选择“工具”；“工具”选择“等级”（分为“即时”、“工作马”、“深度”和“嵌入”）；“等级”会生成一个文件，您可以在下周打开查看。

没有云服务。没有远程数据传输。没有任何“自动”功能。每一次操作都能清楚地看到其工作原理。

---

## 示例：一个请求，一个成果

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

返回一个指向磁盘上文件的“信封”对象。

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

该 Markdown 文件是实习人员工作台的输出结果，包括标题、带有引用的证据块，以及如果证据不足时显示的“弱：true”提示。它的生成过程是确定的：渲染器是代码，而不是提示。明天打开它，下周进行差异比较，然后使用 `ollama_artifact_export_to_path` 命令将其导出到手册中。

在这个类别中，所有竞争对手都以“节省令牌”为宣传重点。而我们则强调的是：“这是实习生撰写的文档。”

---

## 这里包含四层，共28件工具

| 等级；层级。 | 计数。 | 这里住着什么？ |
|---|---|---|
| **Atoms** | 15 | 以下是一些预定义的任务类型：`classify`（分类）、`extract`（提取）、`triage_logs`（日志分析）、`summarize_fast` / `deep`（快速/深度摘要）、`draft`（起草）、`research`（研究）、`corpus_search` / `answer`（语料库搜索/回答）、`index`（索引）、`refresh`（刷新）、`list`（列表）、`embed_search`（嵌入式搜索）、`embed`（嵌入）、`chat`（聊天）。 能够处理批处理任务的模块（`classify`、`extract`、`triage_logs`）接受以下格式的输入：`items: [{id, text}]`。 |
| **Briefs** | 3 | 基于证据的、结构化的操作简报。包括“事件简报”、“报告简报”和“变更简报”等类型。每个论点都引用了证据ID；未知信息在服务器端进行处理并被移除。对于证据不足的情况，会标记为“证据不足：true”，而不是捏造虚假信息。 |
| **Packs** | 3 | 固定流水线任务，用于将持久化的 Markdown 和 JSON 数据写入到 `~/.ollama-intern/artifacts/` 目录。这些任务包括 `incident_pack`、`repo_pack` 和 `change_pack`。这些渲染过程是确定性的，不会对生成的artifact进行任何模型调用。 |
| **Artifacts** | 7 | 针对打包输出结果，提供连续性信息。包含以下内容：`artifact_list`（工件列表）、`read`（读取）、`diff`（差异）、`export_to_path`（导出到路径），以及三个确定性的片段：`incident_note`（事件记录）、`onboarding_section`（入职指南）和 `release_note`（发布说明）。 |

总计：**18 个基础物品 + 3 个礼包 + 7 件工具 = 28 件**。

冻结内容：
- 原子：已冻结在18个（包括原子和简易版）。 不会增加新的原子工具。
- 组装包：已冻结在3个。 不会增加新的组装包类型。
- 遗物等级：已冻结在7级。

完整的工具参考资料请查阅[手册](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/reference/)。

---

## 安装

```bash
npm install -g ollama-intern-mcp
```

需要安装并运行本地的 [Ollama](https://ollama.com) 软件，并且需要下载相应的模型。

### 克劳德代码

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

### Claude 桌面版

内容相同，将被写入到 `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS 系统) 或 `%APPDATA%\Claude\claude_desktop_config.json` (Windows 系统) 文件中。

### 与爱马仕产品搭配使用

该模型控制程序（MCP）已使用 [Hermes Agent](https://github.com/NousResearch/Hermes) 在 Ollama 上的 `hermes3:8b` 模型上进行了端到端的验证（验证日期：2026年4月19日）。Hermes 是一个外部代理，它会*调用*该 MCP 的固定底层接口——它负责规划，我们负责执行。

参考配置（本仓库中的 [hermes.config.example.yaml] 文件）：

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

**提示语的格式很重要。** 强制性的工具调用提示语（例如“调用 X，参数为…”）是集成测试，它们为 8B 的本地模型提供了足够的结构，使其能够生成清晰的 `tool_calls`。 列表形式的多任务提示语（例如“先做 A，然后 B，最后 C”）是用于评估更大模型能力的基准测试；不要将 8B 模型在列表形式提示语下的失败归因于“底层连接出现问题”。 请参阅 [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/)，以获取完整的集成测试流程以及已知的传输相关注意事项（Ollama 的 `/v1` 流式传输以及 openai-SDK 的非流式传输适配器）。

### 模特拉伸

**默认开发配置 (RTX 5080 16GB 及类似配置):**

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=-1
```

**Qwen 3 专用配置 (相同硬件，用于 Qwen 工具):**

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

每个层级的环境变量 (`INTERN_TIER_INSTANT`, `INTERN_TIER_WORKHORSE`, `INTERN_TIER_DEEP`, `INTERN_EMBED_MODEL`) 仍然会覆盖配置文件的选择，用于一次性任务。

---

## 统一的接口

每个工具返回相同的结构：

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

`residency` (模型驻留状态) 来自 Ollama 的 `/api/ps` 接口。当 `evicted: true` (模型已被移除) 或 `size_vram < size` (显存不足) 时，模型会被写入磁盘，推理速度会下降 5-10 倍。系统会向用户显示此信息，以便用户重启 Ollama 或减少加载的模型数量。

每个调用都会被记录为一行 NDJSON 数据，保存在 `~/.ollama-intern/log.ndjson` 文件中。可以通过 `hardware_profile` 进行过滤，以将开发环境的数据排除在可发布的基准测试之外。

---

## 硬件配置

| 配置 | Instant | Workhorse | Deep | Embed |
|---|---|---|---|---|
| **`dev-rtx5080`** (默认) | hermes3 8B | hermes3 8B | hermes3 8B | nomic-embed-text |
| `dev-rtx5080-qwen3` | qwen3 8B | qwen3 8B | qwen3 14B | nomic-embed-text |
| `m5-max` | qwen3 14B | qwen3 14B | qwen3 32B | nomic-embed-text |

**默认开发配置** 将所有三个工作层都映射到 `hermes3:8b`，这是经过验证的 Hermes Agent 集成路径。使用相同的模型可以简化操作，减少学习成本，并降低资源消耗。如果用户更喜欢 Qwen 3 (它具有 `THINK_BY_SHAPE` 功能)，可以选择 `dev-rtx5080-qwen3` 配置。`m5-max` 配置是为 Qwen 3 优化的，适用于统一内存环境。

---

## 证据规则

这些规则在服务器端强制执行，而不是在提示词中：

- **必须提供引用。** 每个简短的陈述都必须引用一个证据 ID。
- **未知内容在服务器端被移除。** 如果模型引用了不在证据包中的 ID，则这些 ID 会在返回结果之前被移除，并会显示警告。
- **弱证据标记为弱。** 弱证据会标记为 `weak: true`，并附带说明，不会被伪装成虚假叙述。
- **用于调查，而非指导。** 仅提供 `next_checks` (下一步检查) / `read_next` (下一步阅读) / `likely_breakpoints` (可能的中断点)。提示词禁止使用 "应用此修复"。
- **确定性的渲染器。** 标记文本的形状是代码，而不是提示词。`draft` (草稿) 仍然保留用于需要模型措辞的文本。
- **仅支持同一包的差异。** 跨包的 `artifact_diff` (差异) 会被明确拒绝；每个包的数据保持独立。

---

## 数据和连续性

每个包会将数据写入 `~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)`。数据层提供连续性，但不会将其变成一个文件管理工具：

- `artifact_list` (数据列表) — 仅包含元数据的索引，可以按包、日期、slug 前缀进行过滤。
- `artifact_read` (数据读取) — 按 `{pack, slug}` (包和 slug) 或 `{json_path}` (JSON 路径) 进行类型读取。
- `artifact_diff` (数据差异) — 结构化的同一包比较；弱点会被突出显示。
- `artifact_export_to_path` (数据导出到路径) — 将现有数据（包含来源信息）导出到调用者声明的 `allowed_roots` 目录。如果目标文件已存在，则会拒绝导出，除非设置了 `overwrite: true`。
- `artifact_incident_note_snippet` (事件备注片段) — 操作员备注片段。
- `artifact_onboarding_section_snippet` (入职部分片段) — 手册片段。
- `artifact_release_note_snippet` (发布备注片段) — DRAFT (草稿) 发布备注片段。

此层级中没有模型调用。所有内容都从存储的内容中渲染。

---

## 威胁模型和遥测

**涉及的数据：** 调用者显式传递的文件路径 (`ollama_research`, corpus tools)，内联文本，以及调用者请求写入到 `~/.ollama-intern/artifacts/` 或调用者声明的 `allowed_roots` 目录中的数据。

**未被修改的数据：** 任何位于 `source_paths` 或 `allowed_roots` 之外的数据都不会被修改。 `..` 在标准化之前会被拒绝。 `artifact_export_to_path` 除非 `overwrite: true`，否则会拒绝已存在的文件。 针对受保护路径（如 `memory/`, `.claude/`, `docs/canon/` 等）的草稿需要明确设置 `confirm_write: true`，服务器端强制执行。

**网络出站：** **默认情况下禁用。** 唯一的出站流量是发送到本地 Ollama HTTP 接口。 不会进行任何云端调用，也不会发送更新请求或崩溃报告。

**遥测：** **无。** 每次调用都会被记录为一行 NDJSON 数据，存储在您的机器上的 `~/.ollama-intern/log.ndjson` 文件中。 没有任何数据会离开设备。

**错误：** 采用结构化的格式 `{ code, message, hint, retryable }`。 堆栈跟踪信息永远不会通过工具结果暴露。

完整策略：[SECURITY.md](SECURITY.md)。

---

## 标准

符合 [Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck) 的标准。 通过 A–D 级别的测试；请参阅 [SHIP_GATE.md](SHIP_GATE.md) 和 [SCORECARD.md](SCORECARD.md)。

- **A. 安全性：** SECURITY.md，威胁模型，无遥测，路径安全，针对受保护路径使用 `confirm_write`。
- **B. 错误：** 所有工具结果都采用结构化的格式；不暴露原始堆栈信息。
- **C. 文档：** README 文档当前版本，CHANGELOG，LICENSE；工具模式具有自文档功能。
- **D. 质量：** `npm run verify` (395 个测试)，CI 包含依赖项扫描，Dependabot，lockfile，`engines.node`。

---

## 路线图（加强安全，而非扩大范围）

- **第一阶段 — 授权核心：** ✓ 已发布：原子表面，统一接口，分层路由，安全措施。
- **第二阶段 — 真实性核心：** ✓ 已发布：模式 v2 分块，BM25 + RRF，动态语料库，基于证据的简报，检索评估包。
- **第三阶段 — 打包和工件核心：** ✓ 已发布：具有持久工件和连续性的固定流水线打包。
- **第四阶段 — 采用核心：** — 在 RTX 5080 上进行实际使用观察，并完善表面上的问题。
- **第五阶段 — M5 Max 性能基准测试：** — 在硬件到位后发布可公开的性能数据（约 2026 年 4 月 24 日）。

按安全加固层进行划分。 原子/打包/工件表面保持不变。

---

## 许可证

MIT — 参见 [LICENSE](LICENSE)。

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
