<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.md">English</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

**क्लाउड कोड के लिए स्थानीय इंटर्न।** 41 उपकरण, प्रमाण-आधारित संक्षिप्त विवरण, टिकाऊ कलाकृतियाँ।

एक एमसीपी सर्वर जो क्लाउड कोड को नियमों, स्तरों, एक डेस्क और एक फाइलिंग कैबिनेट के साथ एक **स्थानीय इंटर्न** प्रदान करता है। क्लाउड उपकरण का _चुनाव_ करता है; उपकरण _स्तर_ (तत्काल / कार्यशील / गहन / एम्बेड) का चयन करता है; स्तर एक फ़ाइल लिखता है जिसे आप अगले सप्ताह खोल सकते हैं।

यह `hermes3:8b` पर **[हर्मेस एजेंट](https://github.com/NousResearch/hermes-agent) को भी चलाता है** - 19 अप्रैल, 2026 को एंड-टू-एंड सत्यापन किया गया। डिफ़ॉल्ट स्तर `hermes3:8b` है; `qwen3:*` वैकल्पिक विकल्प है। नीचे [हर्मेस के साथ उपयोग](#use-with-hermes) देखें।

**हार्डवेयर आवश्यकताएँ:** `hermes3:8b` के लिए ~6 जीबी वीआरएएम, या सीपीयू अनुमान के लिए ~16 जीबी रैम। पूर्ण विवरण के लिए [handbook/getting-started](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/getting-started/#hardware-minimums) देखें।

**क्या आप क्लाउड का उपयोग नहीं कर रहे हैं?** [`examples/`](./examples/) निर्देशिका में एक न्यूनतम नोड.जेएस और पायथन एमसीपी क्लाइंट है जिसे आप stdio के माध्यम से चला सकते हैं। [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/) भी देखें।

कोई क्लाउड नहीं। कोई टेलीमेट्री नहीं। "स्वायत्त" कुछ भी नहीं। प्रत्येक कॉल अपने काम को दिखाता है।

---

## v2.2.0 में नया

स्थानीय प्रमाण-कार्यकर्ता भूमिका अनुबंध: फ्रेम-बाउंड प्रासंगिकता और संरचित अस्वीकृति। मामूली अतिरिक्त - v2.1.0 कॉलर्स अपरिवर्तित। [CHANGELOG.md](./CHANGELOG.md) और [docs/release-notes/v2.2.0.md](./docs/release-notes/v2.2.0.md) में विस्तृत प्रविष्टियाँ।

- `ollama_extract`, `ollama_classify`, `ollama_summarize_fast`, `ollama_summarize_deep` पर **फ्रेम-बाउंड निष्कर्षण** - वैकल्पिक `frame: string` इनपुट + संरचित `frame_alignment` / `on_topic` / `frame_addressed` आउटपुट। अप्रासंगिक स्रोतों को स्कीमा में पुन: वाक्यांश करने के बजाय चिह्नित किया जाता है।
- `ollama_research` पर **संरचित अस्वीकृति** - `weak` / `abstained` / `sources_address_question` फ़ील्ड। खाली `citations[]` के साथ गैर-खाली `answer` अब कोई मौन सफलता नहीं है।
- `ollama_corpus_answer` पर **प्रासंगिकता थ्रेसहोल्ड** - वैकल्पिक `min_top_score`। थ्रेसहोल्ड से नीचे, उपकरण `abstained: true` के साथ शॉर्ट-सर्किट हो जाता है और संश्लेषण को छोड़ देता है। प्रत्येक उद्धरण पर अब `score` प्रति-उद्धरण दिखाई देता है।
- संक्षिप्त प्रमाण के माध्यम से **पुनर्प्राप्ति स्कोर का संरक्षण** - `corpusHitsToEvidence` `score` (और `corpus_min_evidence_score` नॉब `incident_brief` / `repo_brief` / `change_brief` पर असेंबली समय पर फ़िल्टर करता है) को ले जाता है।
- **उद्धरण लाइन-रेंज सीमाएँ** - `guardrails/citations.ts` `ollama_research` पर सीमा से बाहर की रेंज को अस्वीकार करता है, जो `ollama_code_citation` पर मौजूदा स्थिति से मेल खाता है।
- **ऑपरेटर-अनुबंध दस्तावेज़ों को ठीक किया गया** - README `chunk_id`/`chunk_index` सुधार, "सर्वर-साइड पर सत्यापित" को फिर से लिखा गया, प्रमाण कानून अनुभाग को योग्य बनाया गया, विपणन नारा अंकित किया गया।

### सीड प्रतिगमन - सत्यापन

स्लाइस का अनुबंध शाब्दिक अनुसंधान-ओएस ताजा-पैकेज विफलता के खिलाफ सत्यापित है: arxiv 2112.10422 (कॉस्मोलॉजिकल स्टैंडर्ड टाइमर्स) अनुभाग-01 फ्रेम *"स्थानीय-प्रथम बनाम क्लाउड एलएलएम गहन-अनुसंधान वर्कफ़्लो में प्रमाण हिरासत का क्या अर्थ है?"* - 9 / 9 मॉक-एलएलएम अनुबंध परीक्षण पुष्टि करते हैं कि अप्रासंगिक स्रोत अब निहित है (`frame_alignment.on_topic = false` निष्कर्षण पर; `off_topic: true` वर्गीकरण पर; `frame_addressed: false` `summarize_deep` पर; `abstained: true` `corpus_answer` पर `min_top_score` सेट के साथ)।

### ऐतिहासिक - v2.1.0 डिलीवरी

पूर्ण v2.1.0 प्रविष्टि के लिए [CHANGELOG.md](./CHANGELOG.md) देखें (सुविधा पास: 13 नए उपकरण + 4 सुधार + फ्रीज लिफ्ट)।

---

## लीड उदाहरण - एक कॉल, एक कलाकृति

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

डिस्क पर एक फ़ाइल की ओर इशारा करने वाला एक लिफाफा लौटाता है:

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

→ `weak: false` का मतलब है कि 2 या अधिक प्रमाण आइटम एकत्र किए गए थे; इसका मतलब यह नहीं है कि परिकल्पनाओं को सत्यापित किया गया है। [प्रमाण कानून](#evidence-laws) देखें।

वह मार्कडाउन फ़ाइल इंटर्न द्वारा तैयार किया गया आउटपुट है - शीर्षकों, उद्धृत आईडी के साथ साक्ष्य ब्लॉक, जांच के लिए `next_checks`, और यदि साक्ष्य कमजोर है तो `weak: true` का संकेत। यह निश्चित है: रेंडरर कोड है, कोई प्रॉम्प्ट नहीं। (रेंडरर निश्चित है; परिकल्पनाओं और सतहों की *सामग्री* जेनरेटिव है - इसे मसौदा के रूप में पढ़ें, सत्यापित नहीं)। इसे कल खोलें, अगले सप्ताह इसका अंतर देखें, और इसे `ollama_artifact_export_to_path` के साथ एक हैंडबुक में निर्यात करें।

इस श्रेणी में प्रत्येक प्रतियोगी "टोकन बचाएं" के साथ शुरुआत करता है। हम _यहां वह फ़ाइल है जिसे इंटर्न ने लिखा है_ के साथ शुरुआत करते हैं।

### दूसरा उदाहरण - एक कॉर्पस बनाएं, फिर उससे पूछें।

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

सर्वर उद्धरण की पहचान को मान्य करता है और यह सुनिश्चित करता है कि प्रत्येक `chunk_index` प्राप्त परिणामों की सीमा में है। यह यह साबित नहीं करता है कि उत्पन्न प्रत्येक दावे का समर्थन साक्ष्य के अंश की सामग्री द्वारा किया गया है - यह मॉडल की जिम्मेदारी है, और कमजोर पुनर्प्राप्ति अभी भी उद्धरण-जैसे उत्तर उत्पन्न कर सकती है। [handbook/corpora](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/corpora/) में पूरी जानकारी दी गई है।

---

## फ्रेम-बाउंड निष्कर्षण (v2.2.0 में नया)

`ollama_extract`, `ollama_classify`, `ollama_summarize_fast`, और `ollama_summarize_deep` एक वैकल्पिक `frame: string` इनपुट स्वीकार करते हैं। फ्रेम उस प्रश्न का नाम देता है जिसका उत्तर स्रोत से पूछा जा रहा है; मॉडल को निर्देश दिया जाता है कि जब स्रोत फ्रेम को संबोधित नहीं करता है तो वह सही लेकिन अप्रासंगिक सामग्री उत्पन्न करने के बजाय, जवाब देने से बचें।

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

यदि `frame` को छोड़ दिया जाता है, तो व्यवहार v2.1.0 से अपरिवर्तित रहता है। जब प्रदान किया जाता है, तो `frame_alignment.on_topic = false` इंगित करता है कि निकाले गए फ़ील्ड स्रोत के लिए सही हो सकते हैं, लेकिन फ्रेम के लिए प्रासंगिक नहीं हैं - इसे `weak: true` संक्षिप्त के समान मानें: उपयोगी, लेकिन प्रचार करने से पहले जांच करें।

---

## अभिभावक अनुबंध (v2.2.0 में नया)

`ollama_research` संरचित अभिभावन फ़ील्ड लौटाता है: `weak: boolean`, `abstained: boolean`, `sources_address_question: boolean | null`. एक खाली `citations[]` एक गैर-खाली `answer` के साथ अब चुप नहीं रहता है - `abstained: true` इंगित करता है कि मॉडल ने संश्लेषण करने से इनकार कर दिया क्योंकि कॉलर द्वारा प्रदान किए गए पथ प्रश्न को संबोधित नहीं करते थे। अभिभावन को विफलता के बजाय सफलता मानें: यह टूल कमजोर पुनर्प्राप्ति को आधिकारिक आउटपुट में बदलने से इनकार कर रहा है।

`ollama_corpus_answer` एक वैकल्पिक `min_top_score: number` विषयवस्तु सीमा (0.0–1.0) स्वीकार करता है। जब किसी क्वेरी के लिए शीर्ष पुनर्प्राप्ति स्कोर `min_top_score` से कम हो जाता है, तो टूल `abstained: true` के साथ शॉर्ट-सर्किट हो जाता है और संश्लेषण को छोड़ देता है - जिससे "5 अप्रासंगिक अंश 0.21 के स्कोर पर अभी भी एक पूर्ण उत्तर उत्पन्न करते हैं" जैसी विफलता को रोका जा सकता है, जिसे v2.1.0 के `weak: true` नियम ने नहीं पकड़ा था (`weak: true` केवल `hits.length < 2` पर सक्रिय होता था)। प्रत्येक उद्धरण पर दिखाई देने वाले प्रति-उद्धरण `score` फ़ील्ड के साथ इसे जोड़ें ताकि पुनर्प्राप्ति गुणवत्ता का सीधे लिफाफे से ऑडिट किया जा सके।

---

## यहां क्या है - चार स्तर, 41 उपकरण

**जॉब-शेप्ड** का मतलब है कि प्रत्येक उपकरण एक ऐसे कार्य का नाम देता है जिसे आप किसी इंटर्न को सौंपेंगे - इसे वर्गीकृत करें, इसे निकालें, इन लॉग का वर्गीकरण करें, इस रिलीज़ नोट का मसौदा तैयार करें, इस घटना को पैक करें। उपकरण का इनपुट नौकरी का विनिर्देश है; आउटपुट डिलिवरेबल है। शीर्ष पर कोई सामान्य `run_model` / `chat_with_llm` मूल नहीं है।

| स्तर | गणना | यहां क्या है |
|---|---|---|
| **Atoms** | 15 | जॉब-शेप्ड मूल। `classify`, `extract`, `triage_logs`, `summarize_fast` / `deep`, `draft`, `research`, `corpus_search` / `answer` / `index` / `refresh` / `list`, `embed_search`, `embed`, `chat`. बैच-सक्षम परमाणु (`classify`, `extract`, `triage_logs`) `items: [{id, text}]` स्वीकार करते हैं। |
| **Briefs** | 3 | साक्ष्य-समर्थित संरचित ऑपरेटर संक्षिप्त। `incident_brief`, `repo_brief`, `change_brief`. प्रत्येक दावे में एक साक्ष्य आईडी का हवाला दिया गया है; अज्ञात सर्वर-साइड से हटा दिए जाते हैं। कमजोर साक्ष्य `weak: true` का संकेत देता है, नकली कथा का नहीं। |
| **Packs** | 3 | निश्चित पाइपलाइन वाले कंपोजिट जॉब जो `~/.ollama-intern/artifacts/` में टिकाऊ मार्कडाउन + JSON लिखते हैं। `incident_pack`, `repo_pack`, `change_pack`. नियतात्मक रेंडरर - आर्टिफैक्ट के आकार पर कोई मॉडल कॉल नहीं। |
| **Artifacts** | 7 | पैक आउटपुट पर निरंतरता। `artifact_list` / `read` / `diff` / `export_to_path`, साथ ही तीन नियतात्मक स्निपेट: `incident_note`, `onboarding_section`, `release_note`. |

कुल: **18 मूल तत्व + 3 पैक + 7 आर्टिफैक्ट टूल = 28**.

फ्रीज लाइनें:
- 18 पर स्थिर एटम (एटम + संक्षिप्त विवरण)। कोई नया एटम टूल नहीं।
- 3 पर स्थिर पैक। कोई नया पैक प्रकार नहीं।
- आर्टिफैक्ट स्तर 7 पर स्थिर।

पूरे टूल संदर्भ [हैंडबुक](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/tools/) में उपलब्ध है।

---

## इंस्टॉल करें

इसके लिए स्थानीय रूप से चलने वाले [Ollama](https://ollama.com) और डाउनलोड किए गए मॉडल की आवश्यकता होती है (नीचे [मॉडल डाउनलोड](#model-pulls) देखें)।

### क्लाउड कोड (अनुशंसित)

अधिकांश उपयोगकर्ता इसे अपने क्लाउड कोड MCP सर्वर कॉन्फ़िगरेशन में जोड़कर इंस्टॉल करते हैं - वैश्विक इंस्टॉलेशन की आवश्यकता नहीं है। क्लाउड कोड `npx` के माध्यम से ऑन-डिमांड सर्वर चलाता है:

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

### क्लाउड डेस्कटॉप

समान ब्लॉक, `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) या `%APPDATA%\Claude\claude_desktop_config.json` (Windows) में लिखा गया है।

### वैश्विक इंस्टॉलेशन (उन्नत)

यह केवल तभी आवश्यक है जब आप क्लाउड कोड के बाहर, आकस्मिक उपयोग के लिए अपने `PATH` पर बाइनरी चाहते हैं:

```bash
npm install -g ollama-intern-mcp
```

### हर्मेस के साथ उपयोग करें

यह MCP को [हर्मेस एजेंट](https://github.com/NousResearch/hermes-agent) के साथ `hermes3:8b` पर Ollama पर एंड-टू-एंड मान्य किया गया था (2026-04-19)। हर्मेस एक बाहरी एजेंट है जो इस MCP के स्थिर मूल सतह पर *कॉल करता* है - यह योजना बनाता है, हम काम करते हैं।

संदर्भ कॉन्फ़िगरेशन ([hermes.config.example.yaml](hermes.config.example.yaml) इस रिपॉजिटरी में):

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

**प्रॉम्प्ट का आकार महत्वपूर्ण है।** अनिवार्य टूल-इनवोकेशन प्रॉम्प्ट ("X को इस तर्क के साथ कॉल करें...") एकीकरण परीक्षण है - यह 8B स्थानीय मॉडल को `tool_calls` को सही ढंग से उत्पन्न करने के लिए पर्याप्त ढांचा प्रदान करता है। सूची-रूप वाले मल्टी-टास्क प्रॉम्प्ट ("A करें, फिर B करें, फिर C करें") बड़े मॉडलों के लिए क्षमता बेंचमार्क हैं; 8B पर सूची-रूप में विफलता को "कनेक्शन टूटा हुआ है" के रूप में न समझें। पूर्ण एकीकरण विवरण + ज्ञात परिवहन संबंधी सीमाओं के लिए [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/) देखें (Ollama `/v1` स्ट्रीमिंग + openai-SDK गैर-स्ट्रीमिंग शिम)।

### मॉडल डाउनलोड

**डिफ़ॉल्ट विकास प्रोफ़ाइल (RTX 5080 16GB और इसी तरह):**

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=-1
```

**Qwen 3 वैकल्पिक रेल (समान हार्डवेयर, Qwen टूलिंग के लिए):**

```bash
ollama pull qwen3:8b
ollama pull qwen3:14b
ollama pull nomic-embed-text
export INTERN_PROFILE=dev-rtx5080-qwen3
```

**M5 मैक्स प्रोफ़ाइल (128GB एकीकृत):**

```bash
ollama pull qwen3:14b
ollama pull qwen3:32b
ollama pull nomic-embed-text
export INTERN_PROFILE=m5-max
```

प्रत्येक स्तर के लिए पर्यावरण चर (`INTERN_TIER_INSTANT`, `INTERN_TIER_WORKHORSE`, `INTERN_TIER_DEEP`, `INTERN_EMBED_MODEL`) अभी भी एक-बार उपयोग के लिए प्रोफ़ाइल चयन को ओवरराइड करते हैं।

---

## समान आवरण

प्रत्येक टूल समान आकार लौटाता है:

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

`residency` Ollama के `/api/ps` से आता है। जब `evicted: true` या `size_vram < size` होता है, तो मॉडल को डिस्क पर ले जाया जाता है और अनुमान 5–10 गुना कम हो जाता है - इसे उपयोगकर्ता को दिखाएं ताकि उन्हें पता चल सके कि उन्हें Ollama को पुनरारंभ करना है या लोड किए गए मॉडल की संख्या को कम करना है।

प्रत्येक कॉल को `~/.ollama-intern/log.ndjson` में एक NDJSON पंक्ति के रूप में लॉग किया जाता है। विकास संख्याओं को प्रकाशित बेंचमार्क से दूर रखने के लिए `hardware_profile` द्वारा फ़िल्टर करें।

---

## हार्डवेयर प्रोफाइल

| प्रोफ़ाइल | इंस्टेंट | वर्कहॉर्स | डीप | एम्बेड |
|---|---|---|---|---|
| **`dev-rtx5080`** (डिफ़ॉल्ट) | hermes3 8B | hermes3 8B | hermes3 8B | nomic-embed-text |
| `dev-rtx5080-qwen3` | qwen3 8B | qwen3 8B | qwen3 14B | nomic-embed-text |
| `m5-max` | qwen3 14B | qwen3 14B | qwen3 32B | nomic-embed-text |

**डिफ़ॉल्ट डेव (Default dev):** यह सभी तीन कार्य स्तरों को `hermes3:8b` पर समेटता है, जो कि मान्य हर्मेस एजेंट एकीकरण पथ है। एक ही मॉडल, शीर्ष से नीचे तक, का मतलब है कि केवल एक चीज़ डाउनलोड करनी है, एक ही सदस्यता लागत है, और समझने के लिए केवल एक व्यवहार सेट है। जो उपयोगकर्ता Qwen 3 को पसंद करते हैं (जिसमें `THINK_BY_SHAPE` प्लंबिंग है), वे `dev-rtx5080-qwen3` का उपयोग करते हैं। `m5-max` Qwen 3 का वह संस्करण है जो एकीकृत मेमोरी के लिए उपयुक्त है।

---

## सबूत कानून

ये नियम सर्वर पर लागू होते हैं, प्रॉम्प्ट पर नहीं:

- **उद्धरण आवश्यक हैं।** प्रत्येक संक्षिप्त दावे में एक प्रमाण आईडी का उल्लेख होता है।
- **अज्ञात तत्वों को सर्वर-साइड पर हटाया जाता है।** उन मॉडलों में जो प्रमाण बंडल में मौजूद आईडी का उल्लेख करते हैं, उन आईडी को परिणाम वापस करने से पहले एक चेतावनी के साथ हटा दिया जाता है।
- **आईडी-सत्यापित, सामग्री-सत्यापित नहीं।** सर्वर यह जांचता है कि प्रत्येक उल्लिखित `evidence_ref` असेंबल किए गए सेट में एक वास्तविक प्रमाण आईडी की ओर इशारा करता है। यह यह सत्यापित नहीं करता है कि दावे वाला पाठ उल्लिखित प्रमाण से प्राप्त किया जा सकता है - यह मॉडल का काम है, और कभी-कभी कमजोर दावों में वैध संदर्भों के साथ असंगत दावे होते हैं। `weak: true` + `coverage_notes` + शामिल `excerpt` फ़ील्ड का उपयोग करके इसकी जांच करें।
- **कमजोर, कमजोर ही रहता है।** कमजोर प्रमाण `weak: true` के साथ कवरेज नोट्स प्रदर्शित करते हैं। इन्हें कभी भी नकली कथा में शामिल नहीं किया जाता है।
- **जांच, उपदेश नहीं।** केवल `next_checks` / `read_next` / `likely_breakpoints`। प्रॉम्प्ट में "इस सुधार को लागू करें" जैसी बातें प्रतिबंधित हैं।
- **निर्धारक रेंडरर।** आर्टिफैक्ट मार्कडाउन का आकार कोड है, प्रॉम्प्ट नहीं। `draft` को केवल उस पाठ के लिए आरक्षित रखा गया है जहां मॉडल की शब्दावली महत्वपूर्ण है।
- **केवल एक ही पैकेज के अंतर।** क्रॉस-पैकेज `artifact_diff` को अस्वीकार किया जाता है; पेलोड अलग-अलग रहते हैं।

---

## आर्टिफैक्ट और निरंतरता

पैकेज `~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)` में लिखते हैं। आर्टिफैक्ट स्तर आपको निरंतरता प्रदान करता है, लेकिन इसे फ़ाइल प्रबंधन टूल में नहीं बदलता है:

- `artifact_list` — केवल मेटाडेटा वाला इंडेक्स, जिसे पैकेज, तिथि और स्लग ग्लोब द्वारा फ़िल्टर किया जा सकता है।
- `artifact_read` — `{pack, slug}` या `{json_path}` द्वारा टाइप किया गया रीड।
- `artifact_diff` — एक ही पैकेज की संरचित तुलना; कमजोर तत्वों को उजागर किया गया।
- `artifact_export_to_path` — एक मौजूदा आर्टिफैक्ट (एक उत्पत्ति हेडर के साथ) को कॉलर द्वारा घोषित `allowed_roots` में लिखता है। यदि `overwrite: true` नहीं है, तो मौजूदा फ़ाइलों को अस्वीकार कर दिया जाता है।
- `artifact_incident_note_snippet` — ऑपरेटर-नोट अंश।
- `artifact_onboarding_section_snippet` — हैंडबुक अंश।
- `artifact_release_note_snippet` — ड्राफ्ट रिलीज़-नोट अंश।

इस स्तर पर कोई मॉडल कॉल नहीं है। सब कुछ संग्रहीत सामग्री से उत्पन्न होता है।

---

## खतरे का मॉडल और टेलीमेट्री

**डेटा जिस पर कार्रवाई की जाती है:** फ़ाइल पथ जिन्हें कॉलर स्पष्ट रूप से प्रदान करता है (`ollama_research`, कॉर्पस टूल), इनलाइन टेक्स्ट और आर्टिफैक्ट जिन्हें कॉलर `~/.ollama-intern/artifacts/` या कॉलर द्वारा घोषित `allowed_roots` के तहत लिखने के लिए कहता है।

**डेटा जिस पर कार्रवाई नहीं की जाती है:** `source_paths` / `allowed_roots` के बाहर की कोई भी चीज़। `..` को सामान्यीकरण से पहले अस्वीकार कर दिया जाता है। यदि `overwrite: true` नहीं है, तो `artifact_export_to_path` मौजूदा फ़ाइलों को अस्वीकार कर देता है। संरक्षित पथों (`memory/`, `.claude/`, `docs/canon/`, आदि) को लक्षित करने वाले ड्राफ्ट के लिए स्पष्ट रूप से `confirm_write: true` की आवश्यकता होती है, जिसे सर्वर-साइड पर लागू किया जाता है।

**नेटवर्क आउटगोइंग:** **डिफ़ॉल्ट रूप से बंद।** एकमात्र आउटबाउंड ट्रैफ़िक स्थानीय Ollama HTTP एंडपॉइंट पर है। कोई क्लाउड कॉल नहीं, कोई अपडेट पिंग नहीं, कोई क्रैश रिपोर्टिंग नहीं।

**टेलीमेट्री:** **कोई नहीं।** प्रत्येक कॉल को आपके मशीन पर `~/.ollama-intern/log.ndjson` में एक NDJSON पंक्ति के रूप में लॉग किया जाता है। कुछ भी सिस्टम से बाहर नहीं जाता है।

**त्रुटियां:** संरचित आकार `{ code, message, hint, retryable }`। स्टैक ट्रेस कभी भी टूल परिणामों के माध्यम से प्रदर्शित नहीं किए जाते हैं।

पूर्ण नीति: [SECURITY.md](SECURITY.md)।

---

## मानक

[Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck) के मानकों के अनुसार बनाया गया। हार्ड गेट A–D पास होते हैं; [SHIP_GATE.md](SHIP_GATE.md) और [SCORECARD.md](SCORECARD.md) देखें।

- **ए. सुरक्षा** — SECURITY.md, खतरे का मॉडल, कोई टेलीमेट्री नहीं, पाथ-सुरक्षा, संरक्षित रास्तों पर `confirm_write`
- **बी. त्रुटियां** — सभी टूल परिणामों में संरचित प्रारूप; कोई रॉ स्टैक नहीं
- **सी. दस्तावेज़** — README (वर्तमान), CHANGELOG, LICENSE; टूल स्कीमा स्वयं-दस्तावेजीकृत हैं
- **डी. स्वच्छता** — `npm run verify` (पूरा विटेस्ट सूट), डिप स्कैनिंग के साथ CI, डिपेंडabot, लॉकफ़ाइल, `engines.node`

---

## रोडमैप (सुरक्षा में सुधार, दायरे में वृद्धि नहीं)

- **पहला चरण — डेलीगेशन स्पाइन** ✓ पूर्ण: एटम सरफेस, यूनिफॉर्म एनवेलप, टियरड रूटिंग, गार्डरेल
- **दूसरा चरण — ट्रुथ स्पाइन** ✓ पूर्ण: स्कीमा v2 चंकिंग, BM25 + RRF, लिविंग कॉर्पोरा, साक्ष्य-आधारित ब्रीफ, रिट्रीवल इवैल पैक
- **तीसरा चरण — पैक और आर्टिफैक्ट स्पाइन** ✓ पूर्ण: फिक्स्ड-पाइपलाइन पैक जिसमें टिकाऊ आर्टिफैक्ट और निरंतरता टियर शामिल हैं
- **चौथा चरण — अपनाना स्पाइन** ✓ v2.0.1: तीन-स्तरीय स्वास्थ्य पास, सुरक्षित कॉर्पस (TOCTOU, 50 एमबी फ़ाइल सीमा, सिंबलिंक अस्वीकृति, परमाणु लेखन, प्रति-फ़ाइल विफलता कैप्चर), टूल पाथ ट्रैवर्सल, अवलोकन क्षमता (सेमाफोर वेट इवेंट, टाइमआउट त्रुटि संदर्भ, प्रोफाइल एनव-ओवरराइड लॉगिंग, प्रीवार्म कोल्ड-स्टार्ट सिग्नल), परीक्षण सुरक्षा (10 फ़ाइलों में मॉड्यूल-लोड एनव स्नैपशॉट, `tools/call` E2E)। ऑपरेटरों के लिए समस्या निवारण पुस्तिका और हार्डवेयर न्यूनतम आवश्यकताएं जोड़ी गई हैं।
- **पांचवां चरण — M5 मैक्स बेंचमार्क** — हार्डवेयर उपलब्ध होने पर प्रकाशित किए जा सकने वाले आंकड़े (लगभग 2026-04-24)

प्रत्येक चरण सुरक्षा के स्तर को बढ़ाता है। एटम/पैक/आर्टिफैक्ट सरफेस स्थिर रहेगा।

---

## लाइसेंस

MIT — [LICENSE](LICENSE) पर देखें।

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
