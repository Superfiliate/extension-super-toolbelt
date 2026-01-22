import * as vscode from "vscode";

const CLIPBOARD_CLASS_NAME_REGEX =
  /^(::)?([A-Z][A-Za-z0-9]*)(::[A-Z][A-Za-z0-9]*)+$/;
const CLASS_DECLARATION_REGEX =
  /^\s*class\s+(::)?([A-Z][A-Za-z0-9]*(?:::[A-Z][A-Za-z0-9]*)*)/;
const MODULE_DECLARATION_REGEX =
  /^\s*module\s+(::)?([A-Z][A-Za-z0-9]*(?:::[A-Z][A-Za-z0-9]*)*)/;
const CLASS_SINGLETON_REGEX = /^\s*class\s+<</;
const END_REGEX = /^\s*end\b/;
const BLOCK_START_REGEX = /^\s*(def|if|unless|case|while|until|for|begin)\b/;
const DO_REGEX = /\bdo\b/;

type StackEntry = {
  kind: "namespace" | "block";
  fullParts?: string[];
};

const QUICK_OPEN_DEFAULT_COMMAND = "default:workbench.action.quickOpen";
const QUICK_OPEN_COMMAND = "workbench.action.quickOpen";
const CONFIG_SECTION = "superToolbelt";
const CLASS_COPY_SETTING = "enableClassCopy";
const QUICK_OPEN_SETTING = "enableQuickOpenFromClipboard";

export function activate(context: vscode.ExtensionContext) {
  const provider = new RubyClassCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: "ruby", scheme: "file" },
      provider
    )
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId === "ruby") {
        provider.refresh();
      }
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(`${CONFIG_SECTION}.${CLASS_COPY_SETTING}`) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.${QUICK_OPEN_SETTING}`)
      ) {
        provider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "superToolbelt.copyQualifiedClassName",
      async (qualifiedName: string) => {
        if (!isClassCopyEnabled()) {
          return;
        }

        if (!qualifiedName) {
          return;
        }

        await vscode.env.clipboard.writeText(qualifiedName);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "superToolbelt.quickOpenFromClipboard",
      async () => {
        if (!isQuickOpenEnabled()) {
          await executeQuickOpen("");
          return;
        }

        await quickOpenFromClipboard();
      }
    )
  );
}

export function deactivate() {}

class RubyClassCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter =
    new vscode.EventEmitter<void>();

  readonly onDidChangeCodeLenses =
    this.onDidChangeCodeLensesEmitter.event;

  refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.languageId !== "ruby") {
      return [];
    }

    if (!isClassCopyEnabled()) {
      return [];
    }

    return collectClassEntries(document).map(({ line, qualifiedName }) => {
      const range = new vscode.Range(line, 0, line, 0);
      return new vscode.CodeLens(range, {
        title: "$(copy)",
        command: "superToolbelt.copyQualifiedClassName",
        arguments: [qualifiedName],
      });
    });
  }
}

async function quickOpenFromClipboard(): Promise<void> {
  const clipboardText = (await vscode.env.clipboard.readText()).trim();

  if (CLIPBOARD_CLASS_NAME_REGEX.test(clipboardText)) {
    const sanitized = clipboardText.replace(/^::/, "");
    const query = sanitized
      .split("::")
      .map((segment) => toSnakeCase(segment))
      .join("/");

    await executeQuickOpen(query);
    return;
  }

  await executeQuickOpen("");
}

function isClassCopyEnabled(): boolean {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return config.get<boolean>(CLASS_COPY_SETTING, true);
}

function isQuickOpenEnabled(): boolean {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return config.get<boolean>(QUICK_OPEN_SETTING, true);
}

function stripStringsAndComments(line: string): string {
  let result = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const char of line) {
    if (escaped) {
      result += " ";
      escaped = false;
      continue;
    }

    if (char === "\\" && (inSingle || inDouble)) {
      escaped = true;
      result += " ";
      continue;
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      result += " ";
      continue;
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      result += " ";
      continue;
    }

    if (char === "#" && !inSingle && !inDouble) {
      break;
    }

    if (inSingle || inDouble) {
      result += " ";
      continue;
    }

    result += char;
  }

  return result;
}

function collectClassEntries(
  document: vscode.TextDocument
): Array<{ line: number; qualifiedName: string }> {
  const entries: Array<{ line: number; qualifiedName: string }> = [];
  const stack: StackEntry[] = [];
  const lines = document.getText().split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const line = stripStringsAndComments(rawLine);

    if (END_REGEX.test(line)) {
      if (stack.length > 0) {
        stack.pop();
      }
      return;
    }

    if (CLASS_SINGLETON_REGEX.test(line)) {
      stack.push({ kind: "block" });
      return;
    }

    const classMatch = line.match(CLASS_DECLARATION_REGEX);
    if (classMatch) {
      const rawName = `${classMatch[1] ?? ""}${classMatch[2]}`;
      const fullParts = buildFullParts(rawName, stack);
      const qualifiedName = fullParts.join("::");

      stack.push({ kind: "namespace", fullParts });
      entries.push({ line: index, qualifiedName });
      return;
    }

    const moduleMatch = line.match(MODULE_DECLARATION_REGEX);
    if (moduleMatch) {
      const rawName = `${moduleMatch[1] ?? ""}${moduleMatch[2]}`;
      const fullParts = buildFullParts(rawName, stack);
      stack.push({ kind: "namespace", fullParts });
      return;
    }

    if (BLOCK_START_REGEX.test(line) || DO_REGEX.test(line)) {
      stack.push({ kind: "block" });
    }
  });

  return entries;
}

function currentNamespaceParts(stack: StackEntry[]): string[] {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entry = stack[i];
    if (entry.kind === "namespace" && entry.fullParts) {
      return entry.fullParts;
    }
  }

  return [];
}

function buildFullParts(rawName: string, stack: StackEntry[]): string[] {
  const isAbsolute = rawName.startsWith("::");
  const normalized = isAbsolute ? rawName.slice(2) : rawName;
  const parts = normalized.split("::").filter(Boolean);

  if (isAbsolute) {
    return parts;
  }

  return currentNamespaceParts(stack).concat(parts);
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z0-9])/g, "$1_$2")
    .toLowerCase();
}

async function executeQuickOpen(query: string): Promise<void> {
  try {
    await vscode.commands.executeCommand(QUICK_OPEN_DEFAULT_COMMAND, query);
  } catch (error) {
    await vscode.commands.executeCommand(QUICK_OPEN_COMMAND, query);
  }
}
