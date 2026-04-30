import {
  App,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  addIcon,
  setIcon
} from "obsidian";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import codianIconSvg from "../icon.svg";

const VIEW_TYPE_CODIAN = "codian-view";
const CODIAN_ICON_ID = "codian-codex";
const CODIAN_ICON_SOURCE_SIZE = 1254;
const CODIAN_BUNDLED_ICON_SVG = normalizeImportedIconSvg(codianIconSvg);
const PLAN_MODE_INSTRUCTIONS = `PLAN MODE
You are in planning mode. Do not modify files, do not run destructive commands, and do not apply changes.
Return a concise implementation plan with:
1. Goal
2. Relevant files or notes
3. Proposed steps
4. Risks or questions
5. What you would do next if the user approves`;

type MessageRole = "user" | "assistant" | "system" | "tool" | "error";
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalPolicy = "untrusted" | "on-request" | "never";
type ConversationMode = "agent" | "plan";
type ReasoningEffort = "default" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface CodianMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
}

interface CodianConversation {
  id: string;
  title: string;
  threadId: string | null;
  messages: CodianMessage[];
  contextPaths: string[];
  excludedAutoNotePaths: string[];
  mode: ConversationMode;
  createdAt: number;
  updatedAt: number;
}

interface CodianSettings {
  codexCliPath: string;
  model: string;
  modelReasoningEffort: ReasoningEffort;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  environmentVariables: string;
  extraArgs: string;
  showReasoning: boolean;
  showToolEvents: boolean;
  autoScroll: boolean;
  includeCurrentNoteContext: boolean;
  includeSelectedTextContext: boolean;
  maxConversations: number;
  eventDisplayPreferenceVersion: number;
}

interface CodianData {
  settings: CodianSettings;
  activeConversationId: string;
  conversations: CodianConversation[];
  threadId?: string | null;
  messages?: CodianMessage[];
}

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  error?: unknown;
  message?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    status?: string;
    output?: string;
    summary?: string;
    [key: string]: unknown;
  };
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

interface SlashCommandResult {
  prompt: string;
  mode?: ConversationMode;
  localOnly?: boolean;
}

interface CodianRunState {
  conversationId: string;
  assistantMessageId: string;
  child: ChildProcessWithoutNullStreams | null;
  pendingLine: string;
  stderrBuffer: string[];
  stopped: boolean;
  receivedAssistantDelta: boolean;
}

type MentionSuggestion =
  | {
      kind: "folder";
      path: string;
      title: string;
      detail: string;
    }
  | {
      kind: "file";
      file: TFile;
      path: string;
      title: string;
      detail: string;
    };

const DEFAULT_SETTINGS: CodianSettings = {
  codexCliPath: "",
  model: "",
  modelReasoningEffort: "default",
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  environmentVariables: "",
  extraArgs: "",
  showReasoning: true,
  showToolEvents: false,
  autoScroll: true,
  includeCurrentNoteContext: true,
  includeSelectedTextContext: true,
  maxConversations: 8,
  eventDisplayPreferenceVersion: 1
};

const MODEL_OPTIONS = [
  { label: "Config model", value: "" },
  { label: "GPT-5.5", value: "gpt-5.5" },
  { label: "GPT-5.4", value: "gpt-5.4" },
  { label: "GPT-5.4 Mini", value: "gpt-5.4-mini" },
  { label: "GPT-5.3 Codex", value: "gpt-5.3-codex" },
  { label: "GPT-5.2", value: "gpt-5.2" }
];

const EFFORT_OPTIONS: Array<{ label: string; value: ReasoningEffort }> = [
  { label: "Effort: default", value: "default" },
  { label: "Effort: minimal", value: "minimal" },
  { label: "Effort: low", value: "low" },
  { label: "Effort: medium", value: "medium" },
  { label: "Effort: high", value: "high" },
  { label: "Effort: xhigh", value: "xhigh" }
];

const DEFAULT_DATA: CodianData = {
  settings: DEFAULT_SETTINGS,
  activeConversationId: "",
  conversations: []
};

export default class CodianPlugin extends Plugin {
  data: CodianData = { ...DEFAULT_DATA, settings: { ...DEFAULT_SETTINGS } };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savingData: Promise<void> | null = null;
  private needsSaveAfterCurrentSave = false;

  async onload(): Promise<void> {
    await this.loadCodianData();
    addIcon(CODIAN_ICON_ID, this.loadCodianIconSvg());

    this.registerView(VIEW_TYPE_CODIAN, (leaf) => new CodianView(leaf, this));

    const ribbonIconEl = this.addRibbonIcon(CODIAN_ICON_ID, "Open codian", () => {
      void this.activateView();
    });
    ribbonIconEl.addClass("codian-ribbon-icon");

    this.addCommand({
      id: "open",
      name: "Open codian",
      callback: () => void this.activateView()
    });

    this.addCommand({
      id: "new-codex-thread",
      name: "Start new conversation",
      callback: async () => {
        this.createConversation();
        await this.saveCodianData();
        this.getView()?.render();
        new Notice("Started a new conversation");
      }
    });

    this.addCommand({
      id: "open-chat-history",
      name: "Open chat history",
      callback: () => {
        const view = this.getView();
        new ConversationHistoryModal(this.app, this, () => view?.render()).open();
      }
    });

    this.addCommand({
      id: "attach-context-file",
      name: "Attach context file",
      callback: () => {
        const view = this.getView();
        new ContextFileSuggestModal(this.app, this, () => view?.render()).open();
      }
    });

    this.addCommand({
      id: "inline-edit-selection",
      name: "Inline edit selection",
      editorCallback: async (editor, view) => {
        const selectedText = editor.getSelection();
        if (!selectedText.trim()) {
          new Notice("Select text before running the inline edit.");
          return;
        }

        const instruction = await new InlineEditPromptModal(this.app).openAndWait();
        if (!instruction) return;

        const vaultPath = this.getVaultPath();
        if (!vaultPath) {
          new Notice("Could not determine vault path.");
          return;
        }

        new Notice("Editing the selection...");
        try {
          const replacement = await this.runCodexOnce(buildInlineEditPrompt(instruction, selectedText, view.file?.path ?? "unknown"));
          const cleaned = cleanInlineEditResponse(replacement);
          if (!cleaned.trim()) {
            new Notice("Codex returned an empty edit.");
            return;
          }
          editor.replaceSelection(cleaned);
          new Notice("Edit applied.");
        } catch (error) {
          new Notice(`Inline edit failed: ${formatError(error)}`);
        }
      }
    });

    this.addSettingTab(new CodianSettingTab(this.app, this));
  }

  onunload(): void {
    void this.flushCodianData();
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CODIAN)[0];

    if (!leaf) {
      const nextLeaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
      await nextLeaf.setViewState({ type: VIEW_TYPE_CODIAN, active: true });
      leaf = nextLeaf;
    }

