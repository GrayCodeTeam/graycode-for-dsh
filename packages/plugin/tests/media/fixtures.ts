/**
 * media 测试共享 fixture：1x1 PNG（已验证 sharp 可解码：1x1 png）。
 * 独立文件避免测试文件互相引用（每个 spec 的顶层副作用只属于自己）。
 */
/** 1x1 PNG base64（8-bit 非隔行，libpng 标准最小图） */
export const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** 解码为字节（Uint8Array） */
export function png1x1Bytes(): Uint8Array {
  return Buffer.from(PNG_1X1_BASE64, 'base64')
}
