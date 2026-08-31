export default Object.freeze({
  apiVersion: 1,
  policy() {
    return {
      events: ["annotation-created", "annotation-reopened"],
      debounceMs: 300,
      settings: {
        runner: {
          label: "CLI",
          options: [
            { value: "opencode", label: "OpenCode" },
            { value: "claude", label: "Claude" },
            { value: "codex", label: "Codex" },
            { value: "copilot", label: "GitHub Copilot" },
            { value: "pi", label: "Pi" },
          ],
        },
        maxParallel: { label: "最大並列数", min: 1, max: 10, defaultValue: 2 },
        autoRun: { label: "注釈を保存したら自動でAI修正を開始" },
      },
    };
  },
});
