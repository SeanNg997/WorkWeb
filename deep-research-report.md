# 科研笔记软件里的 AI 行内补全 Prompt 调研与最佳方案

## 结论先行

我先给结论：**现在笔记软件里能公开看到的 AI 行内补全 prompt，大体已经收敛到一个共同框架**——用**局部上下文**预测“光标处应该插入的一小段文本”，并且把约束重点放在**可直接插入、风格一致、不要重复、必要时拒答**上；更先进的实现会再加上**光标后上下文**做 fill-in-the-middle，以及按**列表、标题、公式、代码、普通段落**分别给 few-shot 示例。专有产品通常公开“上下文从哪里来、作用域有多大、如何给持久指令”，但不公开内部 prompt 文案；公开的 exact prompt 主要来自开源 Obsidian 插件。citeturn39view0turn39view1turn39view2turn18view0turn23view0turn2view0turn36view0

对你的场景来说，**“科研项目笔记”不应该追求最会发散的 prompt，而应该追求最会收敛的 prompt**。也就是说，它应当优先保证术语一致、句法衔接、结构正确、信息克制，并且允许在没有把握时直接返回一个固定哨兵值，而不是硬补一段“像样但不可靠”的文字。这一点和一些面向 PKM/灵感笔记的产品取向不同：它们会鼓励“更有启发、偶尔出人意料”的续写，但科研笔记更适合把这类目标降权。citeturn18view0turn23view0turn2view0turn39view2

因此，最佳方案不是继续把你的现有 prompt 叠更多“不要……不要……”的禁令，而是改成三层结构：**稳定的 system prompt、结构化的 user context、明确的拒答哨兵**。如果未来还能提供光标后内容，再升级成 **prefix + suffix** 的 fill-in-the-middle 版本，效果会明显更稳。citeturn18view0turn23view0turn2view0turn35view0

## 公开样本里，主流笔记产品和插件到底怎么写

**Notion** 没有公开它行内续写的内部 prompt，但公开了几个很关键的设计点：Notion AI 的输出来自“用户问题 + 当前页面上下文”；数据库里的 Basic Autofill 只使用**当前行/当前页**内容，不会跨整个工作区乱搜；如果升级到 Custom Agent，才可以在开启后使用工作区搜索或网页搜索。Notion 还把“Instructions”做成持久化指令页，并明确建议写法是：**先写你想要什么，而不是先写你不想要什么；要具体；且要短**。这其实已经透露了它的产品哲学：行内写作应当以**局部上下文 + 简短持久偏好**为核心，而不是把一长串负面规则塞进每次请求。citeturn39view0turn39view1turn39view2turn39view3

**Obsidian AI Autocomplete** 公开了非常典型的一版现代 note-autocomplete prompt。它的默认 system prompt 重点不是“写文章”，而是“**精确生成一段可插入到光标处的 ghost text**”；规则包括：只输出插入文本、不重复光标前后已有文本、匹配语言/语气/Markdown 风格、尽量简洁、严格模板时优先格式正确、上下文不足时返回固定哨兵 `NO_SUGGESTION`。它的 user message 也很短，只是把 prefix 和 suffix 放进去，再重复一遍“只返回要插入的文本”。这类写法的好处是把任务边界定义得非常精准：**不是回答问题，不是总结，不是扩写整段，而是预测一个可直接插入的局部 continuation**。citeturn18view0

**Obsidian InScribe** 的默认 prompt 值得你重点参考，因为它已经非常接近科研笔记的写作节奏。它把 system 与 user prompt 分开，并把 user prompt 写成一个很实用的二分逻辑：**如果最后一句还没写完，就只把这句补完；如果最后一句已经完整，就生成一个逻辑上承接的新句**。同时它暴露了 `pre_cursor`、`post_cursor`、`active_sentence`、`last_line` 这些变量，并支持按路径绑定不同 profile，README 还明确举过“research notes 用更正式的 profile、fiction 用更创意的 profile”这样的例子。也就是说，公开样本里已经有人把“研究笔记”和“创意写作”当成**不同 prompt 配方**来处理了。citeturn19view0turn23view0

**obsidian-copilot-auto-completion** 走的是更工程化的路线。它把行内补全显式建模为 `<mask/>` 填空任务：system prompt 要求模型预测 mask 处最合理的文本，并按 `THOUGHT / LANGUAGE / ANSWER` 的结构输出；最终展示给用户时，只保留 `ANSWER`。更重要的是，它不是只靠一条总 prompt，而是会按上下文类型插入 few-shot：数学块、代码块、编号列表、无序列表、任务列表、标题、普通段落、引用块等都有各自示例。这个思路对科研笔记尤其重要，因为科研笔记里“列表项补全”“LaTeX 公式续写”“标题续写”“结论句补全”本来就不是同一类任务。citeturn2view0turn3view0

