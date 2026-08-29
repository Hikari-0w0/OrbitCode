import { PermissionSessionManager } from "@/web/permission-session-manager";

// Route Handler 必须共享同一进程内实例，浏览器状态不能成为权限事实来源。
export const permissionSessionManager = new PermissionSessionManager();
