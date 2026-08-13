/**
 * 测试公共 fixture（os.tmpdir 建临时 workspace + 临时 dataRoot，测完由测试清理）。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CheckpointService, type CheckpointServiceConfig } from '../../src/checkpoints/service.ts'

/** 在临时目录中创建文件，自动补齐父目录 */
export async function writeFile(rootDir: string, relativePath: string, content = ''): Promise<void> {
  const fullPath = path.join(rootDir, relativePath)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(fullPath, content, 'utf-8')
}

/** 创建临时目录（os.tmpdir 下，prefix 前缀） */
export async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** 构造服务（默认：无上限保留、类别全默认启用、无自定义模式、默认大小上限、7 天 GC grace） */
export function makeService(dataRoot: string, overrides: Partial<CheckpointServiceConfig> = {}): CheckpointService {
  return new CheckpointService({
    dataRoot,
    maxCheckpoints: -1,
    excludeProfiles: {},
    excludePatterns: [],
    maxFileSizeBytes: 50 * 1024 * 1024,
    blobGracePeriodDays: 7,
    ...overrides,
  })
}

/** 临时 workspace + 临时 dataRoot + 已 initialize 的服务 */
export async function makeEnv(overrides: Partial<CheckpointServiceConfig> = {}): Promise<{
  workspaceDir: string
  dataRoot: string
  service: CheckpointService
}> {
  const workspaceDir = await createTempDir('dsh-checkpoint-ws-')
  const dataRoot = await createTempDir('dsh-checkpoint-data-')
  const service = makeService(dataRoot, overrides)
  await service.initialize()
  return { workspaceDir, dataRoot, service }
}

/** 递归清理 */
export async function cleanup(...dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {
      // 忽略清理失败
    }
  }
}