**copilot-plugin / Sidekick 这一类 Obsidian 新插件** 则把“作用域控制”做成了产品能力。copilot-plugin 允许 system prompt 和 user prompt 模板引用 `{{prefix}}`、`{{suffix}}`、`{{vault_context}}`，它的默认 system prompt 甚至会把 vault 的主题、术语和写作风格摘要作为额外背景；Sidekick 则允许用户只把选中的文件夹或文件纳入上下文。这里传达出的最新趋势非常明确：**好的 inline completion 不是盲目吃更多上下文，而是吃更相关、范围更可控的上下文**。citeturn1view2turn35view0turn36view0turn1view3

顺带一提，较老或较“completion-native”的实现会更极端一些。copilot-plugin 里旧的 OpenAI completer 甚至可以直接把截断后的 prefix 发给 completions endpoint，而不额外构造 chat prompt。这说明当你用的是“原生补全模型”时，prompt 可以非常薄；但当你用的是通用 chat 模型时，**必须显式告诉模型它是在做“插入预测”而不是“回答问题”**。citeturn32view0turn35view0turn36view0

## 从这些样本里抽出来的共同规律

第一条规律是：**上下文分层，而不是上下文堆叠**。几乎所有可见实现都把上下文分成至少两层：一层是“全局但压缩”的背景，比如当前页、当前项目、vault summary、Instructions；另一层是“局部且强相关”的光标邻域，比如 prefix、suffix、active sentence、last line。GitHub Copilot 在代码场景里也遵循同样原则：它先看光标前后行，再补充活动文件、打开文件和工作区信息。把这个规律迁移到科研笔记，就是：**项目标题和项目摘要是背景，真正驱动补全的仍然应该是光标附近的句子级上下文**。citeturn39view0turn39view1turn1view2turn1view3turn40view0

第二条规律是：**“只输出插入文本”是最核心的约束，没有之一**。公开样本里几乎都在反复强调这一点，而且很多实现还会在 system prompt 和 user prompt 里各强调一次。原因很简单：inline completion 的唯一成功标准，不是“模型说得对”，而是“用户按 Tab 后，这段文本能直接贴进文档里”。因此，很多实现还会同时加上“不要重复前后文”“不要解释”“不要引用 prompt 自身”“必要时返回固定拒答值”这些规则。citeturn18view0turn23view0turn2view0turn36view0

第三条规律是：**对结构的尊重，比对 prose 的流畅更重要**。现代笔记软件并不会把 Markdown、列表、标题、表格、公式、代码当成噪声；相反，它们会把这些结构当成线索。Leoyishou 的 prompt 明说如果上下文是代码、表格、YAML 或严格模板，就优先保证格式正确；j0rdsmit 的插件更直接，把不同结构做成不同 few-shot 场景；InScribe 也允许通过 `active_sentence`、`last_line` 等变量把模型拉回当前结构。对科研笔记来说，这一点尤其关键，因为实验步骤、观察记录、结论 bullets、LaTeX 公式、方法小节标题，本来就经常交替出现。citeturn18view0turn23view0turn2view0

第四条规律是：**“拒答”比“硬补全”更像成熟产品**。公开样本中最值得你照搬的细节，不是某一句漂亮文案，而是 `NO_SUGGESTION` / `NO_COMPLETION` 这种哨兵设计。因为“输出空字符串”在很多模型和中间层上并不可靠，而固定哨兵值更利于前端稳定地清空建议、做统计、做 A/B。Notion 的 Autofill 说明里也反复强调：如果页面没有足够信息，Autofill 就不会很好工作；这和强制生成一段貌似顺滑的句子，本质上是相反的设计选择。citeturn18view0turn39view1

## 你现在这版 Prompt 的主要问题

你现在这版 prompt 的优点其实不少：它已经抓住了“只输出补全文字本身”“不要解释”“不要重复前文”“保持最近语气和措辞”这些正确方向。但它的主要问题不是“不够严格”，而是**约束方向有几处偏了**。

最明显的一处，是你把“不要输出 Markdown、列表”写成了全局禁令。这个约束对通用聊天很有用，但对笔记软件里的 inline completion 反而容易伤害质量。公开样本里，成熟实现普遍不是禁止列表、标题、代码、公式，而是要求模型在这些结构里**延续既有模式**。对于科研笔记更是如此：如果用户正在写实验步骤、结论 bullets、公式推导或小标题，你的 prompt 现在会主动压制掉最自然的 continuation。citeturn18view0turn2view0turn23view0

