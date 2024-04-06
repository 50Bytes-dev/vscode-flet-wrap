import * as vscode from 'vscode';
import { parse, walk } from 'python-ast';
import { ErrorNode } from 'antlr4ts/tree/ErrorNode';

type CallbackFn = (text: string, controlName: string, indentation: string, defaultIndentation: string, textComma: string, endComma: string) => string;

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

function checkText(text: string) {
    const ast = parse(text);
    let argumentDepth: number | undefined;
    let correctText = true;
    let nodeCount = 0;

    walk({
        enterAtom_expr: (ctx) => {
            if (!argumentDepth) {
                argumentDepth = ctx.depth();
            } else if (ctx.depth() !== argumentDepth) {
                return;
            }
            if (ctx.childCount === 1) {
                correctText = false;
            }
            if (ctx.childCount === 2) {
                const lastChild: any = ctx.children![1];
                const lastChildNode = lastChild.children[lastChild.childCount - 1];
                if (lastChildNode.text === '(') {
                    correctText = false;
                }
                if (lastChildNode instanceof ErrorNode) {
                    correctText = false;
                }
            }
            nodeCount++;
        },
    }, ast);

    return {
        nodeCount,
        correctText,
    };
}

function getObjectRange(selection: vscode.Selection, document: vscode.TextDocument): vscode.Range | undefined {
    let text = document.getText(selection);
    if (text !== '') {
        const { nodeCount, correctText } = checkText(text);
        if (nodeCount > 1) {
            if (!correctText) {
                return;
            } else {
                return new vscode.Range(selection.start, selection.end);
            }
        }
    }

    text = document.getText();
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
    callbackfn?: CallbackFn,
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
    const textComma = text.endsWith(',') ? '' : ',';
    const endComma = textComma ? '' : ',';

    const wrappedText = callbackfn(text, controlName, indentation, defaultIndentation, textComma, endComma);

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
        (text, controlName, indentation, defaultIndentation, textComma, endComma) => {
            return `${controlName}(` +
                `\n${indentation}${defaultIndentation}content=${text.replace(/\n/g, `\n${defaultIndentation}`)}${textComma}` +
                `\n${indentation})${endComma}`;
        },
    );
}

function wrapWithControls() {
    return wrapWith(
        "Control",
        (text, controlName, indentation, defaultIndentation, textComma, endComma) => {
            return `${controlName}(` +
                `\n${indentation}${defaultIndentation}controls=[` +
                `\n${indentation}${defaultIndentation.repeat(2)}${text.replace(/\n/g, `\n${defaultIndentation.repeat(2)}`)}${textComma}` +
                `\n${indentation}${defaultIndentation}]` +
                `\n${indentation})${endComma}`;
        },
    );
}

function getContentStartIndex(text: string) {
    const ast = parse(text);
    let isContent = false;
    let isControls = false;
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
                isContent = true;
                const contentNode: any = ctx.children[2];
                contentStartIndex = contentNode.start.startIndex;
            }
            if (ctx.children[0].text === "controls" && !contentStartIndex) {
                isControls = true;
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
                            contentStartIndex = ctx.start.startIndex;
                        }
                    }
                }, controlsNode);
            }
        }
    }, ast);

    return { contentStartIndex, isContent, isControls };
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

    let defaultIndentation = getDefaultIndentation(editor);
    
    const { contentStartIndex, isContent, isControls } = getContentStartIndex(text);
    
    if (contentStartIndex === undefined) {
        return;
    }

    if (isControls) {
        defaultIndentation += defaultIndentation;
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

        const text = document.getText(objectRange);
        const { nodeCount } = checkText(text);
        const { contentStartIndex } = getContentStartIndex(text);

        return [
            nodeCount === 1 && {
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
            (nodeCount === 1 && contentStartIndex !== undefined) && {
                command: {
                    title: 'Remove wrapper',
                    command: 'flet.refactor.unwrap',
                },
                title: 'Remove wrapper',
                kind: vscode.CodeActionKind.Refactor,
            },
        ].filter(Boolean) as vscode.ProviderResult<vscode.CodeAction[]>;
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

export function deactivate() { }
