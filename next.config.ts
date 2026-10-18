import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 项目指令统一维护在 AGENTS.md，避免开发服务器生成重复的 CLAUDE.md。
  agentRules: false,
  devIndicators: false,
  outputFileTracingIncludes: { "/*": ["./skills/**/*.md"] },
  // 本地配置和工作区数据由运行环境提供，不随生产文件跟踪夹带到发布包。
  outputFileTracingExcludes: { "/*": [
    "./.env*", "./orbitcode*.yaml", "./.orbitcode/**", "./.agents/**", "./.git/**",
    "./tmp/**", "./src/**", "./tests/**", "./scripts/**", "./docs/**", "./.next/dev/**",
    "./**/settings-v1.json", "./**/.npmrc", "./**/.netrc", "./**/.git-credentials",
    "./**/*.{pem,key,p12,pfx}",
  ] },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