第二处问题，是你要求“如果没有高质量补全，直接输出空内容”。从产品设计角度看，这个目标是对的；但从 prompt 工程角度看，**“输出空”不如“输出固定哨兵”稳定**。公开的插件实现里，已经有直接把 `NO_SUGGESTION` 做进协议的例子。对于你的前端来说，`__NO_COMPLETION__` 明显比“空格、空行、被模型偷偷补了一句解释”更容易处理。citeturn18view0

第三处问题，是你没有显式区分“句子还没写完”和“句子已经写完”这两种状态。InScribe 的默认 prompt 之所以实用，就在于它把这两类任务拆开了：前者目标是**补完当前句**，后者目标才是**补一个新句**。科研笔记非常依赖这种局部判断，因为很多时候用户只是停在半句术语、半句结论、半句方法描述上，这时最好的 completion 往往不是“再来一句”，而是“把这句补齐”。citeturn23view0

第四处问题，是你的 prompt 目前把“项目标题 / 项目摘要 / 本地上下文”都塞进了一个自然语言大段里，但没有明确声明**优先级**。这会导致某些模型过度受项目标题和摘要影响，去复述项目背景，而不是贴着光标补当前句。公开样本里，主流做法是把系统行为、全局背景、局部上下文分层，或者直接把 vault/project context 单独做成注入块。对于你的场景，应该明确写出：**项目信息只是背景，真正的首要目标是补当前局部，而不是复述项目摘要**。citeturn1view2turn35view0turn36view0turn39view0

最后一个问题是长度控制。你现在写“最多 30 个中文字符”，这会让模型在很多科研场景里被迫过短，尤其是对公式片段、精确术语补完、列表项补完整句这类任务。公开样本更常见的做法不是死卡汉字数，而是限制成“**最多一句 / 一个列表项 / 一行公式或代码**”，再配合较低 token 上限。对 inline completion，这种限制通常既足够短，又不会把技术表达掐死。这里我会把它视为一个基于公开样本的工程推断，而不是绝对规则。citeturn18view0turn23view0turn1view2

## 适合科研项目笔记的最佳 Prompt

如果你的后端能改成 **system + user messages**，我建议直接用下面这版。它把公开样本里最有效的几条规律都吸收进来了：只输出插入文本、项目上下文分层、句子状态分支、结构感知、拒答哨兵、科研场景下的“不要引入未经上下文支持的新事实”。前半部分的写法也遵循了 Notion 对持久指令的建议：**先写想要什么，尽量短而具体，再补必要的禁止项**。citeturn39view2turn18view0turn23view0turn2view0

```text
SYSTEM_PROMPT

你是科研项目笔记软件中的行内补全引擎。
你的唯一任务，是预测“光标处应该插入的一小段文本”，让用户按下 Tab 后可以直接插入原文而无需修改。

请按以下优先级工作：
1. 严格延续当前项目主题、术语和论证方向，只补当前局部，不扩展成新话题。
2. 严格匹配上下文的语言、语气、信息密度与格式。
3. 如果当前句子未完成，优先把它自然补完；如果当前句子已完成，只补一个紧接其后的高价值短句、短语或单个列表项。
4. 如果当前处于 Markdown 标题、列表、表格、LaTeX 公式、代码块或引用中，优先保持该结构正确。
5. 科研笔记场景下，不要凭空引入未经上下文支持的新事实、数据、结论、引用或参考文献。
6. 只输出“应插入的文本”本身；不要解释，不要总结，不要加引号，不要加标题，不要输出元说明。
7. 不要重复已经出现在局部上下文中的内容；如果提供了光标后内容，也不要与其冲突。
8. 如果没有高质量补全，精确输出：__NO_COMPLETION__

补全文本应该：
- 可被直接插入光标处
- 默认尽量短
- 最多一句
- 如果当前在列表、公式或代码中，可以输出一个列表项、一行公式或一行代码
```

```text
USER_PROMPT

[项目标题]
{{project_title}}
[/项目标题]

[项目摘要]
{{project_summary}}
[/项目摘要]

[光标前最近内容]
{{recent_before_cursor}}
[/光标前最近内容]

[当前段落已输入]
{{current_paragraph_prefix}}
[/当前段落已输入]

请输出此处最自然、最有用、可直接插入的补全文字。
若没有高质量补全，只输出 __NO_COMPLETION__ 。
```

