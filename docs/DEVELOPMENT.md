# CaseMate 开发文档

> 思源笔记测试用例管理插件 — 本文档面向后续开发者，包含架构说明、关键 API 格式、踩坑记录与开发流程，即使在新对话中也能据此继续开发。

---

## 1. 项目概述

| 项目 | 说明 |
| :--- | :--- |
| 插件名 | CaseMate（`plugin.json` 中 `name: "CaseMate"`） |
| 仓库 | https://github.com/Koto-Sakura/CaseMate |
| 基座模板 | siyuan-note/plugin-sample v0.4.8 |
| 技术栈 | TypeScript + Webpack 5 + esbuild-loader + SCSS |
| 思源最低版本 | v3.7.0 |
| 核心代码 | `src/index.ts`（约 1400 行，全部逻辑在单个文件） |
| 包管理 | pnpm |

**功能定位**：自动解析思源文档中的测试用例 → 写入"测试执行库"（数据库）→ 跟踪执行状态 → 统计与筛选。

---

## 2. 已完成功能（v0.1.3）

| 功能 | 入口 | 说明 |
| :--- | :--- | :--- |
| 文档解析为用例 | 右键文档 →「解析为测试用例」 | 启发式解析：标题下含列表内容（`- 操作步骤` 等）即视为用例 |
| 自动轮询 | 每 3 秒（可配置） | 监控"用例文档库"新增记录，自动解析 |
| 状态自动填充 | 自动 | 新记录默认「未测试」 |
| 时间自动记录 | 自动 | 状态变为「通过」/「待修复」时填入执行日期 |
| 项目名称自动填充 | 自动 | 通过 `getHPathByID` 取父文档名 |
| 主键跳转 | 自动 | 主键关联到文档中具体标题块，点击跳转 |
| 去重保护 | 自动 | `docExistsInExecDB` 防止重复解析 |
| 数据统计 | 右键数据库 →「数据统计」 | 列筛选 + 智能匹配/正则 + 分组统计 |
| 智能筛选 | 右键数据库 →「智能筛选」 | DOM 行隐藏，临时过滤，支持范围/通配符/多值(OR) |
| 设置持久化 | 设置面板 | 配置重启保留 |
| 国际化 | — | 中英文 |

---

## 3. 代码结构（src/index.ts）

### 3.1 顶层工具函数

| 函数 | 行号 | 用途 |
| :--- | :--- | :--- |
| `fetchPostAsync<T>` | 70 | 把思源 `fetchPost` 回调封装为 Promise |
| `buildFieldMap` | 83 | 字段名 → 字段ID 映射 |
| `findPrimaryKeyField` | 92 | 找 block 类型主键字段 |
| `getCellBlockID` | 98 | 从单元格值提取关联的 blockID |
| `isHeadingLine` | 106 | 判断标题行 |
| `hasListContent` | 114 | 判断内容区是否含列表（用例判定依据） |
| `extractTestCases` | 123 | **核心解析器**：返回 `CaseInfo[]`（名称+标题块ID） |
| `getFieldText` | 1329 | 从 getAttributeView 值对象提取文本 |
| `escapeRegex` | 1342 | 正则转义 |
| `parseNumRange` | 1347 | 解析序号范围 `1.9~1.13` → 前缀数组 |
| `matchSmart` | 1375 | **智能匹配**：前缀/范围/通配符/包含 |

### 3.2 CaseMatePlugin 类方法

| 方法 | 行号 | 用途 |
| :--- | :--- | :--- |
| `onload` | 180 | 加载配置、构建设置面板 |
| `onLayoutReady` | 195 | 顶栏按钮、注册事件、启动轮询 |
| `onunload` | 211 | 停止轮询、解绑事件 |
| `buildSetting` | 220 | 设置面板（两个库ID、轮询间隔、排除关键词等） |
| `startPolling/stopPolling/restartPolling` | 315-343 | 轮询管理 |
| `poll` | 347 | 主轮询：用例库 + 执行库 |
| `renderAV` | 362 | 调 `/api/av/renderAttributeView` |
| `getAVItemIDs` | 382 | 调 `/api/av/getAttributeView` 取 itemID 列表 |
| `getAVFieldDefs` | 404 | 获取字段定义（列名/类型/ID） |
| `getExecFieldMap` | 412 | 执行库字段名→ID 映射（带缓存） |
| `pollCaseDatabase` | 424 | **轮询用例库**：检测新文档 |
| `docExistsInExecDB` | 492 | 去重检查 |
| `getParentDocName` | 511 | 取项目名称（父文档名） |
| `parseDocumentAndCreateRecords` | 530 | **解析文档并创建执行记录**（两段式） |
| `pollExecutionDatabase` | 670 | **轮询执行库**：状态变更→记录时间 |
| `onDocTreeMenu` | 780 | 文档树右键菜单 |
| `onAVMenu` | 988 | 数据库右键菜单（智能筛选+数据统计） |
| `showFilterDialog` | 1099 | 智能筛选对话框（DOM 行隐藏） |
| `runStatistics` | 1224 | 数据统计核心逻辑 |

---

