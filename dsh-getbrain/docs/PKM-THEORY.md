# 知识管理理论 → Mgetbrain 的落地决策

> 本文回答一个问题：**面对 4321 条已有笔记，到底该怎么组织？**
> 不是理论综述。每条结论都对应到本仓库的代码行为，并标注反面代价。
>
> 写作日期：2026-11-18。数据快照：`C:\dsh\data-getbrain\current`（4321 个 md）+ `state/kb_scopes.json`。

---

## 0. 先看事实：你的库里到底有什么

这些数字决定了后面所有结论，不能跳过。

| 维度 | 实测值 | 怎么得到的 |
|---|---|---|
| 笔记总数 | 4321 | `gn.py inventory` |
| 课程划线摘录（`ref`/`class_audio`/`link`/`book`） | **4052（94%）** | 按 note `type` 统计 |
| 你自己的记录（`audio`/`meeting`/`internal_record`/`local_audio`/`plain_text`/`img_text`） | **269（6%）** | 同上 |
| 自建知识库 | 11 个 | `scope=DEFAULT` |
| 得到电子书自动书架 | 111 个 | `scope=BOOKSPACE` |
| 未归任何知识库 | 2055 条 | 无 `topics` |
| 同时在 2 个以上知识库的笔记 | **1 条** | 实测 |
| 有标签名的「知识库」与同名标签重复 | 110/122 | 实测 |
| 不同课程（目录）数 | 201 个 | 按 `_course_of` 聚合 |
| 只有 ≤3 条笔记的课程 | 115 个（共 203 条） | 实测 |
| 用到父笔记/子笔记 | 10 / 4326 | 官方 API 实测 |

**第一条结论（最重要）**：

> 这不是一个「知识库」，而是**两堆性质完全不同的东西**挤在一个容器里：
> 一堆是「得到卖给你的内容」的划线（4052 条，占 94%），
> 一堆是「你自己说的话/想的事」（269 条，占 6%）。

任何知识管理方法，如果对这两堆用同一套规则，必然有一边是错的。
下面所有决策都从这个区分出发。

---

## 1. 四套理论，各自到底在说什么

只取对「组织已有大量笔记」有用的部分，不复述全文。

### 1.1 PARA（Tiago Forte）