如果你**暂时只能保留一个 `prompt` 字段**，那就把 system 和 user 合成下面这一版，直接替换你当前的 template string 即可。它比你现有写法更适合科研笔记，核心改动有四个：允许结构化续写、加入句子完成逻辑、把项目信息降级为背景、把空输出改成哨兵。它吸收了 Obsidian AI Autocomplete、InScribe、obsidian-copilot-auto-completion、copilot-plugin 这几类实现的共同点。citeturn18view0turn23view0turn2view0turn35view0turn36view0

```text
你是科研项目笔记软件中的行内补全引擎。

你的唯一任务，是预测“光标处应该插入的一小段文本”，让用户可以直接插入原文。

请按以下优先级工作：
1. 严格延续当前项目主题、术语和论证方向，只补当前局部，不扩展成新话题。
2. 严格匹配上下文的语言、语气、信息密度与格式。
3. 如果当前句子未完成，优先把它自然补完；如果当前句子已完成，只补一个紧接其后的高价值短句、短语或单个列表项。
4. 如果当前处于 Markdown 标题、列表、表格、LaTeX 公式、代码块或引用中，优先保持该结构正确。
5. 科研笔记场景下，不要凭空引入未经上下文支持的新事实、数据、结论、引用或参考文献。
6. 只输出应插入的文本本身；不要解释，不要总结，不要加引号，不要加标题，不要输出任何元说明。
7. 不要重复已经出现在局部上下文中的内容，也不要复述项目标题或项目摘要。
8. 如果没有高质量补全，精确输出：__NO_COMPLETION__

补全文本应满足：
- 可直接插入光标处
- 默认尽量短
- 最多一句
- 如果当前在列表、公式或代码中，可以输出一个列表项、一行公式或一行代码

[项目标题]
{{project_title}}
[/项目标题]

[项目摘要]
{{project_summary}}
[/项目摘要]

[光标前最近内容]
{{recent_before_cursor}}
[/光标前最近内容]

[当前段落已输入]
{{current_paragraph_prefix}}
[/当前段落已输入]

现在输出可直接插入光标处的补全文字；若无高质量结果，只输出 __NO_COMPLETION__ 。
```

## 落地时最值得同时改掉的实现细节

第一，**把空输出改成固定哨兵值**。这不是“小修小补”，而是 inline completion 稳定性里非常值钱的一步。你可以在前端把 `__NO_COMPLETION__` 当成 clear-suggestion 信号；如果返回为空、全是空白、或等于哨兵，也统一视为无建议。公开样本里已经有 `NO_SUGGESTION` 这种做法，而且它比“让模型输出空白”更可控。citeturn18view0

第二，**给“光标后内容”留接口**。你现在已经有 `beforeText` 和 `currentText`，这能做一个不错的 prefix-only 版本；但下一步最值得加的不是更多项目元信息，而是 suffix。多个公开实现都把 prefix+suffix 当成标准输入，或者直接用 `<mask/>` 做 fill-in-the-middle。对科研笔记来说，这会显著减少重复、跑偏和结构冲突。即使你今天还没有 suffix，也建议把 prompt 模板先设计成可选字段，后面加起来最顺。citeturn18view0turn23view0turn2view0turn35view0

第三，**把“项目级上下文”和“局部上下文”分开，不要混成自然语言散文**。项目标题和摘要应该是背景；真正驱动输出的，应当是最近一段前文和当前段落前缀。copilot-plugin 的 `vault_context`、Notion 的 Instructions、Notion Autofill 的“specific row/page only”、Sidekick 的 vault scope，本质上都在做同一件事：让模型知道“**背景是什么**”和“**这里现在正在写什么**”是两种不同的上下文。citeturn39view1turn39view2turn1view2turn1view3

第四，**参数建议走“低温度、短输出、快拒答”**。公开样本里，inline completion 普遍把随机性压得比较低：例如有实现默认 `temperature: 0.3`，也有插件把 completion token 数限制在 25 或 50，并强调高频调用下要兼顾成本与响应时间。基于这些样本，我对科研笔记场景的建议是：先从 `temperature 0.2~0.4`、`max_tokens 32~64` 起步，再根据你自己的 acceptance rate 做微调。这个区间是工程建议，不是公开规范，但和现有产品取向一致。citeturn6view0turn1view2turn19view0

最后，如果你未来发现科研笔记里经常出现公式、列表、方法步骤、论文摘要式句子，**最有价值的下一步不是继续加规则，而是补 2 到 4 个 few-shot 示例**。公开样本已经证明，few-shot 对数学块、代码块、标题、列表这类结构化上下文特别有帮助。对你的产品，我会优先准备这三类示例：普通科研叙述句、结论/观察列表项、LaTeX 公式片段。citeturn2view0turn3view0