/**
 * DSH 记录存储适配接口（源 ConversationManager 的 checkpoint 元数据面）。
 *
 * 源实现把 CheckpointRecord 列表存于对话 custom metadata（key='checkpoints'），
 * DSH 下改为 `<dataRoot>/checkpoints/records.json`（原子写：tmp + rename，
 * crypto.randomUUID 生成 checkpointId）。实现位于 ../service.ts（CheckpointService
 * 内私有存储），域层只依赖本接口，保持已拷贝代码（CheckpointDeletionService 等）
 * 的调用形态不变：updateCustomMetadata 返回写回后的新值（无变更时返回原引用）。
 */
export interface CheckpointRecordMetadataStore {
    /** 读取该工作区（conversationId）的存档记录列表；无记录返回空数组 */
    getCustomMetadata(conversationId: string, key: 'checkpoints'): Promise<unknown>;
    /**
     * 链内原子更新该工作区的存档列表：
     * updater 收到当前列表（可能为 undefined），返回新列表或原引用（无变更跳过写回）。
     * 返回写回后的新值（fail-closed：写回被拒/异常时返回 undefined）。
     */
    updateCustomMetadata(
        conversationId: string,
        key: 'checkpoints',
        updater: (current: unknown) => unknown | Promise<unknown>
    ): Promise<unknown>;
}