## 4. 关键 API 与值格式（踩坑汇总）

> ⚠️ 以下格式均经过实测/源码验证，**不要随意修改**。改错会导致功能失效。

### 4.1 查询数据库

```typescript
// 方式一：渲染视图（注意：执行库会返回 0 行！只有用例库正常）
POST /api/av/renderAttributeView
{ id: avID, page: 1, pageSize: 9999, createIfNotExist: true }
// 响应: data.view.columns[] / data.view.rows[]
// ⚠️ 坑1: pageSize 不能传 -1（某些版本不支持）
// ⚠️ 坑2: 执行库返回 0 行，读取数据必须用 getAttributeView

// 方式二：原始数据（可靠，读取任何数据库都用这个）
POST /api/av/getAttributeView
{ id: avID }
// 响应: data.av.keyValues[]（含 key.name/type + values[]）
//       data.av.views[0].itemIds[]（所有记录ID）
```

### 4.2 创建记录（两段式！）

`appendAttributeViewDetachedBlocksWithValues` **不能一次性设置所有字段**（块引用和状态会失败）。必须分两步：

```typescript
// 第一步：只创建含文本字段的行（不含主键/状态！）
POST /api/av/appendAttributeViewDetachedBlocksWithValues
{ avID, blocksValues: [[{ keyID, text: { content: "项目名" } }]] }
// ⚠️ 坑: 该 API 返回 null，无法直接拿到新行 ID

// 第二步：等 500ms 后，对比 getAVItemIDs 前后差值找到新行ID
const beforeIDs = await this.getAVItemIDs(avID);
// ... 创建 ...
await new Promise(r => setTimeout(r, 500));
const afterIDs = await this.getAVItemIDs(avID);
const newIDs = afterIDs.filter(id => !beforeIDs.includes(id));

// 第三步：逐行设置字段
POST /api/av/setAttributeViewBlockAttr
{
  avID, keyID, itemID,
  value: {
    type: "block",
    block: { id: 标题块ID, content: "用例名" }   // 主键：必须 id+content 都有
  }
}
```

### 4.3 字段值格式（Go 源码 av/value.go 验证）

| 字段类型 | value 格式 | 备注 |
| :--- | :--- | :--- |
| block（主键） | `{ type: "block", block: { id, content } }` | **id+content 缺一不可**，否则不显示/不可跳转 |
| text | `{ type: "text", text: { content } }` | |
| select/mSelect | `{ mSelect: [{ content, color }] }` | ⚠️ 单选也用 `mSelect` 数组！不是 `select`/`option` |
| date | `{ date: { content: 时间戳ms, isNotEmpty: true } }` | content 为数字毫秒 |

> ⚠️ 曾试错过的错误格式（勿用）：`{ select: { option: ... } }`、`{ option: { name } }`、`{ type: "date", date: {...} }` 均可致字段为空。

### 4.4 事件监听

```typescript
// 文档树右键（detail.elements 是数组！不是 blockElements）
this.eventBus.on("open-menu-doctree", ...);
// detail: { elements: NodeList, menu, type }
// 取块ID: 遍历 detail.elements 的 dataset.nodeId（向上遍历父级兜底）

// 数据库右键（detail.element 是数据库块元素，带 data-av-id / data-node-id）
this.eventBus.on("open-menu-av", ...);
// 取数据库ID: detail.element.getAttribute("data-av-id")
// 取块ID: detail.element.getAttribute("data-node-id")
```

### 4.5 获取文档/父文档信息

```typescript
// 文档内容
POST /api/block/getBlockKramdown
{ id: blockID }   // 响应 data 是对象 { kramdown, id }！不是字符串！

// 可读路径（取父文档名用）
POST /api/filetree/getHPathByID
{ id: blockID }   // 响应 data 是字符串，如 "/父文档/子文档"
// 项目名 = hPath.split("/").filter(Boolean)[倒数第2段]
```

---

## 5. 核心实现细节

### 5.1 用例解析（启发式）

```
标题行（### / #### 任意层级）
  └─ 标题后到下一个标题之间的内容，若存在 `- ` 开头列表 → 判定为用例
  └─ 排除配置中的关键词（如"正向主流程"）
  └─ 从标题后的属性行 {: id="xxx"} 提取标题块ID → 用于主键跳转
```

### 5.2 创建执行记录流程（parseDocumentAndCreateRecords）

```
1. getBlockKramdown 取文档内容
2. extractTestCases 解析用例（名称+标题块ID）
3. getExecFieldMap 取字段映射（兼容"项目名称"与"用例名称"）
4. getParentDocName 取父文档名 → 项目名称
5. docExistsInExecDB 去重（已存在则跳过）
6. 两段式创建：建行 → 等500ms → 找新行ID → 逐行设字段
```

### 5.3 时间自动记录（pollExecutionDatabase）

```
1. getAttributeView 读取执行库
2. 从 keyValues 提取状态列、日期列的值（itemID → 值 映射）
3. 与内存快照 knownExecRecords 对比
4. 状态变化 → 变为"通过/待修复" → setAttributeViewBlockAttr 写日期
5. 更新内存快照，防止重复触发
```

