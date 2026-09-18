// 跨增量保留控制序列状态，避免被拆开的 OSC/CSI 穿过终端展示边界。
export class TerminalText {
  private state: "text" | "escape" | "csi" | "string" | "string-escape" = "text";
  write(source: string): string {
    let result = "";
    for (const char of source) {
      const code = char.codePointAt(0) ?? 0;
      if (this.state === "string") {
        if (char === "\x07" || char === "\x9c") this.state = "text";
        else if (char === "\x1b") this.state = "string-escape";
        continue;
      }
      if (this.state === "string-escape") {
        this.state = char === "\\" ? "text" : "string";
        continue;
      }
      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        continue;
      }
      if (this.state === "escape") {
        this.state = char === "[" ? "csi" : "]PX^_".includes(char) ? "string" : "text";
        continue;
      }
      if (char === "\x1b") { this.state = "escape"; continue; }
      if (char === "\x9b") { this.state = "csi"; continue; }
      if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) { this.state = "string"; continue; }
      if ((code < 32 && char !== "\n" && char !== "\t") || (code >= 0x7f && code <= 0x9f) ||
          (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) continue;
      result += char;
    }
    return result;
  }
  reset(): void { this.state = "text"; }
}
export function terminalText(source: string): string { return new TerminalText().write(source); }
