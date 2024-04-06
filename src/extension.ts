import * as vscode from 'vscode';
import { parse, walk, TestContext } from 'python-ast';

function getDefaultIndentation(editor: vscode.TextEditor) {
    const { insertSpaces, tabSize } = editor.options;
    return insertSpaces ? ' '.repeat(typeof tabSize === 'number' ? tabSize : 4) : '\t';
}

function getIndentationOfSelection(editor: vscode.TextEditor): string {
    const selection = editor.selection;
    const firstLineOfSelection = editor.document.lineAt(selection.start.line).text;
    
    const match = firstLineOfSelection.match(/^(\s*)/);
    return match ? match[1] as string : '';
}

function getObjectRange(selection: vscode.Selection, document: vscode.TextDocument) {
    let text = document.getText();
    let wordRange = document.getWordRangeAtPosition(selection.start, /[\w\._]+ *\(/);

    if (!wordRange) {
        return;
    }

    let wordStartPos = document.offsetAt(wordRange.start);
    let startPos = wordStartPos;
    let openBracketsCount = 0;
    let endPos = -1;

    for (let i = startPos; i >= 0; i++) {
        if (text[i] === '(') {
            startPos = i;
            openBracketsCount = 1;
            break;
        }
        if (text[i] === '\n') {
            return;
        }
    }

    for (let i = startPos + 1; i < text.length && openBracketsCount > 0; i++) {
        if (text[i] === '(') {
            openBracketsCount++;
        } else if (text[i] === ')') {
            openBracketsCount--;
            if (openBracketsCount === 0) {
                endPos = i;
                break;
            }
        }
    }

    if (endPos !== -1) {
        let start = document.positionAt(wordStartPos);
        let end = document.positionAt(endPos + 1);
        return new vscode.Range(start, end);
    }
}

function wrapWith(
    controlName: string = "control", 
    callbackfn?: (text: string, controlName: string, indentation: string, defaultIndentation: string) => string
) {
	const editor = vscode.window.activeTextEditor;

    if (!editor) {
        return;
    }

    if (!callbackfn) {
        return;
    }
    
    const objectRange = getObjectRange(editor.selection, editor.document);
    if (!objectRange) {
        return;
    }
    const selection = new vscode.Selection(objectRange.start, objectRange.end);
    
    const defaultIndentation = getDefaultIndentation(editor);
    const indentation = getIndentationOfSelection(editor);
    const text = editor.document.getText(selection);

    const wrappedText = callbackfn(text, controlName, indentation, defaultIndentation);

    editor.edit(editBuilder => {
        editBuilder.replace(selection, wrappedText);
    });

    const startOffset = editor.document.offsetAt(selection.start);
    const endOffset = startOffset + controlName.length;
    const start = editor.document.positionAt(startOffset);
    const end = editor.document.positionAt(endOffset);
    const newSelection = new vscode.Selection(start, end);
    editor.selection = newSelection;
}

function wrapWithContent() {
    return wrapWith(
        "Control",
        (text, controlName, indentation, defaultIndentation) => 
            `${controlName}(` +
            `\n${indentation}${defaultIndentation}content=${text.replace(/\n/g, `\n${defaultIndentation}`)},` +
            `\n${indentation})`
    );
}

function wrapWithControls() {
    return wrapWith(
        "Control",
        (text, controlName, indentation, defaultIndentation) => `${controlName}(` +
            `\n${indentation}${defaultIndentation}controls=[` +
            `\n${indentation}${defaultIndentation.repeat(2)}${text.replace(/\n/g, `\n${defaultIndentation.repeat(2)}`)},` +
            `\n${indentation}${defaultIndentation}]` +
            `\n${indentation})`
    );
}

function unwrapControl() {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        vscode.window.showInformationMessage('No editor is active');
        return;
    }
    
    const objectRange = getObjectRange(editor.selection, editor.document);
    if (!objectRange) {
        return;
    }

    const selection = new vscode.Selection(objectRange.start, objectRange.end);
    const text = editor.document.getText(selection);
    const ast = parse(text);

    let defaultIndentation = getDefaultIndentation(editor);
    let argumentDepth: number | undefined;
    let contentStartIndex: number | undefined;

    walk({
        enterArgument: (ctx) => {
            if (!argumentDepth) {
                argumentDepth = ctx.depth();
            } else if (ctx.depth() !== argumentDepth) {
                return;
            }
            if (!ctx.children) {
                return;
            }
            if (ctx.children[0].text === "content" && !contentStartIndex) {
                const contentNode: any = ctx.children[2];
                contentStartIndex = contentNode.start.startIndex;
            }
            if (ctx.children[0].text === "controls" && !contentStartIndex) {
                const controlsNode: any = ctx.children[2];
                walk({
                    enterTestlist_comp: (ctx) => {
                        if (!ctx.children) {
                            return;
                        }
                        if (ctx.childCount > 2) {
                            return;
                        }
                        if (!contentStartIndex) {
                            defaultIndentation += defaultIndentation;
                            contentStartIndex = ctx.start.startIndex;
                        }
                    }
                }, controlsNode);
            }
        }
    }, ast);

    if (!contentStartIndex) {
        vscode.window.showInformationMessage('Cannot find the content.');
        return;
    }

    const contentStartOffset = editor.document.offsetAt(objectRange.start) + contentStartIndex;
    const contentStart = editor.document.positionAt(contentStartOffset);
    const contentSelection = new vscode.Selection(contentStart, contentStart);
    const contentRange = getObjectRange(contentSelection, editor.document);
    if (!contentRange) {
        return;
    }
    const contentObjectSelection = new vscode.Selection(contentRange.start, contentRange.end);

    const contentText = editor.document.getText(contentObjectSelection);
    const contentTextWithoutIndentation = contentText.replace(new RegExp(`^${defaultIndentation}`, 'gm'), '');

    editor.edit(editBuilder => {
        editBuilder.replace(selection, contentTextWithoutIndentation);
    });
}

export class WrapActionProvider implements vscode.CodeActionProvider {
    public provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection): vscode.ProviderResult<vscode.CodeAction[]> {
        
        let selection: vscode.Selection;
        if (range instanceof vscode.Range) {
            selection = new vscode.Selection(range.start, range.end);
        } else {
            selection = range;
        }

        const objectRange = getObjectRange(selection, document);
        if (!objectRange) {
            return;
        }

        return [
            {
                command: {
                    title: 'Wrap in content',
                    command: 'flet.refactor.wrap.content',
                },
                title: 'Wrap in content',
                kind: vscode.CodeActionKind.Refactor,
            },
            {
                command: {
                    title: 'Wrap in controls',
                    command: 'flet.refactor.wrap.controls',
                },
                title: 'Wrap in controls',
                kind: vscode.CodeActionKind.Refactor,
            },
            {
                command: {
                    title: 'Remove wrapper',
                    command: 'flet.refactor.unwrap',
                },
                title: 'Remove wrapper',
                kind: vscode.CodeActionKind.Refactor,
            },
        ];
    }
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
        "python", 
        new WrapActionProvider(),
        { providedCodeActionKinds: [vscode.CodeActionKind.Refactor] }
    ));

    vscode.commands.registerCommand('flet.refactor.wrap.content', wrapWithContent);

    vscode.commands.registerCommand('flet.refactor.wrap.controls', wrapWithControls);

    vscode.commands.registerCommand('flet.refactor.unwrap', unwrapControl);
}

export function deactivate() {}