    await workspace.revealLeaf(leaf);
  }

  getView(): CodianView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODIAN)[0];
    if (!leaf) return null;
    return leaf.view instanceof CodianView ? leaf.view : null;
  }

  loadCodianIconSvg(): string {
    const vaultPath = this.getVaultPath();
    const pluginDir = this.manifest.dir && vaultPath ? path.join(vaultPath, this.manifest.dir) : null;
    if (!pluginDir) return CODIAN_BUNDLED_ICON_SVG;

    try {
      const iconSvg = fs.readFileSync(path.join(pluginDir, "icon.svg"), "utf8");
      return normalizeImportedIconSvg(iconSvg);
    } catch {
      return CODIAN_BUNDLED_ICON_SVG;
    }
  }

  async loadCodianData(): Promise<void> {
    const saved = (await this.loadData()) as Partial<CodianData> | null;
    const conversations = migrateConversations(saved);
    const activeConversationId = resolveActiveConversationId(saved?.activeConversationId, conversations);
    const savedSettings: Partial<CodianSettings> = saved?.settings ?? {};
    const migratedSettings = {
      ...DEFAULT_SETTINGS,
      ...savedSettings
    };
    if (!savedSettings.eventDisplayPreferenceVersion) {
      migratedSettings.showToolEvents = false;
      migratedSettings.eventDisplayPreferenceVersion = 1;
    }
    this.data = {
      settings: migratedSettings,
      activeConversationId,
      conversations
    };
  }

  async saveCodianData(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.savingData) {
      this.needsSaveAfterCurrentSave = true;
      await this.savingData;
      if (this.needsSaveAfterCurrentSave) {
        return this.saveCodianData();
      }
      return;
    }

    this.needsSaveAfterCurrentSave = false;
    this.savingData = this.saveData(this.data).finally(() => {
      this.savingData = null;
    });
    await this.savingData;

    if (this.needsSaveAfterCurrentSave) {
      await this.saveCodianData();
    }
  }

  requestSaveCodianData(delay = 300): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveCodianData();
    }, delay);
  }

  async flushCodianData(): Promise<void> {
    await this.saveCodianData();
  }

  getVaultPath(): string | null {
    const adapter = this.app.vault.adapter as { basePath?: string };
    return adapter.basePath ?? null;
  }

  getActiveConversation(): CodianConversation {
    let conversation = this.data.conversations.find((item) => item.id === this.data.activeConversationId);
    if (!conversation) {
      conversation = this.createConversation();
    }
    return conversation;
  }

  createConversation(title = "New chat"): CodianConversation {
    const now = Date.now();
    const conversation: CodianConversation = {
      id: createConversationId(),
      title,
      threadId: null,
      messages: [],
      contextPaths: [],
      excludedAutoNotePaths: [],
      mode: "agent",
      createdAt: now,
      updatedAt: now
    };
    this.data.conversations.unshift(conversation);
    this.data.activeConversationId = conversation.id;
    this.pruneConversations();
    return conversation;
  }

  activateConversation(id: string): boolean {
    if (!this.data.conversations.some((conversation) => conversation.id === id)) return false;
    this.data.activeConversationId = id;
    return true;
  }

  closeConversation(id: string): void {
    const index = this.data.conversations.findIndex((conversation) => conversation.id === id);
    if (index < 0) return;
    this.data.conversations.splice(index, 1);
    if (this.data.conversations.length === 0) {
      this.createConversation();
      return;
    }
    if (this.data.activeConversationId === id) {
      const next = this.data.conversations[Math.max(0, index - 1)] ?? this.data.conversations[0];
      this.data.activeConversationId = next.id;
    }
  }

  updateConversationTitle(conversation: CodianConversation, prompt: string): void {
    if (conversation.title !== "New chat" || !prompt.trim()) return;
    conversation.title = summarizeTitle(prompt);
  }

  touchConversation(conversation: CodianConversation): void {
    conversation.updatedAt = Date.now();
    this.data.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    this.pruneConversations();
  }

  addContextPath(conversation: CodianConversation, filePath: string): void {
    if (!conversation.contextPaths.includes(filePath)) {
      conversation.contextPaths.push(filePath);
      this.touchConversation(conversation);
    }
  }

  removeContextPath(conversation: CodianConversation, filePath: string): void {
    conversation.contextPaths = conversation.contextPaths.filter((candidate) => candidate !== filePath);
    this.touchConversation(conversation);
  }

  excludeAutoNotePath(conversation: CodianConversation, filePath: string): void {
    if (!conversation.excludedAutoNotePaths.includes(filePath)) {
      conversation.excludedAutoNotePaths.push(filePath);
      this.touchConversation(conversation);
    }
  }

  setConversationMode(conversation: CodianConversation, mode: ConversationMode): void {
    conversation.mode = mode;
    this.touchConversation(conversation);
  }

  private pruneConversations(): void {
    const max = Math.max(3, Math.min(20, this.data.settings.maxConversations || DEFAULT_SETTINGS.maxConversations));
    if (this.data.conversations.length <= max) return;
    const active = this.getActiveConversation();
    const removable = this.data.conversations.filter((conversation) => conversation.id !== active.id);
    const kept = [active, ...removable.slice(0, max - 1)];
    this.data.conversations = kept;
  }

  resolveCodexCliPath(): string | null {
    const configured = expandHome(this.data.settings.codexCliPath.trim());
    if (configured && isExecutableFile(configured)) {
      return configured;
    }
    return findCodexCli();
  }

  buildEnvironment(codexPath: string): NodeJS.ProcessEnv {
    const customEnv = parseEnvironmentVariables(this.data.settings.environmentVariables);
    const codexDir = path.dirname(codexPath);
    const existingPath = customEnv.PATH || customEnv.Path || process.env.PATH || process.env.Path || "";
    const pathParts = [
      codexDir,
      path.join(os.homedir(), ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      existingPath
    ].filter(Boolean);

    return {
      ...process.env,
      ...customEnv,
      PATH: dedupePath(pathParts.join(path.delimiter))
    };
  }

  runCodexOnce(prompt: string): Promise<string> {
    const vaultPath = this.getVaultPath();
    if (!vaultPath) {
      return Promise.reject(new Error("Vault path not available"));
    }

    const codexPath = this.resolveCodexCliPath();
    if (!codexPath) {
      return Promise.reject(new Error("Codex CLI not found"));
    }

    const settings = this.data.settings;
    const model = settings.model.trim();
    const effortArgs = buildReasoningEffortArgs(settings.modelReasoningEffort, "agent");
    const args = [
      "exec",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "-C",
      vaultPath,
      "-s",
      settings.sandboxMode,
      "-c",
      `approval_policy="${settings.approvalPolicy}"`,
      ...effortArgs,
      ...(model ? ["-m", model] : []),
      "-"
    ];

    return new Promise((resolve, reject) => {
      const codexSpawn = buildCodexSpawn(codexPath, args);
      const child = spawn(codexSpawn.command, codexSpawn.args, {
        cwd: vaultPath,
        env: this.buildEnvironment(codexPath),
        stdio: "pipe"
      });
      let stdoutBuffer = "";
      let stderr = "";
      let finalText = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseCodexJsonLine(line);
          if (event?.item?.type === "agent_message" && typeof event.item.text === "string") {
            finalText += event.item.text;
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (stdoutBuffer.trim()) {
          const event = parseCodexJsonLine(stdoutBuffer);
          if (event?.item?.type === "agent_message" && typeof event.item.text === "string") {
            finalText += event.item.text;
          }
        }
        if (code === 0) {
          resolve(finalText);
          return;
        }
        reject(new Error(stderr.trim() || `Codex exited with code ${code ?? "unknown"}`));
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

class CodianView extends ItemView {
  private plugin: CodianPlugin;
  private messageListEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private runButtonEl: HTMLButtonElement | null = null;
  private stopButtonEl: HTMLButtonElement | null = null;
  private runs = new Map<string, CodianRunState>();
  private mentionSuggestEl: HTMLElement | null = null;
  private mentionSuggestions: MentionSuggestion[] = [];
  private selectedMentionIndex = 0;

  constructor(leaf: WorkspaceLeaf, plugin: CodianPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CODIAN;
  }

  getDisplayText(): string {
    return "Codian";
  }

  getIcon(): string {
    return CODIAN_ICON_ID;
  }

  async onOpen(): Promise<void> {
    if (isMacPlatform()) {
      this.scope?.register([], "Enter", (event) => this.handleScopedSubmitHotkey(event));
    }
    this.scope?.register(["Mod"], "Enter", (event) => this.handleScopedSubmitHotkey(event));
    this.scope?.register(["Ctrl"], "Enter", (event) => this.handleScopedSubmitHotkey(event));
    this.render();
    await Promise.resolve();
  }

  async onClose(): Promise<void> {
    this.stopAllRuns();
    this.hideMentionSuggestions();
    await this.plugin.flushCodianData();
  }

  render(): void {
    this.containerEl.empty();
    this.containerEl.addClass("codian-view");
    const activeConversation = this.plugin.getActiveConversation();

    const toolbar = this.containerEl.createDiv({ cls: "codian-toolbar" });
    const brand = toolbar.createDiv({ cls: "codian-brand" });
    const brandIcon = brand.createSpan({ cls: "codian-brand-icon" });
    setIcon(brandIcon, CODIAN_ICON_ID);
    const brandText = brand.createDiv({ cls: "codian-brand-text" });
    brandText.createDiv({ cls: "codian-brand-name", text: "Codian" });
    brandText.createDiv({ cls: "codian-brand-subtitle", text: "Assistant in your vault" });

    const pills = toolbar.createDiv({ cls: "codian-toolbar-pills" });
    this.createPill(pills, "Command", this.plugin.resolveCodexCliPath() ? "ready" : "missing", this.plugin.resolveCodexCliPath() ? "is-ok" : "is-error");
    this.createPill(pills, "Mode", this.plugin.data.settings.sandboxMode, "is-muted");
    this.createPill(pills, "Thread", activeConversation.threadId ? shortId(activeConversation.threadId) : "new", "is-muted");

    const actions = toolbar.createDiv({ cls: "codian-toolbar-actions" });
    const historyButton = this.createIconButton(actions, "history", "Chat history");
    historyButton.onclick = () => {
      new ConversationHistoryModal(this.app, this.plugin, () => this.render()).open();
    };

    const attachButton = this.createIconButton(actions, "paperclip", "Attach context file");
    attachButton.onclick = () => {
      new ContextFileSuggestModal(this.app, this.plugin, () => this.render()).open();
    };

    const planButton = this.createIconButton(actions, "list-checks", activeConversation.mode === "plan" ? "Switch to agent mode" : "Switch to plan mode");
    planButton.toggleClass("is-active", activeConversation.mode === "plan");
    planButton.onclick = async () => {
      this.plugin.setConversationMode(activeConversation, activeConversation.mode === "plan" ? "agent" : "plan");
      await this.plugin.saveCodianData();
      this.render();
    };

    const newButton = this.createIconButton(actions, "plus", "New thread");
    newButton.onclick = async () => {
      this.plugin.createConversation();
      await this.plugin.saveCodianData();
      this.render();
    };

    this.renderConversationTabs();

    this.statusEl = this.containerEl.createDiv({ cls: "codian-status" });
    this.setStatus(this.buildReadyStatus());

    this.messageListEl = this.containerEl.createDiv({ cls: "codian-messages" });
    this.renderMessages();

    const composer = this.containerEl.createDiv({ cls: "codian-composer" });
    this.mentionSuggestEl = composer.createDiv({ cls: "codian-mention-suggest is-hidden" });
    const composerShell = composer.createDiv({ cls: "codian-composer-shell" });
    const composerTop = composerShell.createDiv({ cls: "codian-composer-top" });
    const activeFile = this.app.workspace.getActiveFile();
    const noteLabel = this.getCurrentNoteLabel(activeConversation);
    if (noteLabel && activeFile) {
      const noteChip = composerTop.createSpan({ cls: "codian-context-chip codian-context-chip-removable" });
      noteChip.createSpan({ cls: "codian-context-chip-text", text: noteLabel });
      const remove = noteChip.createSpan({ cls: "codian-chip-remove", attr: { title: "Remove current note from this chat context" } });
      setIcon(remove, "x");
      remove.onclick = async () => {
        this.plugin.excludeAutoNotePath(activeConversation, activeFile.path);
        await this.plugin.saveCodianData();
        this.render();
      };
    }
    for (const contextPath of activeConversation.contextPaths) {
      const chip = composerTop.createSpan({ cls: "codian-context-chip codian-context-chip-removable" });
      chip.createSpan({ cls: "codian-context-chip-text", text: contextPath });
      const remove = chip.createSpan({ cls: "codian-chip-remove", attr: { title: "Remove context file" } });
      setIcon(remove, "x");
      remove.onclick = async () => {
        this.plugin.removeContextPath(activeConversation, contextPath);
        await this.plugin.saveCodianData();
        this.render();
      };
    }
    if (activeConversation.mode === "plan") {
      composerTop.createSpan({ cls: "codian-context-chip is-plan", text: "Plan mode" });
    }

    this.inputEl = composerShell.createEl("textarea", {
      cls: "codian-input",
      attr: {
        placeholder: this.getInputPlaceholder(activeConversation)
      }
    });

    this.inputEl.addEventListener("keydown", (event) => this.handleInputKeydown(event), { capture: true });
    this.inputEl.addEventListener("input", () => this.updateMentionSuggestions());
    this.inputEl.addEventListener("click", () => this.updateMentionSuggestions());

    const composerToolbar = composerShell.createDiv({ cls: "codian-composer-toolbar" });
    const meta = composerToolbar.createDiv({ cls: "codian-meta" });
    meta.createSpan({ text: getSubmitHintText() });
    meta.createSpan({ text: `Vault: ${this.getVaultLabel()}` });
    meta.createSpan({ text: activeConversation.threadId ? `Thread ${shortId(activeConversation.threadId)}` : "New thread" });

    const controls = composerToolbar.createDiv({ cls: "codian-composer-controls" });
    this.renderModelSelect(controls);
    this.renderEffortSelect(controls);

    this.runButtonEl = controls.createEl("button", {
      cls: "codian-run-button",
      text: "Run"
    });
    setIcon(this.runButtonEl.createSpan({ cls: "codian-run-icon" }), "send");
    this.runButtonEl.onclick = () => void this.sendPrompt();

    this.stopButtonEl = controls.createEl("button", {
      cls: "codian-stop-button",
      text: "Stop",
      attr: { title: "Stop assistant" }
    });
    setIcon(this.stopButtonEl.createSpan({ cls: "codian-run-icon" }), "square");
    this.stopButtonEl.onclick = () => this.stopCurrentRun();

    this.refreshActiveRunUi();
  }

  private createPill(parent: HTMLElement, label: string, value: string, cls: string): HTMLElement {
    const pill = parent.createSpan({ cls: `codian-pill ${cls}` });
    pill.createSpan({ cls: "codian-pill-label", text: label });
    pill.createSpan({ cls: "codian-pill-value", text: value });
    return pill;
  }

  private renderConversationTabs(): void {
    const active = this.plugin.getActiveConversation();
    const tabs = this.containerEl.createDiv({ cls: "codian-tabs" });

    for (const conversation of this.plugin.data.conversations) {
      const tab = tabs.createEl("button", {
        cls: `codian-tab ${conversation.id === active.id ? "is-active" : ""}`,
        attr: { title: conversation.title }
      });
      tab.onclick = async () => {
        this.plugin.activateConversation(conversation.id);
        await this.plugin.saveCodianData();
        this.render();
      };
      tab.createSpan({ cls: "codian-tab-title", text: conversation.title });
      tab.createSpan({ cls: "codian-tab-count", text: String(conversation.messages.filter((message) => message.role === "assistant").length) });
      const close = tab.createSpan({ cls: "codian-tab-close", attr: { "aria-label": "Close chat" } });
      setIcon(close, "x");
      close.onclick = async (event) => {
        event.stopPropagation();
        if (this.isConversationRunning(conversation.id)) {
          new Notice("Stop this conversation before closing it.");
          return;
        }
        this.plugin.closeConversation(conversation.id);
        await this.plugin.saveCodianData();
        this.render();
      };
    }
  }

  private createIconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "codian-icon-button",
      attr: { "aria-label": label, title: label }
    });
    setIcon(button, icon);
    return button;
  }

  private getVaultLabel(): string {
    const vaultPath = this.plugin.getVaultPath();
    if (!vaultPath) return "Vault unavailable";
    return path.basename(vaultPath);
  }

  private renderModelSelect(parent: HTMLElement): void {
    const select = parent.createEl("select", {
      cls: "codian-model-select",
      attr: { title: "Codex model" }
    });
    const current = this.plugin.data.settings.model.trim();
    const hasCurrent = MODEL_OPTIONS.some((option) => option.value === current);
    for (const option of MODEL_OPTIONS) {
      select.createEl("option", { value: option.value, text: option.label });
    }
    if (current && !hasCurrent) {
      select.createEl("option", { value: current, text: current });
    }
    select.value = current;
    select.onchange = async () => {
      this.plugin.data.settings.model = select.value;
      await this.plugin.saveCodianData();
      this.render();
    };
  }

  private renderEffortSelect(parent: HTMLElement): void {
    const select = parent.createEl("select", {
      cls: "codian-model-select codian-effort-select",
      attr: { title: "Reasoning effort" }
    });
    for (const option of EFFORT_OPTIONS) {
      select.createEl("option", { value: option.value, text: option.label });
    }
    select.value = this.plugin.data.settings.modelReasoningEffort;
    select.onchange = async () => {
      this.plugin.data.settings.modelReasoningEffort = select.value as ReasoningEffort;
      await this.plugin.saveCodianData();
    };
  }

  private getCurrentNoteLabel(conversation: CodianConversation): string | null {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    if (conversation.excludedAutoNotePaths.includes(file.path)) return null;
    if (!this.plugin.data.settings.includeCurrentNoteContext) return null;
    return `Note: ${file.basename}`;
  }

  private getInputPlaceholder(conversation: CodianConversation): string {
    const hasNoteContext = this.getCurrentNoteLabel(conversation) !== null;
    const hasAttachedContext = conversation.contextPaths.length > 0;
    if (hasNoteContext || hasAttachedContext) {
      return "";
    }
    return "How can I help you today?";
  }

  private handleInputKeydown(event: KeyboardEvent): void {
    if (this.handleMentionKeydown(event)) return;
    if (!isSubmitHotkey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    void this.sendPrompt();
  }

  private handleScopedSubmitHotkey(event: KeyboardEvent): false | void {
    if (document.activeElement !== this.inputEl) return;
    if (this.mentionSuggestions.length > 0) return false;
    event.preventDefault();
    event.stopPropagation();
    void this.sendPrompt();
    return false;
  }

  private handleMentionKeydown(event: KeyboardEvent): boolean {
    if (this.mentionSuggestions.length === 0) return false;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      this.selectedMentionIndex = Math.min(this.selectedMentionIndex + 1, this.mentionSuggestions.length - 1);
      this.renderMentionSuggestions();
      return true;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      this.selectedMentionIndex = Math.max(this.selectedMentionIndex - 1, 0);
      this.renderMentionSuggestions();
      return true;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      const item = this.mentionSuggestions[this.selectedMentionIndex];
      if (item) void this.acceptMention(item);
      return true;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.hideMentionSuggestions();
      return true;
    }

    return false;
  }

  private updateMentionSuggestions(): void {
    const match = this.getMentionMatch();
    if (!match) {
      this.hideMentionSuggestions();
      return;
    }

    const query = match.query.toLowerCase();
    const activeConversation = this.plugin.getActiveConversation();
    const files = this.app.vault.getFiles()
      .filter((file) => isAttachableContextFile(file))
      .filter((file) => !activeConversation.contextPaths.includes(file.path))
      .filter((file) => !query || file.path.toLowerCase().includes(query) || file.basename.toLowerCase().includes(query));
    const folders = this.buildMentionFolderSuggestions(query, activeConversation.contextPaths);
    const fileSuggestions: MentionSuggestion[] = files.slice(0, Math.max(6, 10 - folders.length)).map((file) => ({
      kind: "file",
      file,
      path: file.path,
      title: file.basename,
      detail: file.path
    }));

    this.mentionSuggestions = [...folders, ...fileSuggestions].slice(0, 10);
    this.selectedMentionIndex = 0;

    if (this.mentionSuggestions.length === 0) {
      this.hideMentionSuggestions();
      return;
    }

    this.renderMentionSuggestions();
  }

  private renderMentionSuggestions(): void {
    if (!this.mentionSuggestEl) return;
    this.mentionSuggestEl.empty();
    this.mentionSuggestEl.removeClass("is-hidden");

    for (const [index, suggestion] of this.mentionSuggestions.entries()) {
      const item = this.mentionSuggestEl.createDiv({
        cls: `codian-mention-item is-${suggestion.kind} ${index === this.selectedMentionIndex ? "is-selected" : ""}`
      });
      const icon = item.createSpan({ cls: "codian-mention-icon" });
      setIcon(icon, suggestion.kind === "folder" ? "folder" : "file-text");
      const text = item.createSpan({ cls: "codian-mention-text" });
      text.createSpan({ cls: "codian-mention-title", text: suggestion.title });
      text.createSpan({ cls: "codian-mention-path", text: suggestion.detail });
      item.onmouseenter = () => {
        this.selectedMentionIndex = index;
        this.renderMentionSuggestions();
      };
      item.onmousedown = (event) => {
        event.preventDefault();
        void this.acceptMention(suggestion);
      };
    }
  }

  private hideMentionSuggestions(): void {
    this.mentionSuggestions = [];
    this.selectedMentionIndex = 0;
    this.mentionSuggestEl?.addClass("is-hidden");
    this.mentionSuggestEl?.empty();
  }

  private async acceptMention(suggestion: MentionSuggestion): Promise<void> {
    const match = this.getMentionMatch();
    if (!match || !this.inputEl) return;

    if (suggestion.kind === "folder") {
      const before = this.inputEl.value.slice(0, match.start);
      const after = this.inputEl.value.slice(match.end);
      const nextToken = `@${suggestion.path}/`;
      this.inputEl.value = `${before}${nextToken}${after}`;
      const nextCursor = before.length + nextToken.length;
      this.inputEl.focus();
      this.inputEl.setSelectionRange(nextCursor, nextCursor);
      this.updateMentionSuggestions();
      return;
    }

    const before = this.inputEl.value.slice(0, match.start);
    const after = this.inputEl.value.slice(match.end);
    const separator = before && !/\s$/.test(before) && after && !/^\s/.test(after) ? " " : "";
    const nextValue = `${before}${separator}${after}`.replace(/[ \t]{2,}/g, " ");
    const nextCursor = Math.min((before + separator).length, nextValue.length);

    const conversation = this.plugin.getActiveConversation();
    this.plugin.addContextPath(conversation, suggestion.file.path);
    await this.plugin.saveCodianData();
    this.hideMentionSuggestions();
    this.render();
    if (this.inputEl) {
      this.inputEl.value = nextValue;
      this.inputEl.focus();
      this.inputEl.setSelectionRange(nextCursor, nextCursor);
    }
  }

  private getMentionMatch(): { start: number; end: number; query: string } | null {
    if (!this.inputEl) return null;
    const cursor = this.inputEl.selectionStart ?? 0;
    const beforeCursor = this.inputEl.value.slice(0, cursor);
    const match = beforeCursor.match(/(^|[\s([{])@([^\s@]*)$/);
    if (!match) return null;
    const query = match[2] ?? "";
    const start = beforeCursor.length - query.length - 1;
    return {
      start: Math.max(0, start),
      end: cursor,
      query
    };
  }

  private buildMentionFolderSuggestions(query: string, attachedPaths: string[]): MentionSuggestion[] {
    const folderPaths = new Set<string>();

    for (const file of this.app.vault.getFiles()) {
      if (!isAttachableContextFile(file) || attachedPaths.includes(file.path)) continue;

      const parts = file.path.split("/");
      parts.pop();
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        folderPaths.add(current);
      }
    }

    return Array.from(folderPaths)
      .filter((folderPath) => {
        const normalizedPath = folderPath.toLowerCase();
        if (!query) return true;
        return normalizedPath.includes(query) || `${normalizedPath}/`.startsWith(query);
      })
      .sort((a, b) => {
        const aStarts = query && a.toLowerCase().startsWith(query) ? 0 : 1;
        const bStarts = query && b.toLowerCase().startsWith(query) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.localeCompare(b);
      })
      .slice(0, 4)
      .map((folderPath) => ({
        kind: "folder",
        path: folderPath,
        title: `${path.basename(folderPath)}/`,
        detail: `Filter ${folderPath}/`
      }));
  }

  private renderMessages(): void {
    if (!this.messageListEl) return;
    this.messageListEl.empty();
    const conversation = this.plugin.getActiveConversation();

    if (conversation.messages.length === 0) {
      const empty = this.messageListEl.createDiv({ cls: "codian-empty" });
      empty.setText("Codex will run with this vault as its working directory. Ask it to analyze notes, draft edits, or make changes to files.");
      return;
    }

    for (const message of conversation.messages) {
      if (message.role === "tool" && !this.plugin.data.settings.showToolEvents) continue;
      this.renderMessage(message);
    }

    this.scrollToBottom();
  }

  private renderMessage(message: CodianMessage): void {
    if (!this.messageListEl) return;

    const wrapper = this.messageListEl.createDiv({
      cls: `codian-message is-${message.role}`,
      attr: { "data-message-id": message.id }
    });
    const avatar = wrapper.createDiv({ cls: "codian-message-avatar" });
    setIcon(avatar, messageIcon(message.role));
    const content = wrapper.createDiv({ cls: "codian-message-content" });
    const header = content.createDiv({ cls: "codian-message-header" });
    header.createSpan({ cls: "codian-message-role", text: roleLabel(message.role) });
    header.createSpan({ cls: "codian-message-time", text: formatMessageTime(message.timestamp) });
    const body = content.createDiv({ cls: "codian-message-body" });
    this.renderMessageBody(body, message);
  }

  private updateMessage(message: CodianMessage): void {
    const body = this.messageListEl?.querySelector<HTMLElement>(`[data-message-id="${message.id}"] .codian-message-body`);
    if (!body) {
      this.renderMessage(message);
      return;
    }
    this.renderMessageBody(body, message);
    this.scrollToBottom();
  }

  private renderMessageBody(body: HTMLElement, message: CodianMessage): void {
    body.empty();
    if (message.role === "assistant" || message.role === "user") {
      if (this.isStreamingAssistantMessage(message)) {
        body.addClass("is-streaming");
        body.setText(message.content || " ");
        return;
      }
      body.removeClass("is-streaming");
      void MarkdownRenderer.render(this.app, message.content || " ", body, "", this).then(() => {
        this.bindInternalMarkdownLinks(body);
      });
      return;
    }
    if (message.role === "tool") {
      const details = body.createEl("details", { cls: "codian-event-details" });
      const summary = details.createEl("summary", { text: firstLine(message.content) || "Event" });
      summary.createSpan({ cls: "codian-event-chevron", text: "" });
      details.createEl("pre", { text: message.content });
      return;
    }
    body.setText(message.content);
  }

  private async sendPrompt(): Promise<void> {
    const prompt = this.inputEl?.value.trim() ?? "";
    if (!prompt) return;

    const vaultPath = this.plugin.getVaultPath();
    if (!vaultPath) {
      this.addMessage("error", "Could not determine the vault path. Codian only works in Obsidian desktop vaults.");
      return;
    }

    const codexPath = this.plugin.resolveCodexCliPath();
    if (!codexPath) {
      this.addMessage("error", "Codex CLI was not found. Install Codex CLI or set its path in plugin settings.");
      return;
    }

    const conversation = this.plugin.getActiveConversation();
    if (this.runs.has(conversation.id)) {
      new Notice("Codex is already running in this conversation.");
      return;
    }

    const slash = expandSlashCommand(prompt);
    if (slash.localOnly) {
      this.addMessage("system", slash.prompt, conversation);
      this.inputEl!.value = "";
      return;
    }
    const turnMode = slash.mode ?? conversation.mode;
    const codexPrompt = await this.buildPromptWithContext(slash.prompt, turnMode, conversation);

    this.inputEl!.value = "";
    this.addMessage("user", prompt, conversation);
    this.plugin.updateConversationTitle(conversation, prompt);
    const assistant = this.addMessage("assistant", "", conversation);
    this.plugin.touchConversation(conversation);
    await this.plugin.saveCodianData();

    const run: CodianRunState = {
      conversationId: conversation.id,
      assistantMessageId: assistant.id,
      child: null,
      pendingLine: "",
      stderrBuffer: [],
      stopped: false,
      receivedAssistantDelta: false
    };
    this.runs.set(conversation.id, run);

    this.refreshActiveRunUi();
    this.setStatus("Starting Codex...");

    const args = this.buildCodexArgs(vaultPath, turnMode, conversation);
    const env = this.plugin.buildEnvironment(codexPath);
    const codexSpawn = buildCodexSpawn(codexPath, args);

    try {
      run.child = spawn(codexSpawn.command, codexSpawn.args, {
        cwd: vaultPath,
        env,
        stdio: "pipe"
      });
    } catch (error) {
      this.runs.delete(conversation.id);
      this.finishWithError(`Failed to start Codex: ${formatError(error)}`, conversation);
      return;
    }

    run.child.stdin.write(codexPrompt);
    run.child.stdin.end();

    run.child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdout(run, chunk.toString("utf8"));
    });

    run.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        run.stderrBuffer.push(text);
      }
    });

    run.child.on("error", (error) => {
      this.finishWithError(formatError(error), conversation);
    });

    run.child.on("close", (code, signal) => {
      void this.handleRunClose(run, conversation, code, signal);
    });
  }

  private async handleRunClose(run: CodianRunState, conversation: CodianConversation, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (run.pendingLine.trim()) {
      this.consumeJsonLine(run, run.pendingLine);
      run.pendingLine = "";
    }

    this.runs.delete(run.conversationId);
    this.renderCompletedAssistantMessage(run);
    if (run.stopped || signal) {
      if (this.isActiveConversation(run.conversationId)) this.setStatus("Stopped");
    } else if (code === 0) {
      this.flushSuccessfulStderr(run);
      if (this.isActiveConversation(run.conversationId)) this.setStatus(this.buildReadyStatus());
    } else {
      this.flushFailedStderr(run);
      this.addMessage("error", `Codex exited with code ${code ?? "unknown"}.`, conversation);
      if (this.isActiveConversation(run.conversationId)) this.setStatus(`Codex exited with code ${code ?? "unknown"}`, true);
    }

    this.refreshActiveRunUi();
    await this.plugin.saveCodianData();
  }

  private bindInternalMarkdownLinks(container: HTMLElement): void {
    const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
    const links = container.querySelectorAll<HTMLAnchorElement>("a.internal-link, a[href]");
    links.forEach((link) => {
      const rawTarget = link.getAttr("data-href") ?? link.getAttr("href") ?? "";
      const target = normalizeVaultLinkTarget(rawTarget);
      if (!target || isExternalUrl(target)) return;

      link.addClass("internal-link");
      link.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.app.workspace.openLinkText(target, sourcePath, false);
      };
    });
  }

  private async buildPromptWithContext(prompt: string, mode: ConversationMode, conversation: CodianConversation): Promise<string> {
    const contextBlocks: string[] = [];
    const file = this.app.workspace.getActiveFile();

    if (file && this.plugin.data.settings.includeCurrentNoteContext && !conversation.excludedAutoNotePaths.includes(file.path)) {
      try {
        const content = await this.app.vault.read(file);
        contextBlocks.push(`CURRENT NOTE
Path: ${file.path}

\`\`\`markdown
${limitText(content, 12000)}
\`\`\``);
      } catch {
        contextBlocks.push(`CURRENT NOTE
Path: ${file.path}
Content: unavailable`);
      }
    }

    for (const contextPath of conversation.contextPaths) {
      const contextFile = this.app.vault.getAbstractFileByPath(contextPath);
      if (!(contextFile instanceof TFile)) continue;
      try {
        const content = await this.app.vault.read(contextFile);
        contextBlocks.push(`ATTACHED CONTEXT FILE
Path: ${contextFile.path}

\`\`\`markdown
${limitText(content, 12000)}
\`\`\``);
      } catch {
        contextBlocks.push(`ATTACHED CONTEXT FILE
Path: ${contextPath}
Content: unavailable`);
      }
    }

    if (this.plugin.data.settings.includeSelectedTextContext) {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const selectedText = view?.editor.getSelection();
      if (selectedText?.trim()) {
        contextBlocks.push(`SELECTED TEXT
\`\`\`markdown
${limitText(selectedText, 6000)}
\`\`\``);
      }
    }

    const instruction = mode === "plan" ? `${PLAN_MODE_INSTRUCTIONS}

REQUEST
${prompt}` : prompt;

    if (contextBlocks.length === 0) return instruction;

    return `${contextBlocks.join("\n\n")}

USER REQUEST
${instruction}`;
  }

  private flushSuccessfulStderr(run: CodianRunState): void {
    const warnings = run.stderrBuffer
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => !isBenignCodexStderr(item));
    run.stderrBuffer = [];

    if (!this.plugin.data.settings.showToolEvents) return;
    for (const warning of warnings) {
      this.addEphemeralToolEvent(run, `stderr: ${warning}`);
    }
  }

  private flushFailedStderr(run: CodianRunState): void {
    const stderr = run.stderrBuffer.map((item) => item.trim()).filter(Boolean).join("\n");
    run.stderrBuffer = [];
    if (stderr) {
      const conversation = this.getConversationById(run.conversationId);
      if (conversation) this.addMessage("error", stderr, conversation);
    }
  }

  private buildCodexArgs(vaultPath: string, mode: ConversationMode, conversation: CodianConversation): string[] {
    const settings = this.plugin.data.settings;
    const args: string[] = ["exec"];
    const model = settings.model.trim();
    const effortArgs = buildReasoningEffortArgs(settings.modelReasoningEffort, mode);
    const extraArgs = splitCliArgs(settings.extraArgs);

    if (conversation.threadId) {
      args.push("resume");
      args.push("--json", "--skip-git-repo-check");
      args.push("-c", `sandbox_mode="${mode === "plan" ? "read-only" : settings.sandboxMode}"`);
      args.push("-c", `approval_policy="${settings.approvalPolicy}"`);
      args.push(...effortArgs);
      if (model) args.push("-m", model);
      args.push(...extraArgs);
      args.push(conversation.threadId);
    } else {
      args.push("--json", "--color", "never", "--skip-git-repo-check");
      args.push("-C", vaultPath);
      args.push("-s", mode === "plan" ? "read-only" : settings.sandboxMode);
      args.push("-c", `approval_policy="${settings.approvalPolicy}"`);
      args.push(...effortArgs);
      if (model) args.push("-m", model);
      args.push(...extraArgs);
    }

    args.push("-");
    return args;
  }

  private handleStdout(run: CodianRunState, text: string): void {
    run.pendingLine += text;
    const lines = run.pendingLine.split(/\r?\n/);
    run.pendingLine = lines.pop() ?? "";

    for (const line of lines) {
      this.consumeJsonLine(run, line);
    }
  }

  private consumeJsonLine(run: CodianRunState, rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;

    let event: CodexJsonEvent;
    try {
      event = JSON.parse(line) as CodexJsonEvent;
    } catch {
      this.appendAssistantText(run, line);
      return;
    }

    const deltaText = extractAssistantDeltaText(event);
    if (deltaText) {
      run.receivedAssistantDelta = true;
      this.appendAssistantText(run, deltaText);
      return;
    }

    switch (event.type) {
      case "thread.started":
        if (event.thread_id) {
          const conversation = this.getConversationById(run.conversationId);
          if (conversation) {
            conversation.threadId = event.thread_id;
            this.plugin.touchConversation(conversation);
          }
          if (this.isActiveConversation(run.conversationId)) this.setStatus(`Thread ${shortId(event.thread_id)} running...`);
        }
        break;
      case "turn.started":
        if (this.isActiveConversation(run.conversationId)) this.setStatus("Codex is working...");
        break;
      case "turn.completed":
        if (this.isActiveConversation(run.conversationId)) this.setStatus(this.buildReadyStatus());
        break;
      case "turn.failed":
        this.addMessageToRun(run, "error", stringifyEventError(event));
        if (this.isActiveConversation(run.conversationId)) this.setStatus("Codex turn failed", true);
        break;
      case "error":
        this.addMessageToRun(run, "error", stringifyEventError(event));
        if (this.isActiveConversation(run.conversationId)) this.setStatus("Codex error", true);
        break;
      case "item.started":
      case "item.completed":
        this.consumeItemEvent(run, event);
        break;
      default:
        if (this.plugin.data.settings.showToolEvents) {
          this.addEphemeralToolEvent(run, JSON.stringify(event));
        }
    }
  }

  private consumeItemEvent(run: CodianRunState, event: CodexJsonEvent): void {
    const item = event.item;
    if (!item) return;

    if (item.type === "agent_message" && typeof item.text === "string") {
      if (run.receivedAssistantDelta) {
        this.setAssistantText(run, item.text);
      } else {
        this.appendAssistantText(run, item.text);
      }
      return;
    }

    if (item.type === "reasoning") {
      if (this.plugin.data.settings.showReasoning) {
        const summary = typeof item.summary === "string" ? item.summary : typeof item.text === "string" ? item.text : "";
        if (summary.trim()) this.addEphemeralToolEvent(run, `reasoning: ${summary.trim()}`);
      }
      return;
    }

    if (!this.plugin.data.settings.showToolEvents) return;

    if (item.type === "command_execution") {
      const parts = [
        event.type === "item.started" ? "command started" : "command completed",
        item.command ? `$ ${item.command}` : "",
        item.status ? `status: ${item.status}` : "",
        item.output ? item.output : ""
      ].filter(Boolean);
      this.addEphemeralToolEvent(run, parts.join("\n"));
      return;
    }

    if (typeof item.type === "string" && /plan/i.test(item.type)) {
      const text = typeof item.text === "string" ? item.text : typeof item.summary === "string" ? item.summary : JSON.stringify(item);
      this.addEphemeralToolEvent(run, `plan update\n${text}`);
      return;
    }

    if (typeof item.type === "string" && /(file|patch|diff)/i.test(item.type)) {
      const text = typeof item.text === "string" ? item.text : JSON.stringify(item);
      this.addEphemeralToolEvent(run, `${item.type}\n${text}`);
      return;
    }

    if (event.type === "item.completed") {
      const label = item.type ?? "item";
      const text = typeof item.text === "string" ? item.text : JSON.stringify(item);
      this.addEphemeralToolEvent(run, `${label}: ${text}`);
    }
  }

  private appendAssistantText(run: CodianRunState, text: string): void {
    const conversation = this.getConversationById(run.conversationId);
    if (!conversation) return;
    const message = conversation.messages.find((candidate) => candidate.id === run.assistantMessageId);
    if (!message) {
      this.addMessage("assistant", text, conversation);
      return;
    }

    message.content += text;
    message.timestamp = Date.now();
    this.plugin.touchConversation(conversation);
    if (this.isActiveConversation(conversation.id)) this.updateMessage(message);
    this.plugin.requestSaveCodianData();
  }

  private setAssistantText(run: CodianRunState, text: string): void {
    const conversation = this.getConversationById(run.conversationId);
    if (!conversation) return;
    const message = conversation.messages.find((candidate) => candidate.id === run.assistantMessageId);
    if (!message) return;

    message.content = text;
    message.timestamp = Date.now();
    this.plugin.touchConversation(conversation);
    if (this.isActiveConversation(conversation.id)) this.updateMessage(message);
    this.plugin.requestSaveCodianData();
  }

  private addEphemeralToolEvent(run: CodianRunState, text: string): void {
    if (!this.plugin.data.settings.showToolEvents) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    this.addMessageToRun(run, "tool", trimmed);
  }

  private addMessageToRun(run: CodianRunState, role: MessageRole, content: string): CodianMessage | null {
    const conversation = this.getConversationById(run.conversationId);
    if (!conversation) return null;
    return this.addMessage(role, content, conversation);
  }

  private addMessage(role: MessageRole, content: string, conversation = this.plugin.getActiveConversation()): CodianMessage {
    const message: CodianMessage = {
      id: createId(),
      role,
      content,
      timestamp: Date.now()
    };
    conversation.messages.push(message);
    this.plugin.touchConversation(conversation);

    if (!this.isActiveConversation(conversation.id)) {
      this.plugin.requestSaveCodianData();
      return message;
    }

    if (this.messageListEl?.querySelector(".codian-empty")) {
      this.messageListEl.empty();
    }

    this.renderMessage(message);
    this.scrollToBottom();
    this.plugin.requestSaveCodianData();
    return message;
  }

  private finishWithError(message: string, conversation = this.plugin.getActiveConversation()): void {
    this.runs.delete(conversation.id);
    this.addMessage("error", message, conversation);
    this.refreshActiveRunUi();
    if (this.isActiveConversation(conversation.id)) this.setStatus(message, true);
    void this.plugin.saveCodianData();
  }

  private stopCurrentRun(): void {
    const run = this.getActiveRun();
    if (!run?.child) return;
    run.stopped = true;
    const running = run.child;
    run.child = null;
    running.kill("SIGTERM");
    setTimeout(() => {
      if (!running.killed) running.kill("SIGKILL");
    }, 1500);
    const conversation = this.getConversationById(run.conversationId);
    if (conversation) this.addMessage("system", "Stopped Codex.", conversation);
    this.refreshActiveRunUi();
    this.setStatus("Stopped");
  }

  private stopAllRuns(): void {
    for (const run of this.runs.values()) {
      if (!run.child) continue;
      run.stopped = true;
      const running = run.child;
      run.child = null;
      running.kill("SIGTERM");
      setTimeout(() => {
        if (!running.killed) running.kill("SIGKILL");
      }, 1500);
      const conversation = this.getConversationById(run.conversationId);
      if (conversation) this.addMessage("system", "Stopped Codex.", conversation);
    }
    this.runs.clear();
    this.refreshActiveRunUi();
  }

  private setRunning(running: boolean): void {
    if (this.runButtonEl) this.runButtonEl.disabled = running;
    if (this.stopButtonEl) this.stopButtonEl.disabled = !running;
    if (this.inputEl) this.inputEl.disabled = running;
  }

  private refreshActiveRunUi(): void {
    const run = this.getActiveRun();
    this.setRunning(Boolean(run));
    if (run) {
      this.setStatus("Codex is working...");
    } else {
      this.setStatus(this.buildReadyStatus());
    }
  }

  private getActiveRun(): CodianRunState | null {
    return this.runs.get(this.plugin.getActiveConversation().id) ?? null;
  }

  private isStreamingAssistantMessage(message: CodianMessage): boolean {
    for (const run of this.runs.values()) {
      if (run.assistantMessageId === message.id) return true;
    }
    return false;
  }

  private renderCompletedAssistantMessage(run: CodianRunState): void {
    if (!this.isActiveConversation(run.conversationId)) return;
    const conversation = this.getConversationById(run.conversationId);
    const message = conversation?.messages.find((candidate) => candidate.id === run.assistantMessageId);
    if (message) this.updateMessage(message);
  }

  private isConversationRunning(conversationId: string): boolean {
    return this.runs.has(conversationId);
  }

  private isActiveConversation(conversationId: string): boolean {
    return this.plugin.getActiveConversation().id === conversationId;
  }

  private getConversationById(conversationId: string): CodianConversation | null {
    return this.plugin.data.conversations.find((conversation) => conversation.id === conversationId) ?? null;
  }

  private setStatus(text: string, isError = false): void {
    if (!this.statusEl) return;
    this.statusEl.setText(text);
    this.statusEl.toggleClass("is-error", isError);
  }

  private buildReadyStatus(): string {
    const codexPath = this.plugin.resolveCodexCliPath();
    const vaultPath = this.plugin.getVaultPath();
    if (!codexPath) return "Codex CLI not found. Set the path in settings.";
    if (!vaultPath) return "Vault path not available.";
    const conversation = this.plugin.getActiveConversation();
    const thread = conversation.threadId ? ` · thread ${shortId(conversation.threadId)}` : "";
    return `Ready · ${codexPath}${thread}`;
  }

  private scrollToBottom(): void {
    if (!this.plugin.data.settings.autoScroll || !this.messageListEl) return;
    this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
  }
}

