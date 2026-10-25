import { webAgentRuntime } from "@/web/agent-runtime";
import { knowledgeHandlers } from "@/web/knowledge-http";
export const dynamic="force-dynamic";
export const runtime="nodejs";
export const {GET,POST}=knowledgeHandlers(id=>webAgentRuntime.knowledge(id));
