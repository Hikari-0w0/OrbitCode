import {acquireLocalFileLock, LocalFileLockError} from "@/lib/local-file-lock";
import {SettingsError} from "@/runtime/settings-types";
export async function acquireSettingsLock(directory:string):Promise<()=>Promise<void>> {
 try{return await acquireLocalFileLock(directory,"settings-v1",4000);}
 catch(error){throw new SettingsError(error instanceof LocalFileLockError ? error.kind : "storage",error instanceof LocalFileLockError ? error.message.replaceAll("本地资料","本地设置") : "无法锁定本地设置。",error);}
}
