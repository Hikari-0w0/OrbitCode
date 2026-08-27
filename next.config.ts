import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 项目指令统一维护在 AGENTS.md，避免开发服务器生成重复的 CLAUDE.md。
  agentRules: false,
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
