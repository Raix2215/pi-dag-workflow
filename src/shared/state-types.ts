/** Legacy branch records remain readable without loading the Todo schema/controller. */
export const LEGACY_WORKFLOW_TYPE = 'pi-dag-workflow.state';
export const taskStatusLabels = { pending: '待执行', in_progress: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消', deleted: '已删除' } as const;
