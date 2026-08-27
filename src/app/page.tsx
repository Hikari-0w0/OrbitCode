const milestones = [
  "模型对话与上下文管理",
  "本地文件读写与命令执行",
  "原生 Tool Calling 循环",
  "终止条件与错误恢复",
];

export default function Home() {
  return (
    <main className="shell">
      <section className="terminal" aria-labelledby="project-title">
        <header className="terminalBar">
          <span className="dot dotRed" />
          <span className="dot dotYellow" />
          <span className="dot dotGreen" />
          <span className="terminalTitle">orbitcode — zsh</span>
        </header>

        <div className="terminalBody">
          <p className="command">
            <span className="prompt">➜</span> orbitcode status
          </p>
          <p className="eyebrow">CODING AGENT · TYPESCRIPT · NEXT.JS</p>
          <h1 id="project-title">OrbitCode</h1>
          <p className="intro">
            一个从零实现的编程智能体。项目基线已经启动，接下来将逐步实现模型交互、
            本地工具执行与自主任务循环。
          </p>

          <div className="statusLine">
            <span className="statusPulse" />
            <span>Phase 0</span>
            <strong>项目初始化完成</strong>
          </div>

          <ol className="milestones" aria-label="后续开发模块">
            {milestones.map((milestone, index) => (
              <li key={milestone}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                {milestone}
              </li>
            ))}
          </ol>

          <p className="cursorLine">
            <span className="prompt">➜</span> <span className="cursor" aria-hidden="true" />
          </p>
        </div>
      </section>
    </main>
  );
}