class CodianSettingTab extends PluginSettingTab {
  private plugin: CodianPlugin;

  constructor(app: App, plugin: CodianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Codian")
      .setHeading();

    const resolved = this.plugin.resolveCodexCliPath();
    new Setting(containerEl)
      .setName("Detected command")
      .setDesc(resolved ?? "Not found")
      .addButton((button) => {
        button
          .setButtonText("Refresh")
          .onClick(() => this.display());
      });

    new Setting(containerEl)
      .setName("Command path")
      .setDesc("Leave empty to auto-detect. Use the output of `which codex` if the app cannot find it.")
      .addText((text) => {
        text
          .setPlaceholder("/usr/local/bin/codex")
          .setValue(this.plugin.data.settings.codexCliPath)
          .onChange(async (value) => {
            this.plugin.data.settings.codexCliPath = value;
            await this.plugin.saveCodianData();
            this.plugin.getView()?.render();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Optional model override. Leave empty to use your command-line config.")
      .addDropdown((dropdown) => {
        for (const option of MODEL_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        const current = this.plugin.data.settings.model.trim();
        if (current && !MODEL_OPTIONS.some((option) => option.value === current)) {
          dropdown.addOption(current, current);
        }
        dropdown
          .setValue(current)
          .onChange(async (value) => {
            this.plugin.data.settings.model = value;
            await this.plugin.saveCodianData();
            this.plugin.getView()?.render();
          });
      });

    new Setting(containerEl)
      .setName("Reasoning effort")
      .setDesc("Optional reasoning effort override. Plan mode uses the plan-mode effort key.")
      .addDropdown((dropdown) => {
        for (const option of EFFORT_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown
          .setValue(this.plugin.data.settings.modelReasoningEffort)
          .onChange(async (value) => {
            this.plugin.data.settings.modelReasoningEffort = value as ReasoningEffort;
            await this.plugin.saveCodianData();
            this.plugin.getView()?.render();
          });
      });

    new Setting(containerEl)
      .setName("Sandbox mode")
      .setDesc("Controls what the assistant can write while running in this vault.")
      .addDropdown((dropdown) => {
        dropdown
          .addOptions({
            "read-only": "read-only",
            "workspace-write": "workspace-write",
            "danger-full-access": "danger-full-access"
          })
          .setValue(this.plugin.data.settings.sandboxMode)
          .onChange(async (value) => {
            this.plugin.data.settings.sandboxMode = value as SandboxMode;
            await this.plugin.saveCodianData();
          });
      });

    new Setting(containerEl)
      .setName("Approval policy")
      .setDesc("For Obsidian, `never` is usually the least surprising non-interactive option; blocked actions fail instead of asking in a terminal.")
      .addDropdown((dropdown) => {
        dropdown
          .addOptions({
            never: "never",
            "on-request": "on-request",
            untrusted: "untrusted"
          })
          .setValue(this.plugin.data.settings.approvalPolicy)
          .onChange(async (value) => {
            this.plugin.data.settings.approvalPolicy = value as ApprovalPolicy;
            await this.plugin.saveCodianData();
          });
      });

    new Setting(containerEl)
      .setName("Show reasoning events")
      .setDesc("Displays reasoning summary events when debug tool events are enabled.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.data.settings.showReasoning)
          .onChange(async (value) => {
            this.plugin.data.settings.showReasoning = value;
            await this.plugin.saveCodianData();
          });
      });

    new Setting(containerEl)
      .setName("Show tool events")
      .setDesc("Debug option. When off, command/tool events are hidden from the chat transcript.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.data.settings.showToolEvents)
          .onChange(async (value) => {
            this.plugin.data.settings.showToolEvents = value;
            this.plugin.data.settings.eventDisplayPreferenceVersion = 1;
            await this.plugin.saveCodianData();
            this.plugin.getView()?.render();
          });
      });

    new Setting(containerEl)
      .setName("Auto-scroll")
      .setDesc("Scroll to the bottom while the assistant streams output.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.data.settings.autoScroll)
          .onChange(async (value) => {
            this.plugin.data.settings.autoScroll = value;
            await this.plugin.saveCodianData();
          });
      });

    new Setting(containerEl)
      .setName("Include current note context")
      .setDesc("Attach the active note path and content to each chat prompt.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.data.settings.includeCurrentNoteContext)
          .onChange(async (value) => {
            this.plugin.data.settings.includeCurrentNoteContext = value;
            await this.plugin.saveCodianData();
            this.plugin.getView()?.render();
          });
      });

    new Setting(containerEl)
      .setName("Include selected text context")
      .setDesc("Attach selected editor text to each chat prompt when text is selected.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.data.settings.includeSelectedTextContext)
          .onChange(async (value) => {
            this.plugin.data.settings.includeSelectedTextContext = value;
            await this.plugin.saveCodianData();
          });
      });

    new Setting(containerEl)
      .setName("Maximum saved chats")
      .setDesc("How many chat tabs to keep in plugin data.")
      .addSlider((slider) => {
        slider
          .setLimits(3, 20, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.data.settings.maxConversations)
          .onChange(async (value) => {
            this.plugin.data.settings.maxConversations = value;
            await this.plugin.saveCodianData();
            this.plugin.getView()?.render();
          });
      });

    new Setting(containerEl)
      .setName("Extra arguments")
      .setDesc("Advanced. Added before the prompt marker. Example: `--search`.")
      .addText((text) => {
        text
          .setPlaceholder("--search")
          .setValue(this.plugin.data.settings.extraArgs)
          .onChange(async (value) => {
            this.plugin.data.settings.extraArgs = value;
            await this.plugin.saveCodianData();
          });
      });

    new Setting(containerEl)
      .setName("Environment variables")
      .setDesc("One key=value per line. Use this for custom home, base URL, or path settings if needed.")
      .addTextArea((text) => {
        text
          .setPlaceholder("Custom variables, one per line")
          .setValue(this.plugin.data.settings.environmentVariables)
          .onChange(async (value) => {
            this.plugin.data.settings.environmentVariables = value;
            await this.plugin.saveCodianData();
            this.plugin.getView()?.render();
          });
        text.inputEl.rows = 6;
      });

    const warning = containerEl.createDiv({ cls: "codian-setting-warning" });
    warning.setText("The assistant can read prompts and tool output, and with workspace-write it can edit files in the vault. Review sandbox and approval settings before using it on sensitive vaults.");
  }
}

class InlineEditPromptModal extends Modal {
  private value = "";
  private resolve: ((value: string | null) => void) | null = null;

