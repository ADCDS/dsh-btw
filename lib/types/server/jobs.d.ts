import type { SideResult } from '../shared';
import { type BtwLocale } from '../locales';
export interface ChildResult {
    stopReason: string;
    output: readonly {
        type: string;
        text?: string;
    }[];
}
export interface ChildRun {
    result: Promise<ChildResult>;
    dispose(): Promise<void>;
}
export interface ChildRequest {
    scope: string;
    id: string;
    question: string;
    signal: AbortSignal;
    context?: unknown;
    locale: BtwLocale;
}
export type StartChild = (request: ChildRequest) => Promise<ChildRun>;
/** 已完成的旁问；转为后台子代理时由宿主提供，不信任客户端传回的问答内容。 */
export interface SettledAnswer {
    question: string;
    /** 不含引用原文的问题，用作子代理标签。 */
    title: string;
    answer: string;
    locale: BtwLocale;
}
interface JobOptions {
    cleanupTimeoutMs?: number;
    onError?: (error: Error) => void;
    /** 卸载后所有实际资源均释放时调用；用于释放执行保护。 */
    onIdle?: () => void | Promise<void>;
}
/** 清洗模型可能因上下文 toolcall 惯性残留的裸露工具调用标记与代码块伪影，保留纯文字回答 */
export declare function sanitizeModelAnswer(raw: string): string;
export declare const DEFAULT_TIMEOUT_MS = 1800000;
/** 管理一次性任务；父会话和请求标识共同构成所有权边界。 */
export declare class SideJobs {
    private readonly start;
    private readonly timeoutMs;
    private readonly options;
    private readonly jobs;
    private readonly retired;
    private readonly settled;
    private disposed;
    private idleNotified;
    constructor(start: StartChild, timeoutMs?: number, options?: JobOptions);
    get size(): number;
    ask(scope: string, id: string, question: string, signal?: AbortSignal, context?: unknown, locale?: BtwLocale, title?: string): Promise<SideResult>;
    /** 取走已完成的旁问，防止重复转入；启动失败时用 rememberAnswer 放回以便重试。 */
    takeAnswer(scope: string, id: string): SettledAnswer | undefined;
    /** 按完成顺序保留有限数量的答案，气泡刷新后不再关闭时也不会无限增长。 */
    rememberAnswer(scope: string, id: string, answer: SettledAnswer): void;
    /** 关闭可先于启动到达；短期墓碑阻止网络乱序重新启动请求。 */
    close(scope: string, id: string): Promise<SideResult>;
    dispose(): Promise<void>;
    private execute;
    private cleanup;
    private cleanupLater;
    private interruptible;
    private bounded;
    private release;
    private report;
    private notifyIdle;
    private retire;
    private prune;
}
export {};
