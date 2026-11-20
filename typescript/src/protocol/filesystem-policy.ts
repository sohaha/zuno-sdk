/** 只读目录策略。省略继承，空目录列表拒绝全部。 */
export interface FilesystemPolicy {
  readRoots: string[];
}

/** 校验公开策略，禁止丢弃 writeRoots 等未知字段。 */
export function filesystemPolicyWire(policy: FilesystemPolicy): { read_roots: string[] } {
  if (!policy || typeof policy !== "object" || Object.keys(policy).some(key => key !== "readRoots") ||
      !Array.isArray(policy.readRoots) || policy.readRoots.some(root => typeof root !== "string")) {
    throw new Error("filesystem 只允许 readRoots 字符串数组，不支持写目录或未知字段");
  }
  return { read_roots: [...policy.readRoots] };
}
