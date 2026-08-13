/**
 * 检查点模块共享文件哈希（CPF-06 / CP-DUP-1）。
 *
 * 流式计算文件 SHA-256（createReadStream），不整文件读入内存。
 *
 * 内容寻址布局（V2 §7.6）下哈希兼任两职：
 * - 内容寻址键（blobs/<hash> 文件名，同 hash 复用）；
 * - 快照/恢复的逐文件校验哈希（snapshot 构建、恢复引擎、verify 共用同一实现）。
 * 因此从源实现的 MD5 升级为 SHA-256（MD5 作为内容寻址键碰撞风险不可接受），
 * 所有生产/消费方均经本模块，算法更换对调用方无感知。
 */
import * as crypto from 'crypto';
import { createReadStream } from 'fs';

/** 流式计算文件 SHA-256（不整文件读入内存） */
export async function hashFileStreaming(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve());
    });
    return hash.digest('hex');
}