### 5.4 智能匹配（matchSmart）

| 用户输入 | 匹配逻辑 |
| :--- | :--- |
| `1.9`（纯数字序号） | 前缀匹配（`val === cond \|\| val.startsWith(cond + ".")`） |
| `1.9~1.13` / `1.9-1.13` | 解析范围，生成所有前缀，任一匹配 |
| `*登录*` / `*x` / `x*` | 通配符 → 转正则 |
| 其他文本 | 包含匹配 |

### 5.5 智能筛选（showFilterDialog）

```
1. getAttributeView 读数据
2. 目标列值用 matchSmart 匹配 → matchedIDs 集合
3. 遍历数据库 DOM 行元素（.av__row[data-id] / .av__gallery-item[data-id] / .av__kanban-item[data-id]）
4. 不匹配的 display="none"，匹配的恢复
5. 「清除筛选」恢复所有行
⚠️ 临时过滤：刷新/重新加载数据库后恢复
```

### 5.6 数据统计（runStatistics）

```
1. getAttributeView 读数据
2. 过滤列 + 智能匹配/正则 → 匹配行
3. 按分组列动态分组统计（不硬编码状态列表，自动含"废弃"等新增值）
4. 结果表格展示：分组值/数量/占比
```

---

## 6. 环境与开发流程

### 6.1 本地开发环境

```
开发目录: D:\code\codes\CaseMate
思源工作空间: F:\Notes\SiYuanNotes
插件软链接: F:\Notes\SiYuanNotes\data\plugins\CaseMate → D:\code\codes\CaseMate
```

**软链接必须指向项目根目录**（不要指向 dist/），因为开发模式下产物输出到根目录：
- `pnpm run dev:app` → 输出 `index.js`、`index.css` 到项目根目录
- 思源中 `Ctrl+R` 刷新插件

### 6.2 常用命令

```bash
pnpm install        # 安装依赖
pnpm run dev:app    # 开发编译（--no-watch 单次编译）
pnpm run build      # 生产构建（输出 dist/ + package.zip）
pnpm run lint       # 代码检查
pnpm run format     # 代码格式化
```

> ⚠️ 手动单次编译（避免 watch 挂起）：`npx webpack --config webpack.config.js --mode development --no-watch`

### 6.3 调试方法

1. 思源中按 `F12` 打开开发者工具
2. 控制台有大量 `CaseMate:` 前缀日志（onload/轮询/解析/统计）
3. 所有关键 API 调用都有 `console.log` 输出
4. 修改 `src/index.ts` 后编译 + `Ctrl+R` 刷新

### 6.4 远程仓库

```bash
# remote 已配置为 SSH（git@github.com:Koto-Sakura/CaseMate.git）
git push origin master   # 无需代理，走 22 端口
# 提交信息用中文
```

---

## 7. 已知限制与注意事项

| 限制 | 说明 |
| :--- | :--- |
| 执行库字段名 | 需为「项目名称」「状态」「执行日期」，代码兼容旧名"用例名称" |
| 智能筛选临时性 | DOM 隐藏不持久化，刷新后恢复（用户已确认可接受） |
| 官方筛选 API 限制 | `setAttrViewFilters` 多条件是 AND 语义，无法表达 OR/范围（故自研 DOM 方案） |
| 文档格式依赖 | 用例标题下必须有列表内容，否则无法解析 |
| 执行库无法用 renderAV | 读取执行库数据必须用 getAttributeView（renderAV 返回 0 行） |
| 轮询性能 | 默认 3 秒，数据库记录多时注意 CPU |
| 数据恢复 | 思源数据库数据在 `data/storage/av/*.json`，文档在 `data/**/*.sy`，有 history 备份 |

---

## 8. 后续开发计划（未实现）

| 功能 | 说明 |
| :--- | :--- |
| 可视化看板 | 测试执行进度统计图表 |
| 报告导出 | 导出测试执行报告 |
| 批量操作 | 批量修改状态、批量重新解析 |
| 智能筛选持久化 | 目前是临时 DOM 过滤，未来可探索持久化方案 |
| 内核插件 | kernel.ts 目前是占位，MVP 不需要 |

---

## 9. 配置项说明（设置面板）

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| 用例文档库 ID | 空 | 用例文档库的 Attribute View ID |
| 测试执行库 ID | 空 | 测试执行库的 Attribute View ID |
| 轮询间隔 | 3 秒 | 检测新文档频率（1-30） |
| 忽略的标题关键词 | 正向主流程,异常分支,... | 这些标题不视为用例 |
| 自动记录时间 | 开 | 状态变为通过/待修复时记时间 |
| 回退清空时间 | 关 | 状态改回未测试时清空日期 |

---

## 10. Git 提交历史

```
e784bc0 新增智能筛选功能，支持任意数据库临时过滤
1af2ac0 数据统计功能通用化，支持任意数据库
c3d8b61 数据统计新增智能匹配，降低使用门槛
ff5c4f9 调整 README 默认语言为中文
e25dd5b 新增数据统计功能并支持正则匹配
5c3a974 CaseMate MVP Phase 1 完成
0000554 CaseMate初始化
```
