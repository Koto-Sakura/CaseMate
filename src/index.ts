import {
    Plugin,
    showMessage,
    Setting,
    fetchPost,
} from "siyuan";
import "./index.scss";

// ── Types ─────────────────────────────────────────────────────────────────

interface CaseMateConfig {
    caseDBID: string;
    execDBID: string;
    pollInterval: number;
    excludeKeywords: string;
    autoRecordTime: boolean;
    clearTimeOnReset: boolean;
}

interface FieldDef {
    id: string;
    name: string;
    type: string;
}

interface RowCell {
    value: any;
}

interface RenderViewResponse {
    id: string;
    name: string;
    viewType: string;
    viewID: string;
    view: {
        columns: FieldDef[];
        rows: {
            id: string;
            cells: Record<string, RowCell>;
        }[];
        rowCount: number;
    };
}

const DEFAULT_CONFIG: CaseMateConfig = {
    caseDBID: "",
    execDBID: "",
    pollInterval: 3,
    excludeKeywords: "正向主流程,异常分支,界面校验,兼容性,安全性,UI 适配,完整链路回归测试",
    autoRecordTime: true,
    clearTimeOnReset: false,
};

const POLL_INTERVAL_MIN = 1;
const POLL_INTERVAL_MAX = 30;

// 执行库的状态字段值
const STATUS_UNTESTED = "未测试";
const STATUS_PASSED = "通过";
const STATUS_NEEDS_FIX = "待修复";

// 执行库的字段名（用户创建数据库时需使用这些名称）
const FIELD_PROJECT_NAME = "项目名称";
const FIELD_STATUS = "状态";
const FIELD_EXEC_DATE = "执行日期";

// ── Utilities ──────────────────────────────────────────────────────────────

function fetchPostAsync<T = any>(url: string, data: any): Promise<T> {
    return new Promise((resolve, reject) => {
        fetchPost(url, data, (response: any) => {
            if (response.code === 0) {
                resolve(response.data as T);
            } else {
                reject(new Error(response.msg || `API error: ${url}`));
            }
        });
    });
}

/** 从 renderAttributeView 响应中提取字段名 → keyID 的映射 */
function buildFieldMap(columns: FieldDef[]): Record<string, string> {
    const map: Record<string, string> = {};
    for (const col of columns) {
        map[col.name] = col.id;
    }
    return map;
}

/** 从 renderAttributeView 列信息中找出主键（block类型）字段ID */
function findPrimaryKeyField(columns: FieldDef[]): FieldDef | undefined {
    // 第一个 block 类型的字段通常是主键
    return columns.find(c => c.type === "block");
}

/** 从单元格值中提取关联的 blockID */
function getCellBlockID(cell: RowCell): string | undefined {
    if (!cell || !cell.value) return undefined;
    const v = cell.value;
    if (v.block && v.block.id) return v.block.id;
    if (v.type === "block" && v.id) return v.id;
    return undefined;
}

