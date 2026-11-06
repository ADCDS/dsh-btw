import { type SideResult } from '../shared';
import { type BtwTranslate } from '../locales';
export interface Bubble {
    id: string;
    sessionId: string;
    question: string;
    reference?: string;
    answer: string;
    phase: 'answering' | 'done' | 'error' | 'closing';
    error?: string;
    closeFailed?: boolean;
    /** 正在把这条旁问转入后台子代理。 */
    forking?: boolean;
    /** 已转入的子代理名称；之后关闭气泡不影响子代理。 */
    forkedTo?: string;
}
export interface SideTransport {
    run(session: string, id: string, question: string, signal: AbortSignal, reference?: string): Promise<SideResult>;
    close(session: string, id: string): Promise<SideResult>;
    fork?(session: string, id: string): Promise<SideResult>;
}
/** 宿主在进入 handler 前明确拒绝启动；没有后台任务需要清理。 */
export declare class SideRequestNotStartedError extends Error {
}
/** 仅内存 UI 状态；关闭请求与答案返回按请求身份分别收敛。 */
export declare class BubbleStore {
    private readonly transport;
    private readonly t;
    private snapshot;
    private readonly listeners;
    private readonly active;
    private readonly closing;
    private readonly notStarted;
    private readonly runEnd;
    private readonly closeFenced;
    private readonly admitting;
    private disposed;
    constructor(transport: SideTransport, t?: BtwTranslate);
    getSnapshot: () => readonly Bubble[];
    subscribe: (listener: () => void) => (() => void);
    /** 返回已接收请求的标识；满额先等待旧气泡关闭，失败时拒绝且不发送新问题。 */
    ask(sessionId: string, question: string, reference?: string): Promise<string>;
    /** 用户点击后才转入；失败时保留答案和按钮以便重试，宿主保证同一旁问只启动一次。 */
    fork(id: string): Promise<void>;
    close(id: string): Promise<void>;
    dispose(): Promise<void>;
    private dropIfCloseCannotFinish;
    private remove;
    private update;
    private publish;
}