  openAndWait(): Promise<string | null> {
    this.open();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codian-inline-modal");
    contentEl.createEl("h2", { text: "Inline edit" });
    contentEl.createEl("p", {
      text: "Describe how the assistant should rewrite the selected text."
    });

    const input = contentEl.createEl("textarea", {
      cls: "codian-inline-modal-input",
      attr: {
        placeholder: "Example: make it clearer and more concise"
      }
    });
    input.rows = 5;
    input.focus();
    input.addEventListener("input", () => {
      this.value = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        this.submit();
      }
    });

    const actions = contentEl.createDiv({ cls: "codian-inline-modal-actions" });
    actions.createEl("button", { text: "Cancel" }).onclick = () => {
      this.resolve?.(null);
      this.resolve = null;
      this.close();
    };
    const submit = actions.createEl("button", {
      text: "Apply",
      cls: "mod-cta"
    });
    submit.onclick = () => this.submit();
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.resolve) {
      this.resolve(null);
      this.resolve = null;
    }
  }

  private submit(): void {
    const value = this.value.trim();
    if (!value) {
      new Notice("Enter an edit instruction.");
      return;
    }
    this.resolve?.(value);
    this.resolve = null;
    this.close();
  }
}

class ContextFileSuggestModal extends FuzzySuggestModal<TFile> {
  private plugin: CodianPlugin;
  private onDone: () => void;

