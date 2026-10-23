export class ConversationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationStateError";
  }
}

export class AgentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigurationError";
  }
}
