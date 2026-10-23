import type { Translator } from './i18n.ts';
/** Current Todo record type; also the Plan migration source, readable without loading Todos. */
export const WORKFLOW_STATE_TYPE = 'pi-dag-workflow.state';

export const translatedTaskStatusLabels = (msg: Translator) => ({ pending: msg('待执行'), in_progress: msg('进行中'), completed: msg('已完成'), failed: msg('失败'), cancelled: msg('已取消'), deleted: msg('已删除') });