  constructor(app: App, plugin: CodianPlugin, onDone: () => void) {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone;
    this.setPlaceholder("Attach a note or file as context...");
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((file) => {
      if (file.path.startsWith(`${this.app.vault.configDir}/`)) return false;
      return isAttachableContextFile(file);
    });
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    void this.chooseItem(file);
  }

  private async chooseItem(file: TFile): Promise<void> {
    const conversation = this.plugin.getActiveConversation();
    this.plugin.addContextPath(conversation, file.path);
    await this.plugin.saveCodianData();
    this.onDone();
    new Notice(`Attached ${file.path}`);
  }
}

class ConversationHistoryModal extends Modal {
  private plugin: CodianPlugin;
  private onDone: () => void;

  constructor(app: App, plugin: CodianPlugin, onDone: () => void) {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone;
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codian-history-modal");
    contentEl.createEl("h2", { text: "Chat history" });

    const list = contentEl.createDiv({ cls: "codian-history-list" });
    for (const conversation of this.plugin.data.conversations) {
      const row = list.createDiv({ cls: "codian-history-row" });
      const main = row.createDiv({ cls: "codian-history-main" });
      main.createDiv({ cls: "codian-history-title", text: conversation.title });
      main.createDiv({
        cls: "codian-history-meta",
        text: `${conversation.messages.length} messages · ${conversation.threadId ? `thread ${shortId(conversation.threadId)}` : "new thread"}`
      });
      main.onclick = async () => {
        this.plugin.activateConversation(conversation.id);
        await this.plugin.saveCodianData();
        this.onDone();
        this.close();
      };

      const rename = row.createEl("button", { text: "Rename" });
      rename.onclick = async () => {
        const title = await new TextPromptModal(this.app, "Rename chat", "Chat title", conversation.title).openAndWait();
        if (!title) return;
        conversation.title = title;
        this.plugin.touchConversation(conversation);
        await this.plugin.saveCodianData();
        this.render();
        this.onDone();
      };

      const remove = row.createEl("button", { text: "Delete" });
      remove.onclick = async () => {
        this.plugin.closeConversation(conversation.id);
        await this.plugin.saveCodianData();
        this.render();
        this.onDone();
      };
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class TextPromptModal extends Modal {
  private titleText: string;
  private placeholder: string;
  private initialValue: string;
  private value: string;
  private resolve: ((value: string | null) => void) | null = null;

  constructor(app: App, titleText: string, placeholder: string, initialValue = "") {
    super(app);
    this.titleText = titleText;
    this.placeholder = placeholder;
    this.initialValue = initialValue;
    this.value = initialValue;
  }

  openAndWait(): Promise<string | null> {
    this.open();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.titleText });
    const input = contentEl.createEl("input", {
      type: "text",
      value: this.initialValue,
      attr: { placeholder: this.placeholder }
    });
    input.addEventListener("input", () => {
      this.value = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.submit();
      }
    });
    input.focus();

    const actions = contentEl.createDiv({ cls: "codian-inline-modal-actions" });
    actions.createEl("button", { text: "Cancel" }).onclick = () => {
      this.resolve?.(null);
      this.resolve = null;
      this.close();
    };
    actions.createEl("button", { text: "Save", cls: "mod-cta" }).onclick = () => this.submit();
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.resolve) {
      this.resolve(null);
      this.resolve = null;
    }
  }

  private submit(): void {
    const value = this.value.trim();
    this.resolve?.(value || null);
    this.resolve = null;
    this.close();
  }
}