function isHeadingLine(line: string): { isHeading: boolean; level: number; text: string } {
    const m = line.match(/^(#{1,6})\s+(.+)/);
    if (m) {
        return { isHeading: true, level: m[1].length, text: m[2].trim() };
    }
    return { isHeading: false, level: 0, text: "" };
}

function hasListContent(lines: string[]): boolean {
    return lines.some(l => /^\s*[-*]\s/.test(l.trim()));
}

interface CaseInfo {
    name: string;
    blockID: string;
}

function extractTestCases(kramdown: string, excludeKeywords: string[]): CaseInfo[] {
    const lines = kramdown.split("\n");
    const headings: { level: number; text: string; lineIndex: number }[] = [];

    for (let i = 0; i < lines.length; i++) {
        const r = isHeadingLine(lines[i]);
        if (r.isHeading) {
            headings.push({ level: r.level, text: r.text, lineIndex: i });
        }
    }

    if (headings.length === 0) return [];

    const cases: CaseInfo[] = [];
    for (let i = 0; i < headings.length; i++) {
        const h = headings[i];
        const nextH = headings[i + 1];
        if (excludeKeywords.some(kw => h.text.includes(kw))) continue;

        const contentStart = h.lineIndex + 1;
        const contentEnd = nextH ? nextH.lineIndex : lines.length;
        const contentLines = lines.slice(contentStart, contentEnd);

        if (hasListContent(contentLines)) {
            // 从 kramdown 属性行中提取标题块的 ID: {: id="xxx" ...}
            let blockID = "";
            for (let j = 1; j <= 2 && h.lineIndex + j < lines.length; j++) {
                const attrLine = lines[h.lineIndex + j].trim();
                const m = attrLine.match(/\{:.*\sid="([^"]+)"/);
                if (m) { blockID = m[1]; break; }
            }
            cases.push({ name: h.text, blockID });
        }
    }
    return cases;
}

// ── Plugin Main Class ──────────────────────────────────────────────────────

const STORAGE_NAME = "case-mate-config";

export default class CaseMatePlugin extends Plugin {
    private config: CaseMateConfig = { ...DEFAULT_CONFIG };
    private pollTimer: number | null = null;

    // 已知记录快照：Map<blockID, recordID>
    private knownCaseRecords: Map<string, string> = new Map();
    // 执行库快照：Map<recordID, { status: string; execDate: string }>
    private knownExecRecords: Map<string, { status: string; execDate: string }> = new Map();
    private firstPollComplete = false;

    // 缓存执行库的字段映射，避免每次查询
    private execFieldCache: Record<string, string> | null = null;
    private cachedExecDBID: string = "";

    // ── 生命周期 ────────────────────────────────────────────────────────────

    async onload() {
        console.log("CaseMate onload");
        try {
            const data = await this.loadData(STORAGE_NAME);
            if (data && typeof data === "object") {
                this.config = { ...DEFAULT_CONFIG, ...data };
                console.log("CaseMate config loaded:", JSON.stringify(this.config));
            }
        } catch (e) {
            console.log("CaseMate loadData failed, using defaults:", e);
            this.config = { ...DEFAULT_CONFIG };
        }
        this.buildSetting();
    }

    onLayoutReady() {
        console.log("CaseMate onLayoutReady, config:", JSON.stringify(this.config));
        this.addTopBar({
            icon: "iconCheck",
            title: "CaseMate",
            position: "right",
            callback: () => {
                // 直接打开插件设置面板
                this.setting.open("CaseMate");
            },
        });
        this.eventBus.on("open-menu-doctree", this.onDocTreeMenu.bind(this));
        this.startPolling();
    }

    onunload() {
        console.log("CaseMate onunload");
        this.stopPolling();
        this.eventBus.off("open-menu-doctree", this.onDocTreeMenu.bind(this));
    }

    // ── 设置面板 ────────────────────────────────────────────────────────────

    private buildSetting() {
        const caseDBInput = document.createElement("input");
        caseDBInput.className = "b3-text-field fn__block";
        caseDBInput.placeholder = "请输入用例文档库的 Attribute View ID";
        caseDBInput.value = this.config.caseDBID;

        const execDBInput = document.createElement("input");
        execDBInput.className = "b3-text-field fn__block";
        execDBInput.placeholder = "请输入测试执行库的 Attribute View ID";
        execDBInput.value = this.config.execDBID;

        const intervalInput = document.createElement("input");
        intervalInput.className = "b3-text-field fn__block";
        intervalInput.type = "number";
        intervalInput.min = String(POLL_INTERVAL_MIN);
        intervalInput.max = String(POLL_INTERVAL_MAX);
        intervalInput.value = String(this.config.pollInterval);

        const excludeInput = document.createElement("input");
        excludeInput.className = "b3-text-field fn__block";
        excludeInput.placeholder = "正向主流程,异常分支,界面校验,...";
        excludeInput.value = this.config.excludeKeywords;

        const autoRecordCheck = document.createElement("input");
        autoRecordCheck.type = "checkbox";
        autoRecordCheck.checked = this.config.autoRecordTime;

        const clearOnResetCheck = document.createElement("input");
        clearOnResetCheck.type = "checkbox";
        clearOnResetCheck.checked = this.config.clearTimeOnReset;

        this.setting = new Setting({
            confirmCallback: () => {
                this.config.caseDBID = caseDBInput.value.trim();
                this.config.execDBID = execDBInput.value.trim();
                this.config.pollInterval = Math.max(POLL_INTERVAL_MIN,
                    Math.min(POLL_INTERVAL_MAX, parseInt(intervalInput.value) || 3));
                this.config.excludeKeywords = excludeInput.value.trim();
                this.config.autoRecordTime = autoRecordCheck.checked;
                this.config.clearTimeOnReset = clearOnResetCheck.checked;

                this.saveData(STORAGE_NAME, this.config).then(() => {
                    showMessage(this.i18n.saveSuccess);
                    this.restartPolling();
                }).catch((e: any) => {
                    showMessage(`${this.i18n.saveFail}: ${e}`);
                });
            },
        });

        this.setting.addItem({
            title: this.i18n.caseDBID,
            direction: "row",
            description: this.i18n.caseDBIDHint,
            createActionElement: () => caseDBInput,
        });

        this.setting.addItem({
            title: this.i18n.execDBID,
            direction: "row",
            description: this.i18n.execDBIDHint,
            createActionElement: () => execDBInput,
        });

        this.setting.addItem({
            title: this.i18n.pollInterval,
            direction: "row",
            description: this.i18n.pollIntervalHint,
            createActionElement: () => intervalInput,
        });

        this.setting.addItem({
            title: this.i18n.excludeKeywords,
            direction: "row",
            description: this.i18n.excludeKeywordsHint,
            createActionElement: () => excludeInput,
        });

        this.setting.addItem({
            title: this.i18n.autoRecordTime,
            direction: "row",
            description: this.i18n.autoRecordTimeHint,
            createActionElement: () => autoRecordCheck,
        });

        this.setting.addItem({
            title: this.i18n.clearTimeOnReset,
            direction: "row",
            description: this.i18n.clearTimeOnResetHint,
            createActionElement: () => clearOnResetCheck,
        });
    }

    // ── 轮询管理 ────────────────────────────────────────────────────────────

    private startPolling() {
        this.stopPolling();
        const intervalMs = (this.config.pollInterval || 3) * 1000;
        this.pollTimer = window.setInterval(() => {
            this.poll().catch(err => {
                console.warn("CaseMate poll error:", err);
            });
        }, intervalMs);
        this.poll().catch(err => {
            console.warn("CaseMate first poll error:", err);
        });
    }

    private stopPolling() {
        if (this.pollTimer !== null) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.firstPollComplete = false;
    }

    private restartPolling() {
        this.knownCaseRecords.clear();
        this.knownExecRecords.clear();
        this.execFieldCache = null;
        this.cachedExecDBID = "";
        this.firstPollComplete = false;
        this.startPolling();
    }

    // ── 轮询主逻辑 ──────────────────────────────────────────────────────────

    private async poll() {
        console.log("CaseMate poll tick, caseDBID=", this.config.caseDBID, "execDBID=", this.config.execDBID);
        if (!this.config.caseDBID && !this.config.execDBID) return;

        if (this.config.caseDBID) {
            await this.pollCaseDatabase();
        }
        if (this.config.execDBID) {
            await this.pollExecutionDatabase();
        }
        this.firstPollComplete = true;
    }

    // ── 渲染数据库视图（通用方法） ──────────────────────────────────────────

    private async renderAV(avID: string): Promise<RenderViewResponse> {
        try {
            const data: any = await fetchPostAsync("/api/av/renderAttributeView", {
                id: avID,
                page: 1,
                pageSize: 9999,
                createIfNotExist: true,
            });
            if (!data || !data.view) {
                console.warn("CaseMate renderAV: 返回结构异常", JSON.stringify(data).substring(0, 200));
                return { id: avID, name: "", viewType: "", viewID: "", view: { columns: [], rows: [], rowCount: 0 } };
            }
            return data as RenderViewResponse;
        } catch (e: any) {
            console.warn("CaseMate renderAV error:", e.message || e);
            return { id: avID, name: "", viewType: "", viewID: "", view: { columns: [], rows: [], rowCount: 0 } };
        }
    }

    /** 使用 getAttributeView 获取数据库的原始 itemID 列表（不依赖视图渲染） */
    private async getAVItemIDs(avID: string): Promise<string[]> {
        try {
            const data: any = await fetchPostAsync("/api/av/getAttributeView", {
                id: avID,
            });
            const views = data?.av?.views;
            if (views && views.length > 0) {
                // 使用第一个视图的 itemIds
                const ids = views[0].itemIds;
                console.log("CaseMate getAVItemIDs:", ids?.length || 0, "items");
                return ids || [];
            }
            console.warn("CaseMate getAVItemIDs: 无视图", JSON.stringify(data).substring(0, 100));
            return [];
        } catch (e: any) {
            console.warn("CaseMate getAVItemIDs error:", e.message || e);
            return [];
        }
    }

    // ── 获取数据库原始定义（用于获取字段信息） ──────────────────────────────

    private async getAVFieldDefs(avID: string): Promise<FieldDef[]> {
        // 使用 renderAttributeView 的 columns 即可获得字段信息
        const resp = await this.renderAV(avID);
        return resp.view?.columns || [];
    }

    // ── 获取执行库的字段映射（带缓存） ──────────────────────────────────────

    private async getExecFieldMap(): Promise<Record<string, string>> {
        if (this.execFieldCache && this.cachedExecDBID === this.config.execDBID) {
            return this.execFieldCache;
        }
        const fields = await this.getAVFieldDefs(this.config.execDBID);
        this.execFieldCache = buildFieldMap(fields);
        this.cachedExecDBID = this.config.execDBID;
        return this.execFieldCache;
    }

    // ── 检测用例文档库 ──────────────────────────────────────────────────────

    private async pollCaseDatabase() {
        console.log("CaseMate pollCaseDatabase start");
        try {
            const resp = await this.renderAV(this.config.caseDBID);
            console.log("CaseMate pollCaseDatabase: got", resp.view?.rows?.length || 0, "rows");
            const columns = resp.view?.columns || [];
            const rows = resp.view?.rows || [];

            // 找到主键（block类型）字段
            const pkField = findPrimaryKeyField(columns);
            if (!pkField) {
                console.warn("CaseMate: 用例文档库缺少 block 类型的主键字段");
                console.log("CaseMate: columns=", JSON.stringify(columns.map(c => ({name: c.name, type: c.type}))));
                return;
            }
            // 找出主键字段在 columns 数组中的索引（用于适配 cells 为数组的情况）
            const pkIndex = columns.findIndex(c => c.id === pkField.id);

            for (const row of rows) {
                let blockID: string | undefined;

                // 尝试按字段ID获取（cells 是对象）
                const cellById = row.cells[pkField.id];
                if (cellById) {
                    blockID = getCellBlockID(cellById);
                }

                // 尝试按列索引获取（cells 是数组）
                if (!blockID && pkIndex >= 0) {
                    const cellByIndex = row.cells[String(pkIndex)];
                    if (cellByIndex) {
                        blockID = getCellBlockID(cellByIndex);
                    }
                    // 也尝试数字索引
                    if (!blockID) {
                        const cellByNumIdx = row.cells[pkIndex];
                        if (cellByNumIdx) {
                            blockID = getCellBlockID(cellByNumIdx);
                        }
                    }
                }

                console.log("CaseMate: row id=", row.id, "blockID=", blockID, "cells keys=", Object.keys(row.cells));
                if (!blockID) continue;

                if (!this.firstPollComplete) {
                    this.knownCaseRecords.set(blockID, row.id);
                    console.log("CaseMate: 首次轮询记录 blockID=", blockID);
                    continue;
                }

                // 检测到新文档
                if (!this.knownCaseRecords.has(blockID)) {
                    console.log("CaseMate: 检测到新文档 blockID=", blockID);
                    this.knownCaseRecords.set(blockID, row.id);
                    this.parseDocumentAndCreateRecords(blockID).catch(err => {
                        console.warn("CaseMate parse error for", blockID, err);
                    });
                } else {
                    console.log("CaseMate: 已知文档, 跳过 blockID=", blockID);
                }
            }
        } catch (e: any) {
            console.warn("CaseMate pollCaseDatabase error:", e.message || e);
        }
    }

    /** 使用 getAttributeView 检查文档是否已在执行库中存在 */
    private async docExistsInExecDB(blockID: string): Promise<boolean> {
        try {
            const rawData: any = await fetchPostAsync("/api/av/getAttributeView", {
                id: this.config.execDBID,
            });
            const keyValues: any[] = rawData?.av?.keyValues || [];
            // 找到 block 类型（主键）字段
            for (const kv of keyValues) {
                if (kv.key?.type === "block") {
                    for (const v of (kv.values || [])) {
                        if (v.block?.id === blockID) return true;
                    }
                }
            }
        } catch (_) { /* ignore */ }
        return false;
    }

    /** 获取项目名称 — 通过 hPath 取父文档名称，根文档则取自身 */
    private async getParentDocName(blockID: string): Promise<string> {
        try {
            const hPath: string = await fetchPostAsync("/api/filetree/getHPathByID", { id: blockID });
            console.log("CaseMate: hPath =", hPath);
            const segments = hPath.split("/").filter(Boolean);
            if (segments.length >= 2) {
                // segments[len-1] = 当前文档, segments[len-2] = 父文档
                return segments[segments.length - 2];
            }
            // hPath 不正常时返回空
            return "";
        } catch (e: any) {
            console.warn("CaseMate: getParentDocName error:", e.message || e);
            return "";
        }
    }

    // ── 解析文档并创建执行记录 ─────────────────────────────────────────────

    private async parseDocumentAndCreateRecords(blockID: string) {
        if (!this.config.execDBID) {
            showMessage(this.i18n.needConfig);
            return;
        }

        // 1. 读取文档内容
        let kramdownResp: any;
        try {
            kramdownResp = await fetchPostAsync("/api/block/getBlockKramdown", { id: blockID });
            console.log("CaseMate: getBlockKramdown resp:", JSON.stringify(kramdownResp));
        } catch (e: any) {
            showMessage(`读取文档失败: ${e.message || e}`);
            return;
        }
        const kramdown: string = kramdownResp?.kramdown || kramdownResp?.content || "";
        if (!kramdown) {
            console.log("CaseMate: kramdown为空, resp=", kramdownResp);
            return;
        }

        // 2. 解析用例
        const excludeList = this.config.excludeKeywords
            .split(",").map(s => s.trim()).filter(s => s.length > 0);

        const cases = extractTestCases(kramdown, excludeList);
        if (cases.length === 0) {
            showMessage(this.i18n.parseEmpty);
            return;
        }

        // 3. 获取执行库字段映射
        let fieldMap: Record<string, string>;
        try {
            fieldMap = await this.getExecFieldMap();
        } catch (e: any) {
            showMessage(`获取执行库字段信息失败: ${e.message || e}`);
            return;
        }

        const projectKeyID = fieldMap[FIELD_PROJECT_NAME] || fieldMap["用例名称"];
       const primaryField = (await this.getAVFieldDefs(this.config.execDBID))
           .find(f => f.type === "block");
        const primaryKeyID = primaryField?.id;

        if (!primaryKeyID) {
            showMessage("执行库缺少主键块字段，请检查数据库结构");
            return;
        }

        // 获取父文档名称作为项目名称
        const projectName = await this.getParentDocName(blockID);
        console.log("CaseMate: projectName =", projectName);

        // 4. 去重检查 — 如果文档已在执行库中，跳过
        try {
            if (await this.docExistsInExecDB(blockID)) {
                console.log("CaseMate: 文档已在执行库中，跳过", blockID);
                return;
            }
        } catch (_) { /* ignore */ }

        // 5. 创建执行记录 — 两段式：先创建行，再单独设置字段
        try {
            // 第一步：用 getAttributeView 获取当前 itemID 基线
            const beforeIDs = await this.getAVItemIDs(this.config.execDBID);
            console.log("CaseMate: 创建前 item 数 =", beforeIDs.length);

            // 创建仅含文本字段的行（项目名称）
            const blocksValues: any[][] = [];
            for (let i = 0; i < cases.length; i++) {
                const rowVals: any[] = [];
                // 如果有项目名称字段，填入该字段
                if (projectKeyID) {
                    rowVals.push({ keyID: projectKeyID, text: { content: projectName } });
                }
                blocksValues.push(rowVals);
            }

            console.log("CaseMate: 创建", blocksValues.length, "条记录");
            await fetchPostAsync("/api/av/appendAttributeViewDetachedBlocksWithValues", {
                avID: this.config.execDBID,
                blocksValues,
            });

            // 第二步：等500ms后重新获取 itemID，找到新增的行
            await new Promise(r => setTimeout(r, 500));
            const afterIDs = await this.getAVItemIDs(this.config.execDBID);
            const newIDs = afterIDs.filter(id => !beforeIDs.includes(id));
            console.log("CaseMate: 创建后 item 数 =", afterIDs.length, "新增 =", newIDs.length);

            // 第三步：为每个新行设置块引用（指向用例标题块）和状态
            for (let i = 0; i < newIDs.length && i < cases.length; i++) {
                const itemID = newIDs[i];
                const c = cases[i];
                // 设置块引用 — 指向用例标题块，不是文档根节点
                await fetchPostAsync("/api/av/setAttributeViewBlockAttr", {
                    avID: this.config.execDBID,
                    keyID: primaryKeyID,
                    itemID,
                    value: {
                        type: "block",
                        block: { id: c.blockID || blockID, content: c.name },
                    },
                });
                // 设置状态默认值
                const statusKeyID = fieldMap[FIELD_STATUS];
                if (statusKeyID) {
                    try {
                        const valueObj = {
                            mSelect: [{ content: STATUS_UNTESTED }],
                        };
                        const result = await fetchPostAsync("/api/av/setAttributeViewBlockAttr", {
                            avID: this.config.execDBID,
                            keyID: statusKeyID,
                            itemID,
                            value: valueObj,
                        });
                        console.log("CaseMate: setStatus OK", JSON.stringify(result).substring(0, 100));
                    } catch (e: any) {
                        console.warn("CaseMate: setStatus error", e.message || e);
                    }
                }
            }
            console.log("CaseMate: 已更新", Math.min(newIDs.length, cases.length), "条记录的字段");

            showMessage(
                this.i18n.parseComplete
                    .replace("{count}", String(cases.length))
                    .replace("{docCount}", "1"),
            );

            this.execFieldCache = null;
        } catch (e: any) {
            showMessage(`创建执行记录失败: ${e.message || e}`);
        }
    }

    // ── 检测执行库状态变化 → 自动记录时间 ──────────────────────────────────

    private async pollExecutionDatabase() {
        console.log("CaseMate pollExecutionDatabase start");
        try {
            const fieldMap = await this.getExecFieldMap();
            const statusKeyID = fieldMap[FIELD_STATUS];
            const dateKeyID = fieldMap[FIELD_EXEC_DATE];

            if (!statusKeyID) return;

            // 使用 getAttributeView 读取原始数据（而不是 renderAttributeView）
            const rawData: any = await fetchPostAsync("/api/av/getAttributeView", {
                id: this.config.execDBID,
            });
            const keyValues: any[] = rawData?.av?.keyValues || [];
            const itemIDs: string[] = rawData?.av?.views?.[0]?.itemIds || [];

            // 构建 per-item 的数据：{ itemID: { status, date } }
            const itemData: Record<string, { status: string; date: string }> = {};

            // 状态字段：从 keyValues 中找到状态字段的所有 values
            const statusKV = keyValues.find((kv: any) => kv.key?.id === statusKeyID);
            if (statusKV) {
                for (const v of (statusKV.values || [])) {
                    const itemID = v.blockID;
                    const statusText = v.mSelect?.[0]?.content || "";
                    if (!itemData[itemID]) itemData[itemID] = { status: "", date: "" };
                    itemData[itemID].status = statusText;
                }
            }

            // 日期字段
            if (dateKeyID) {
                const dateKV = keyValues.find((kv: any) => kv.key?.id === dateKeyID);
                if (dateKV) {
                    for (const v of (dateKV.values || [])) {
                        const itemID = v.blockID;
                        const dateContent = v.date?.content;
                        const dateStr = dateContent ? String(dateContent) : "";
                        if (!itemData[itemID]) itemData[itemID] = { status: "", date: "" };
                        itemData[itemID].date = dateStr;
                    }
                }
            }

            // 按 itemIDs 顺序处理，保证一致性
            for (const itemID of itemIDs) {
                const data = itemData[itemID];
                if (!data) continue;
                const currStatus = data.status;
                const currDate = data.date;

                if (!this.firstPollComplete) {
                    this.knownExecRecords.set(itemID, { status: currStatus, execDate: currDate });
                    continue;
                }

                const prev = this.knownExecRecords.get(itemID);
                if (!prev) {
                    this.knownExecRecords.set(itemID, { status: currStatus, execDate: currDate });
                    continue;
                }

                // 检测状态变化 → 自动记录时间
                if (prev.status !== currStatus) {
                    if ((currStatus === STATUS_PASSED || currStatus === STATUS_NEEDS_FIX) &&
                        this.config.autoRecordTime && dateKeyID) {
                        try {
                            const now = Date.now();
                            await fetchPostAsync("/api/av/setAttributeViewBlockAttr", {
                                avID: this.config.execDBID,
                                keyID: dateKeyID,
                                itemID,
                                value: {
                                    date: { content: now, isNotEmpty: true },
                                },
                            });
                            console.log("CaseMate: auto-recorded time for", itemID);
                        } catch (e: any) {
                            console.warn("CaseMate update time error:", e.message || e);
                        }
                        this.knownExecRecords.set(itemID, { status: currStatus, execDate: String(Date.now()) });
                        continue;

                    } else if (currStatus === STATUS_UNTESTED && this.config.clearTimeOnReset && dateKeyID) {
                        try {
                            await fetchPostAsync("/api/av/setAttributeViewBlockAttr", {
                                avID: this.config.execDBID,
                                keyID: dateKeyID,
                                itemID,
                                value: {
                                    date: { content: null, isNotEmpty: false },
                                },
                            });
                        } catch (e: any) {
                            console.warn("CaseMate clear time error:", e.message || e);
                        }
                        this.knownExecRecords.set(itemID, { status: currStatus, execDate: "" });
                        continue;
                    }
                }

                this.knownExecRecords.set(itemID, { status: currStatus, execDate: currDate });
            }
        } catch (e: any) {
            console.warn("CaseMate pollExecutionDatabase error:", e.message || e);
        }
    }

    // ── 右键菜单：解析为用例（兜底方案） ────────────────────────────────────

    private onDocTreeMenu(event: any) {
        const detail = event.detail;
        if (!detail || !detail.menu) return;
        console.log("CaseMate open-menu-doctree detail keys:", Object.keys(detail));
        console.log("CaseMate open-menu-doctree detail.menu:", detail.menu);

        detail.menu.addItem({
            id: "caseMate_parseToCases",
            iconHTML: "",
            label: this.i18n.parseToCases,
            click: async () => {
                // 多种策略获取文档块 ID
                let blockID: string | undefined;

                // 策略1: detail.elements（open-menu-doctree 事件提供）
                if (!blockID && detail.elements?.length > 0) {
                    console.log("CaseMate: trying strategy 1 - detail.elements");
                    for (const el of detail.elements) {
                        blockID = el.dataset?.nodeId || el.dataset?.nodeid;
                        if (blockID) break;
                    }
                }

                // 策略2: detail.blockElements
                if (!blockID && detail.blockElements?.length > 0) {
                    console.log("CaseMate: trying strategy 2 - blockElements");
                    for (const el of detail.blockElements) {
                        blockID = el.dataset?.nodeId || el.dataset?.nodeid;
                        if (blockID) break;
                    }
                }

                // 策略3: detail.element
                if (!blockID && detail.element) {
                    console.log("CaseMate: trying strategy 3 - detail.element");
                    let el = detail.element;
                    while (el) {
                        blockID = el.dataset?.nodeId || el.dataset?.nodeid;
                        if (blockID) break;
                        el = el.parentElement;
                    }
                }

                // 策略4: detail.menu.element
                if (!blockID && detail.menu?.element) {
                    console.log("CaseMate: trying strategy 4 - menu.element");
                    let el = detail.menu.element;
                    while (el) {
                        blockID = el.dataset?.nodeId || el.dataset?.nodeid;
                        if (blockID) break;
                        el = el.parentElement;
                    }
                }

                // 策略5: 事件目标自身
                if (!blockID) {
                    console.log("CaseMate: trying strategy 5 - event target");
                    let el = event.target;
                    while (el && el !== document) {
                        blockID = el.dataset?.nodeId || el.dataset?.nodeid;
                        if (blockID) break;
                        el = el.parentElement;
                    }
                }

                console.log("CaseMate: resolved blockID =", blockID);

                if (!blockID) {
                    showMessage(this.i18n.noEditor);
                    return;
                }

                let totalCases = 0;

                // 单文档处理（右键菜单每次操作一个文档）
                // 去重检查：如果文档已在执行库中，跳过
                if (this.config.execDBID) {
                    try {
                        if (await this.docExistsInExecDB(blockID)) {
                            console.log("CaseMate: 文档已在执行库中，跳过", blockID);
                            showMessage(this.i18n.parseSkip.replace("{count}", "1"));
                            return;
                        }
                    } catch (_) { /* ignore */ }
                }

                // 读取文档
                let kramdownResp: any;
                try {
                    kramdownResp = await fetchPostAsync("/api/block/getBlockKramdown", { id: blockID });
                    console.log("CaseMate: getBlockKramdown resp:", JSON.stringify(kramdownResp));
                } catch (e: any) {
                    console.warn("CaseMate: 读取文档失败", e.message || e);
                    showMessage(`读取文档失败: ${e.message || e}`);
                    return;
                }
                const kramdown: string = kramdownResp?.kramdown || kramdownResp?.content || "";
                if (!kramdown) {
                    console.log("CaseMate: kramdown为空, resp=", kramdownResp);
                    return;
                }

                const excludeList = this.config.excludeKeywords
                    .split(",").map(s => s.trim()).filter(s => s.length > 0);

                const cases = extractTestCases(kramdown, excludeList);
                console.log("CaseMate: 解析出用例数 =", cases.length);
                if (cases.length === 0) {
                    showMessage(this.i18n.parseEmpty);
                    return;
                }

                // 创建执行记录
                if (this.config.execDBID) {
                    try {
                        const fieldMap = await this.getExecFieldMap();
                        console.log("CaseMate: exec field map =", JSON.stringify(fieldMap));
                        const projectKeyID = fieldMap[FIELD_PROJECT_NAME] || fieldMap["用例名称"];
                        const fields = await this.getAVFieldDefs(this.config.execDBID);
                        const pkField = findPrimaryKeyField(fields);

                        if (!pkField) {
                            showMessage("执行库缺少主键块字段");
                            return;
                        }

                        // 获取父文档名称作为项目名称
                        const projectName = await this.getParentDocName(blockID);
                        console.log("CaseMate: projectName =", projectName);

                        // 两段式创建：先创建含项目名称的行
                        const beforeIDs = await this.getAVItemIDs(this.config.execDBID);
                        console.log("CaseMate: 创建前 item 数 =", beforeIDs.length);

                        const blocksValues: any[][] = [];
                        for (let i = 0; i < cases.length; i++) {
                            const rowVals: any[] = [];
                            if (projectKeyID) {
                                rowVals.push({ keyID: projectKeyID, text: { content: projectName } });
                            }
                            blocksValues.push(rowVals);
                        }
                        console.log("CaseMate: 创建", blocksValues.length, "条记录");

                        await fetchPostAsync("/api/av/appendAttributeViewDetachedBlocksWithValues", {
                            avID: this.config.execDBID,
                            blocksValues,
                        });

                        // 等500ms后重新获取 itemID
                        await new Promise(r => setTimeout(r, 500));
                        const afterIDs = await this.getAVItemIDs(this.config.execDBID);
                        const newIDs = afterIDs.filter(id => !beforeIDs.includes(id));
                        console.log("CaseMate: 创建后 item 数 =", afterIDs.length, "新增 =", newIDs.length);

                        // 为每个新行设置块引用和状态
                        for (let i = 0; i < newIDs.length && i < cases.length; i++) {
                            const itemID = newIDs[i];
                            const c = cases[i];
                            // 设置块引用（主键）— 指向用例标题块
                            await fetchPostAsync("/api/av/setAttributeViewBlockAttr", {
                                avID: this.config.execDBID,
                                keyID: pkField.id,
                                itemID,
                                value: {
                                    type: "block",
                                    block: { id: c.blockID || blockID, content: c.name },
                                },
                            });
                            // 设置状态默认值
                            const statusKeyID = fieldMap[FIELD_STATUS];
                            if (statusKeyID) {
                                try {
                                    const result = await fetchPostAsync("/api/av/setAttributeViewBlockAttr", {
                                        avID: this.config.execDBID,
                                        keyID: statusKeyID,
                                        itemID,
                                        value: {
                                            mSelect: [{ content: STATUS_UNTESTED }],
                                        },
                                    });
                                    console.log("CaseMate: setStatus OK", JSON.stringify(result).substring(0, 100));
                                } catch (e: any) {
                                    console.warn("CaseMate: setStatus error", e.message || e);
                                }
                            }
                        }
                        console.log("CaseMate: 已更新", Math.min(newIDs.length, cases.length), "条记录的字段");
                        totalCases += Math.min(newIDs.length, cases.length);
                        this.execFieldCache = null;
                    } catch (e: any) {
                        console.warn("CaseMate batch create error:", e.message || e);
                        showMessage(`创建执行记录失败: ${e.message || e}`);
                        return;
                    }
                }

                const msg = this.i18n.parseComplete
                    .replace("{count}", String(totalCases))
                    .replace("{docCount}", "1");
                showMessage(msg);
                this.restartPolling();
            },
        });
    }
}