来源：[The PARA Method](https://fortelabs.com/blog/para/)（2023-02-24，2026-04-15 更新）

**核心主张**：按**可行动性**（actionability）组织，不按学科。四个顶层：Projects（有终点的短期努力）/ Areas（需持续维护的责任）/ Resources（感兴趣的主题）/ Archives（不再活跃但想留）。

原文最关键的一句：

> "Instead of organizing information according to broad subjects like in school, I advise you to organize it according to the projects and goals you are committed to right now."

以及他对层级的态度：

> "If your organizational system is as complex as your life, then the demands of maintaining it will end up robbing you of the time and energy you need to live that life."

**适用**：你自己的 269 条记录 —— 它们确实对应「我正在做的事」。
**不适用**：4052 条课程划线。它们没有「终点」，你不会「完成」万维钢的课；硬塞进 Projects 只会造出一堆永不关闭的假项目。

### 1.2 Zettelkasten（卢曼卡片盒）

来源：Ahrens《How to Take Smart Notes》(2017)；Luhmann《Communicating with Slip Boxes》(1992)

**核心主张**：笔记**原子化**（一条一个想法）+ 密集**互链**，靠链接而非文件夹生长出结构。

**适用**：需要你**自己写**原子笔记。
**不适用**：你的 4052 条是「一讲一条、一条里 20+ 个划线」的**捆绑包**，本质上不是原子笔记。把它们拆成原子笔记 = 4052 次人工编辑，投入产出比极差。

**这条要老实说**：Zettelkasten 对当前库几乎用不上。它的价值在你写那 269 条的时候。

### 1.3 MOC / 内容地图

**核心主张**：用一个「索引笔记」串起某个主题下的多条笔记，作为入口。
**适用**：主题已经清晰、但笔记散在多个知识库时。
**不适用**：现在还谈不上 —— 你连「哪个主题下有什么」都还没有稳定结构，先做 MOC 是空中楼阁。

### 1.4 渐进式总结 + Evergreen Notes

来源：[Progressive Summarization](https://fortelabs.com/blog/progressive-summarization-a-practical-technique-for-designing-discoverable-notes/)（2017-12-27）；[Evergreen notes](https://notes.andymatuschak.org/Evergreen_notes)（Andy Matuschak）

渐进式总结的分层：
- Layer 0 = 原文
- Layer 1 = 你摘进来的片段
- Layer 2 = 加粗其中精华
- Layer 3 = 高亮「精华中的精华」
- Layer 4 = 用**自己的话**写执行摘要
- Layer 5 = 重混成新东西（文章/图/分享）

**关键洞察（原文）**：这些层是「机会性压缩」—— 在**已经因为别的事在看这条笔记时**顺手加一层，不额外花时间。

Evergreen notes 的核心原则里，有一条直接打脸当前的树状结构：

> "Prefer associative ontologies to hierarchical taxonomies."

**你现在的库停在哪一层？** 实测：只有 Layer 0（原文）+ 平台自动生成的「AI 总结」。**Layer 2–4 一层都没有** —— 没有任何人工加粗/高亮/自己的话。

**这才是你真正缺的东西**，不是缺一个更花的分类树。

---

## 2. 于是：本插件的组织哲学（决策）

### 决策 1：两堆分开对待，不做统一分类

| | 4052 条课程划线 | 269 条自己的记录 |
|---|---|---|
| 组织依据 | **来源形状**（课程 → 书 → 讲） | **可行动性**（PARA） |
| 为什么 | 它们本来就是按来源生产的，来源就是最好的索引 | 你自己说的话天然对应「我在想什么/做什么」 |
| 谁来做 | 机器（已实现：树 / 自动归类） | 你 + AI 辅助（发芽/审问） |
| 反模式 | 按「主题」重分类（如强行归成「心理学」） | 塞进课程目录（会立刻失去时间线） |

**反面代价**：来源结构会保留「得到」的叙事框架（万维钢怎么讲，而不是你怎么想）。
**已否决的替代**：把 4052 条按主题重分类进 PARA。否决理由：这 4052 条平均一讲 21 个划线、内容跨主题极散（一门课里能横跨经济学到育儿），重分类等于让人工读 4052 条——不可执行。

### 决策 2：知识库是「来源桶」，不是「主题分类」

你现有的 11 个自建库名字（`icosa` `aisnip` `susan` `nemomeng的知识库` `university` `working` `fencing` `family` `chinese` `projectu` `caselib`）混合了至少三种语义：项目、人物、领域。

**结论**：不强行统一命名。但要在界面上**诚实显示**它们是什么（这也是我上一轮把「电子书书架」从「知识库」里拆出来的原因 —— 那 111 个是平台自动建的，不是你的分类）。

### 决策 3：树上做「浏览与批量搬运」，树上不做「思考」

树状层级适合：找东西、批量迁移、快速扫一眼。
树状层级**不适合**：发现跨领域的联系（这正是 Evergreen notes 说的 associative vs hierarchical）。

**结论**：
- 树 = 整理工具（拖拽、批量、撤销）
- 跨库连接 = AI 能力（发芽/审问）+ 检索，不是树

### 决策 4：AI 该做什么、不该做什么

基于上面的事实，AI 能力分三类，**严格区分**：

| 能力 | 做什么 | 为什么值得做 | 风险 |
|---|---|---|---|
| **发芽**（sprout） | 给一条笔记联想相关知识点、指出缺口、生成延伸问题 | 你原话就是这么用的：「让发芽一下，看能不能把沟通和另外两个做一个补充」 | 生成内容不是事实，必须标记为「AI 生成」 |
| **审问**（interrogate） | 对一条/一组笔记提问，逼出你自己的理解 | 对应渐进式总结 Layer 4「用自己的话重写」 | 同上 |
| **归类**（classify） | 按规则成批归库（已实现） | 2055 条手工点不可能 | 改错分类，可撤销 |

**三者都不能自动写入。** AI 输出先落成「建议」，人确认后才动作。这是本插件一以贯之的闸门。

---

## 3. 落到代码：现在实现了什么，还差什么

| 理论要求 | 现状 | 缺口 |
|---|---|---|
| PARA 的「按可行动性」 | 无 | 需要给 269 条自己的记录一个「我在做什么」的入口 |
| 原子化 + 互链 | 无 | 官方 API 无笔记间链接能力（父笔记只 10 条在用，且不可解除），**平台限制**，短期不做 |
| 渐进式总结 Layer 2–4 | 无 | 需要能对单条笔记加粗/高亮/写自己的话 → 需要写回笔记的能力 |
| associative vs hierarchical | 只有树 | 需要检索 + AI 联想视图 |
| 可行动性优先于完整性 | 树是完整浏览 | 需要「最近改过 / 待处理」这种工作队列视图 |

> 下一阶段优先级（按投入产出）：
> 1. **交互**：拖拽 + 撤销（正在做）—— 直接影响你每天的操作成本
> 2. **AI 动作**：发芽 / 审问（正在做）—— 把 269 条真正用起来
> 3. **写回**：把 AI 的 Layer 4 摘要写进笔记（需要 `note_update`，已有但属高危，需单独闸门）
> 4. **检索**：跨库找东西

---

## 4. 参考来源

- Tiago Forte, [The PARA Method](https://fortelabs.com/blog/para/), 2023-02-24
- Tiago Forte, [Progressive Summarization](https://fortelabs.com/blog/progressive-summarization-a-practical-technique-for-designing-discoverable-notes/), 2017-12-27
- Andy Matuschak, [Evergreen notes](https://notes.andymatuschak.org/Evergreen_notes)
- Sönke Ahrens, *How to Take Smart Notes*, 2017
- Niklas Luhmann, *Communicating with Slip Boxes*, 1992
- 得到大脑官方站 <https://www.biji.com/>；「笔记发芽」产品说明 <https://weqoocu.com/3295.html>（2026-01-01，GetSeed AI 录音卡）

---

## 5. 本文的诚实边界

- 「4052 / 269」是按 note `type` 字段分类的近似值。`plain_text`(63) 可能混有课程笔记，`ref` 也可能有你自己写的。数量级可信，个体归类可能有个别偏差。
- PARA / Zettelkasten / Evergreen 的原文我都取了作者一手页面，但**没有做学术文献交叉验证**。
- 「116 个课程只有 ≤3 条」这类判断来自本地镜像的一次快照，平台侧可能已变。
- 理论上最该做的「笔记间互链」，受官方 API 限制（无 link 端点，父笔记不可解除绑定）**当前做不了**，这不是设计选择而是平台约束。