function buildCodexSpawn(codexPath: string, args: string[]): { command: string; args: string[] } {
  const nodeScriptPath = process.platform === "win32" ? resolveWindowsNodeShimScript(codexPath) : null;
  if (nodeScriptPath) {
    return { command: resolveWindowsNodeForShim(codexPath), args: [nodeScriptPath, ...args] };
  }
  return { command: codexPath, args };
}

function extractAssistantDeltaText(event: CodexJsonEvent): string {
  const eventType = typeof event.type === "string" ? event.type : "";
  const itemType = typeof event.item?.type === "string" ? event.item.type : "";
  const combinedType = `${eventType} ${itemType}`;
  if (!/(agent_message|assistant|message|output_text|response).*delta|delta.*(agent_message|assistant|message|output_text|response)/i.test(combinedType)) {
    return "";
  }

  const candidates = [
    event.item?.text,
    event.item?.delta,
    event.item?.output,
    event.text,
    event.delta,
    event.message
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
  }

  return "";
}

function resolveWindowsNodeForShim(shimPath: string): string {
  const localNodePath = path.join(path.dirname(shimPath), "node.exe");
  return isExecutableFile(localNodePath) ? localNodePath : "node";
}

function resolveWindowsNodeShimScript(shimPath: string): string | null {
  const cmdShimPath = resolveWindowsCommandShimPath(shimPath);
  if (!cmdShimPath) return null;

  let content: string;
  try {
    content = fs.readFileSync(cmdShimPath, "utf8");
  } catch {
    return null;
  }

  const scriptMatch = content.match(/"%dp0%\\([^"\r\n]+)"\s+%\*/i);
  if (!scriptMatch) return null;

  const scriptPath = path.resolve(path.dirname(cmdShimPath), scriptMatch[1]);
  return isExecutableFile(scriptPath) ? scriptPath : null;
}

