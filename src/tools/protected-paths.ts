import path from "node:path";

const PROTECTED_NAMES = new Set([
  "orbitcode.yaml",
  "orbitcode.workspaces.yaml",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  "auth.json",
]);
const PROTECTED_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);

export function isProtectedPath(relativePath: string): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  return segments.some((segment) => isProtectedName(segment));
}

export function isProtectedName(name: string): boolean {
  if (name === ".env.example") return false;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (PROTECTED_NAMES.has(name)) return true;
  return PROTECTED_EXTENSIONS.has(path.extname(name).toLowerCase());
}
