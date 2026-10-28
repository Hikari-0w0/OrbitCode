import { constants } from "node:fs";
import { open } from "node:fs/promises";

export async function readPublicNpmrc(filePath: string, identity: { readonly dev: number; readonly ino: number }): Promise<string | undefined> {
  try {
    const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 65536 || info.dev !== identity.dev || info.ino !== identity.ino) return undefined;
      const buffer = Buffer.alloc(65537); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) return undefined;
      const content = buffer.subarray(0, bytesRead).toString("utf8");
      if (!isPublicNpmrc(content)) return undefined;
      return content;
    } finally { await file.close(); }
  } catch { return undefined; }
}

export function isPublicNpmrc(content: string): boolean {
  if (/[\0\uFFFD]|\$\{|https?:\/\/[^/\s]*@|[?&](?:token|key|api_key|auth|password|secret)=|\bBearer\s+|\b(?:sk-|npm_|gh[pousr]_)[A-Za-z0-9]/i.test(content)) return false;
  return content.split(/\r?\n/).every(raw => {
    const line=raw.trim();if(!line)return true;
    if (/^[;#]/.test(line)) return !/(?:_auth|token|password|passwd|credential|secret|private.?key|api.?key|\bauth\s*[:=])/i.test(line);
    const match=/^([^=\s]+)\s*=\s*(.*)$/.exec(line);if(!match)return false;
    // 按字段判断认证信息，不能因 registry 域名含 auth 就误拒绝公开配置。
    const key=match[1].split(":").at(-1)??match[1];
    if(key==="always-auth"&&/^(true|false)$/i.test(match[2]))return true;
    if(key==="auth-type"&&/^(web|legacy)$/i.test(match[2]))return true;
    return !/(?:auth|token|password|passwd|username|credential|secret|(?:private|api)[_-]?key|^(?:cert|key)(?:file)?$)/i.test(key);
  });
}
