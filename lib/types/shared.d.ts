export { MAX_QUESTION_LENGTH, MAX_REFERENCE_LENGTH, MAX_TOTAL_QUOTES_LENGTH } from './limits';
import { type BtwLocale } from './locales';
export declare const RUN_COMMAND = "btw-run";
export declare const CLOSE_COMMAND = "btw-close";
export declare const FORK_COMMAND = "btw-fork";
export interface SideRequest {
    id: string;
    question: string;
    locale: BtwLocale;
    reference?: string;
}
export interface SideResult {
    kind: 'success' | 'error';
    text: string;
}
/** 内部命令使用结构化请求，身份始终由宿主会话提供。 */
export declare function parseRequest(raw: string): SideRequest;
/** 引用是待解释的数据，不能作为替代问题或执行指令。 */
export declare function questionWithReference(question: string, reference?: string, locale?: BtwLocale): string;
/** 围栏长于原文任何连续反引号，保留代码原有换行并避免原文提前闭合围栏。 */
export declare function fenced(text: string): string;
/** 子代理目录中显示的标签：折叠空白后截断，并标明来自旁问。 */
export declare function forkLabel(question: string): string;