function resolveWindowsCommandShimPath(shimPath: string): string | null {
  if (/\.(cmd|bat)$/i.test(shimPath)) return shimPath;
  const cmdShimPath = `${shimPath}.cmd`;
  return isExecutableFile(cmdShimPath) ? cmdShimPath : null;
}
function findCodexCli(): string | null {
  const candidates = new Set<string>();
  const pathValue = process.env.PATH ?? "";
  for (const entry of pathValue.split(path.delimiter)) {
    if (entry) candidates.add(path.join(entry, process.platform === "win32" ? "codex.cmd" : "codex"));
  }

  const home = os.homedir();
  [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
    path.join(home, ".local", "bin", "codex"),
    path.join(home, ".npm-global", "bin", "codex"),
    path.join(home, ".volta", "bin", "codex"),
    path.join(home, ".asdf", "shims", "codex")
  ].forEach((candidate) => candidates.add(candidate));

  const nvmDir = path.join(home, ".nvm", "versions", "node");
  try {
    for (const version of fs.readdirSync(nvmDir)) {
      candidates.add(path.join(nvmDir, version, "bin", "codex"));
    }
  } catch {
    // nvm is optional.
  }

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }

  return null;
}

function isAttachableContextFile(file: TFile): boolean {
  return /\.(md|txt|canvas|json|csv|tsv|js|ts|tsx|jsx|css|html|py|toml|yaml|yml)$/i.test(file.path);
}

