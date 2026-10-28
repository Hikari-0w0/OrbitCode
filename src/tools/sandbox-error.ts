export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export class SandboxPreparationError extends Error {
  constructor(message: string) { super(message); this.name = "SandboxPreparationError"; }
}
