/**
 * CaseMate — MVP 阶段不需要内核插件功能。
 * 保留最小占位文件以满足 webpack.kernel.config.js 的编译要求。
 */
class KernelPlugin {
    constructor() {
        console.log("CaseMate kernel plugin loaded (no-op in MVP)");
    }
}
new KernelPlugin();