function normalizeVaultLinkTarget(target: string): string {
  let normalized = target.trim();
  if (/^obsidian:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      normalized = url.searchParams.get("file") ?? url.searchParams.get("path") ?? normalized.replace(/^obsidian:\/\//i, "");
    } catch {
      normalized = normalized.replace(/^obsidian:\/\//i, "");
    }
  }

  return decodeLinkTarget(normalized)
    .replace(/^obsidian:\/\//i, "")
    .replace(/^app:\/\//i, "")
    .replace(/^#/, "")
    .replace(/^\.\//, "");
}

function isExternalUrl(target: string): boolean {
  return /^(https?:|mailto:|file:|data:|ftp:)/i.test(target);
}

function decodeLinkTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target.replace(/%20/g, " ");
  }
}

function normalizeImportedIconSvg(svg: string): string {
  const withoutXmlDeclaration = svg.replace(/<\?xml[^>]*>\s*/i, "");
  const svgMatch = withoutXmlDeclaration.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/i);
  const innerSvg = (svgMatch ? svgMatch[1] : withoutXmlDeclaration).trim();
  const scale = 100 / CODIAN_ICON_SOURCE_SIZE;
  return `<g transform="scale(${scale})">${innerSvg}</g>`;
}

function migrateConversations(saved: Partial<CodianData> | null): CodianConversation[] {
  const raw = Array.isArray(saved?.conversations) ? saved.conversations : [];
  const conversations = raw
    .map((conversation) => normalizeConversation(conversation))
    .filter((conversation): conversation is CodianConversation => conversation !== null);

  if (conversations.length > 0) {
    return conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const legacyMessages = Array.isArray(saved?.messages) ? saved.messages : [];
  if (legacyMessages.length > 0 || saved?.threadId) {
    const now = Date.now();
    return [{
      id: createConversationId(),
      title: titleFromMessages(legacyMessages),
      threadId: saved?.threadId ?? null,
      messages: legacyMessages.filter(isCodianMessage),
      contextPaths: [],
      excludedAutoNotePaths: [],
      mode: "agent",
      createdAt: now,
      updatedAt: now
    }];
  }

  const now = Date.now();
  return [{
    id: createConversationId(),
    title: "New chat",
    threadId: null,
    messages: [],
    contextPaths: [],
    excludedAutoNotePaths: [],
    mode: "agent",
    createdAt: now,
    updatedAt: now
  }];
}

function normalizeConversation(value: unknown): CodianConversation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CodianConversation>;
  const now = Date.now();
  return {
    id: typeof candidate.id === "string" && candidate.id ? candidate.id : createConversationId(),
    title: typeof candidate.title === "string" && candidate.title ? candidate.title : titleFromMessages(candidate.messages ?? []),
    threadId: typeof candidate.threadId === "string" ? candidate.threadId : null,
    messages: Array.isArray(candidate.messages) ? candidate.messages.filter(isCodianMessage) : [],
    contextPaths: Array.isArray(candidate.contextPaths) ? candidate.contextPaths.filter((item): item is string => typeof item === "string") : [],
    excludedAutoNotePaths: Array.isArray(candidate.excludedAutoNotePaths) ? candidate.excludedAutoNotePaths.filter((item): item is string => typeof item === "string") : [],
    mode: candidate.mode === "plan" ? "plan" : "agent",
    createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : now,
    updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : now
  };
}

function resolveActiveConversationId(savedId: string | undefined, conversations: CodianConversation[]): string {
  if (savedId && conversations.some((conversation) => conversation.id === savedId)) {
    return savedId;
  }
  return conversations[0]?.id ?? createConversationId();
}

function isCodianMessage(value: unknown): value is CodianMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CodianMessage>;
  return typeof candidate.id === "string" && typeof candidate.content === "string" && typeof candidate.timestamp === "number" && (candidate.role === "user" || candidate.role === "assistant" || candidate.role === "system" || candidate.role === "tool" || candidate.role === "error");
}

function titleFromMessages(messages: unknown[]): string {
  const firstUser = messages.find((message): message is CodianMessage => isCodianMessage(message) && message.role === "user");
  return firstUser ? summarizeTitle(firstUser.content) : "New chat";
}

function summarizeTitle(prompt: string): string {
  const title = prompt.replace(/\s+/g, " ").trim();
  if (!title) return "New chat";
  return title.length > 34 ? `${title.slice(0, 31)}...` : title;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function parseEnvironmentVariables(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    let value = normalized.slice(equalsIndex + 1).trim();
    value = stripMatchingQuotes(value);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      env[key] = value;
    }
  }
  return env;
}

function splitCliArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);
  return args;
}

function isSubmitHotkey(event: KeyboardEvent): boolean {
  const isEnter = event.key === "Enter" || event.code === "Enter" || event.key === "NumpadEnter" || event.code === "NumpadEnter";
  if (!isEnter || event.isComposing) return false;

  const hasModifier = event.metaKey || event.ctrlKey || event.getModifierState("Meta") || event.getModifierState("Control");
  if (hasModifier) return true;

  return isMacPlatform() && !event.shiftKey && !event.altKey;
}

function isMacPlatform(): boolean {
  return process.platform === "darwin";
}

function getSubmitHintText(): string {
  return isMacPlatform() ? "Enter to run · Shift+Enter newline" : "Ctrl/Mod+Enter to run";
}

function expandHome(input: string): string {
  if (!input) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function stripMatchingQuotes(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function dedupePath(value: string): string {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value.split(path.delimiter)) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result.join(path.delimiter);
}

function createId(): string {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createConversationId(): string {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseCodexJsonLine(line: string): CodexJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CodexJsonEvent;
  } catch {
    return null;
  }
}

function buildReasoningEffortArgs(effort: ReasoningEffort, mode: ConversationMode): string[] {
  if (effort === "default") return [];
  const key = mode === "plan" ? "plan_mode_reasoning_effort" : "model_reasoning_effort";
  return ["-c", `${key}="${effort}"`];
}

function expandSlashCommand(input: string): SlashCommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { prompt: input };
  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const body = rest.join(" ").trim();

  switch (command) {
    case "/help":
      return {
        localOnly: true,
        prompt: `Codian slash commands:
/plan <task> - ask Codex for a read-only implementation plan
/summarize [focus] - summarize the current note/context
/rewrite <instruction> - rewrite selected/current note text according to the instruction
/find <query> - search the vault/project for relevant notes or files
/review [focus] - review the current note/context for issues`
      };
    case "/plan":
      return {
        mode: "plan",
        prompt: body || "Create a careful implementation plan for the current context."
      };
    case "/summarize":
      return {
        prompt: `Summarize the current note and attached context. Focus: ${body || "main ideas, action items, and important details"}.`
      };
    case "/rewrite":
      return {
        prompt: `Rewrite the selected text or current note according to this instruction: ${body || "make it clearer and more polished"}. Return the rewritten content and briefly note what changed.`
      };
    case "/find":
      return {
        prompt: `Search the vault/project for information related to: ${body || "the current context"}. Return the most relevant files or notes and explain why they matter.`
      };
    case "/review":
      return {
        prompt: `Review the current note and attached context. Focus: ${body || "accuracy, clarity, structure, missing details, and risks"}. Put findings first.`
      };
    default:
      return {
        localOnly: true,
        prompt: `Unknown Codian command: ${rawCommand}. Type /help for available commands.`
      };
  }
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n...[truncated ${omitted} characters]`;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

function buildInlineEditPrompt(instruction: string, selectedText: string, notePath: string): string {
  return `You are editing selected text in an Obsidian note.

Rules:
- Return only the replacement text.
- Do not wrap the answer in markdown fences.
- Preserve the user's language unless the instruction asks otherwise.
- Preserve useful markdown formatting.

Note path: ${notePath}

Instruction:
${instruction}

Selected text:
\`\`\`markdown
${selectedText}
\`\`\``;
}

function cleanInlineEditResponse(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1] : trimmed;
}

function roleLabel(role: MessageRole): string {
  switch (role) {
    case "user":
      return "You";
    case "assistant":
      return "Codex";
    case "tool":
      return "Event";
    case "error":
      return "Error";
    case "system":
      return "System";
  }
}

function messageIcon(role: MessageRole): string {
  switch (role) {
    case "assistant":
      return CODIAN_ICON_ID;
    case "user":
      return "user";
    case "tool":
      return "terminal";
    case "error":
      return "alert-triangle";
    case "system":
      return "info";
  }
}

function formatMessageTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "";
  }
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringifyEventError(event: CodexJsonEvent): string {
  if (typeof event.message === "string") return event.message;
  if (typeof event.error === "string") return event.error;
  if (event.error) return JSON.stringify(event.error);
  return JSON.stringify(event);
}

function isBenignCodexStderr(text: string): boolean {
  return [
    /codex_core::session: failed to record rollout items/i,
    /thread .* not found/i
  ].every((pattern) => pattern.test(text));
}
