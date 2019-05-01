// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../common/extensions';

import { inject, injectable } from 'inversify';
import * as monacoEditor from 'monaco-editor/esm/vs/editor/editor.api';
import * as path from 'path';
import * as uuid from 'uuid/v4';
import {
    CancellationToken,
    CancellationTokenSource,
    EndOfLine,
    Event,
    EventEmitter,
    Position,
    Range,
    TextDocument,
    TextDocumentContentChangeEvent,
    TextLine,
    Uri
} from 'vscode';
import {
    CompletionItem,
    CompletionList,
    CompletionRequest,
    DidChangeTextDocumentNotification,
    DidOpenTextDocumentNotification,
    LanguageClient,
    TextDocumentItem,
    VersionedTextDocumentIdentifier
} from 'vscode-languageclient';

import { ILanguageServer, ILanguageServerAnalysisOptions } from '../../activation/types';
import { IWorkspaceService } from '../../common/application/types';
import { PYTHON_LANGUAGE } from '../../common/constants';
import { traceInfo } from '../../common/logger';
import { IFileSystem, TemporaryFile } from '../../common/platform/types';
import { createDeferred, Deferred } from '../../common/utils/async';
import { Identifiers } from '../constants';
import { IHistoryListener } from '../types';
import {
    HistoryMessages,
    ICancelCompletionItemsRequest,
    IEditCell,
    IHistoryMapping,
    IProvideCompletionItemsRequest,
    IRemoteAddCode
} from './historyTypes';

class HistoryLine implements TextLine {

    private _range : Range;
    private _rangeWithLineBreak: Range;
    private _firstNonWhitespaceIndex : number | undefined;
    private _isEmpty : boolean | undefined;

    constructor(private _contents: string, private _line: number, private _offset: number) {
        this._range = new Range(new Position(_line, 0), new Position(_line, _contents.length));
        this._rangeWithLineBreak = new Range(this.range.start, new Position(_line, _contents.length + 1));
    }

    public get offset() : number {
        return this._offset;
    }
    public get lineNumber(): number {
        return this._line;
    }
    public get text(): string {
        return this._contents;
    }
    public get range(): Range {
        return this._range;
    }
    public get rangeIncludingLineBreak(): Range {
        return this._rangeWithLineBreak;
    }
    public get firstNonWhitespaceCharacterIndex(): number {
        if (this._firstNonWhitespaceIndex === undefined) {
            this._firstNonWhitespaceIndex = this._contents.trimLeft().length - this._contents.length;
        }
        return this._firstNonWhitespaceIndex;
    }
    public get isEmptyOrWhitespace(): boolean {
        if (this._isEmpty === undefined) {
            this._isEmpty = this._contents.length === 0 || this._contents.trim().length === 0;
        }
        return this._isEmpty;
    }

}

class HistoryDocument implements TextDocument {

    private _uri : Uri;
    private _version : number = 0;
    private _lines: HistoryLine[] = [];
    private _contents: string = '';
    private _editOffset: number = 0;
    private _firstEdit: boolean = true;

    constructor(fileName: string) {
        // The file passed in is the base Uri for where we're basing this
        // document.
        //
        // What about liveshare?
        this._uri = Uri.file(fileName);
    }

    public get uri(): Uri {
        return this._uri;
    }
    public get fileName(): string {
        return this._uri.fsPath;
    }

    public get isUntitled(): boolean {
        return true;
    }
    public get languageId(): string {
        return PYTHON_LANGUAGE;
    }
    public get version(): number {
        return this._version;
    }
    public get isDirty(): boolean {
        return true;
    }
    public get isClosed(): boolean {
        return false;
    }
    public save(): Thenable<boolean> {
        return Promise.resolve(true);
    }
    public get eol(): EndOfLine {
        return EndOfLine.LF;
    }
    public get lineCount(): number {
        return this._lines.length;
    }
    public lineAt(position: Position | number): TextLine {
        if (typeof position === 'number') {
            return this._lines[position as number];
        } else {
            return this._lines[position.line];
        }
    }
    public offsetAt(_position: Position): number {
        throw new Error('Method not implemented.');
    }
    public positionAt(offset: number): Position {
        const before = this._contents.slice(0, offset);
        const newLines = before.match(/\n/g);
        const line = newLines ? newLines.length : 0;
        const preCharacters = before.match(/(\n|^).*$/g);
        return new Position(line, preCharacters ? preCharacters[0].length : 0);
    }
    public getText(range?: Range | undefined): string {
        if (!range) {
            return this._contents;
        } else {
            const startOffset = this.convertToOffset(range.start);
            const endOffset = this.convertToOffset(range.end);
            return this._contents.substr(startOffset, endOffset - startOffset);
        }
    }
    public getWordRangeAtPosition(_position: Position, _regex?: RegExp | undefined): Range | undefined {
        throw new Error('Method not implemented.');
    }
    public validateRange(range: Range): Range {
        return range;
    }
    public validatePosition(position: Position): Position {
        return position;
    }

    public get textDocumentItem() : TextDocumentItem {
        return {
            uri : this._uri.toString(),
            languageId: this.languageId,
            version: this.version,
            text: this.getText()
        };
    }

    public get textDocumentId() : VersionedTextDocumentIdentifier {
        return {
            uri: this._uri.toString(),
            version: this.version
        };
    }
    public addLines(code: string): TextDocumentContentChangeEvent[] {
        this._version += 1;
        const normalized = code.replace(/\r/g, '');
        const newCode = this._contents.length ? `\n${normalized}` : normalized;
        const fromOffset = this._firstEdit ? this._editOffset : this._editOffset - 1;
        const before = this._contents.substr(0, fromOffset);
        const after = this._contents.substr(fromOffset);
        const fromPosition = this.computePosition(fromOffset);
        this._contents = `${before}${newCode}${after}`;
        this._lines = this.createLines();
        this._editOffset += newCode.length;

        return [
            {
                range: this.createSerializableRange(fromPosition, fromPosition),
                rangeOffset: fromOffset,
                rangeLength: 0, // Adds are always zero
                text: newCode
            }
        ];
    }

    public editLines(editorChanges: monacoEditor.editor.IModelContentChange[]): TextDocumentContentChangeEvent[] {
        this._version += 1;

        // Convert the range to local (and remove 1 based)
        if (editorChanges && editorChanges.length) {
            const normalized = editorChanges[0].text.replace(/\r/g, '');

            // Special case. If this is our first edit, update our edit offset and
            // add a newline on the front of whatever was typed.
            if (this._firstEdit) {
                this._firstEdit = false;
                const fromOffset = this._editOffset;
                const newText = `\n${normalized}`;
                this._editOffset += 1;
                this._contents += newText;
                this._lines = this.createLines();
                return [
                    {
                        range: this.createSerializableRange(this.computePosition(fromOffset), this.computePosition(fromOffset + newText.length)),
                        rangeOffset: fromOffset,
                        rangeLength: editorChanges[0].rangeLength,
                        text: newText
                    }
                ];
            } else {
                // Otherwise offset by the editOffset
                const editPos = this.computePosition(this._editOffset);
                const from = new Position(editPos.line + editorChanges[0].range.startLineNumber - 1, editorChanges[0].range.startColumn - 1);
                const to = new Position(editPos.line + editorChanges[0].range.endLineNumber - 1, editorChanges[0].range.endColumn - 1);
                const fromOffset = this.convertToOffset(from);
                const toOffset = this.convertToOffset(to);

                // Recreate our contents, and then recompute all of our lines
                const before = this._contents.substr(0, fromOffset);
                const after = this._contents.substr(toOffset);
                this._contents = `${before}${normalized}${after}`;
                this._lines = this.createLines();

                return [
                    {
                         range: this.createSerializableRange(from, to),
                         rangeOffset: fromOffset,
                         rangeLength: toOffset - fromOffset,
                         text: normalized
                    }
                ];
            }
        }

        return [];
    }

    public convertToDocumentPosition(line: number, ch: number) : Position {
        // Monaco is 1 based, and we need to add in our cell offset.
        const editLine = this.computePosition(this._editOffset);
        const docLine = line - 1 + editLine.line;
        const docCh = ch - 1;
        return new Position(docLine, docCh);
    }

    private computePosition(offset: number) : Position {
        let line = 0;
        let ch = 0;
        while (line + 1 < this._lines.length && this._lines[line + 1].offset <= offset) {
            line += 1;
        }
        if (line < this._lines.length) {
            ch = offset - this._lines[line].offset;
        }
        return new Position(line, ch);
    }

    private createLines() : HistoryLine[] {
        const split = this._contents.splitLines({trim: false, removeEmptyEntries: false});
        let prevLine: HistoryLine | undefined;
        return split.map((s, i) => {
            const nextLine = this.createTextLine(s, i, prevLine);
            prevLine = nextLine;
            return nextLine;
        });
    }

    private createTextLine(line: string, index: number, prevLine: HistoryLine | undefined) : HistoryLine {
        return new HistoryLine(line, index, prevLine ? prevLine.offset + prevLine.rangeIncludingLineBreak.end.character : 0);
    }

    private convertToOffset(pos: Position) : number {
        if (pos.line < this._lines.length) {
            return this._lines[pos.line].offset + pos.character;
        }
        return this._contents.length;
    }

    private createSerializableRange(start: Position, end: Position) : Range {
        const result = {
            start: {
                line: start.line,
                character: start.character
            },
            end: {
                line: end.line,
                character: end.character
            }
        };
        return result as Range;
    }
}

// tslint:disable:no-any
@injectable()
export class CompletionProvider implements IHistoryListener {

    private languageClientPromise : Deferred<LanguageClient> | undefined;
    private document: HistoryDocument | undefined;
    private temporaryFile: TemporaryFile | undefined;
    private sentOpenDocument : boolean = false;
    private postEmitter: EventEmitter<{message: string; payload: any}> = new EventEmitter<{message: string; payload: any}>();
    private cancellationSources : { [key: string] : CancellationTokenSource } = {};

    constructor(
        @inject(ILanguageServer) private languageServer: ILanguageServer,
        @inject(ILanguageServerAnalysisOptions) private readonly analysisOptions: ILanguageServerAnalysisOptions,
        @inject(IWorkspaceService) private workspaceService: IWorkspaceService,
        @inject(IFileSystem) private fileSystem: IFileSystem
    ) {
    }

    public dispose() {
        // Actually don't dispose here. The extension does this elsewhere.
        // this.languageServer.dispose();
    }

    public get postMessage(): Event<{message: string; payload: any}> {
        return this.postEmitter.event;
    }

    public onMessage(message: string, payload?: any) {
        switch (message) {
            case HistoryMessages.CancelCompletionItemsRequest:
                this.dispatchMessage(message, payload, this.handleCompletionItemsCancel);
                break;

            case HistoryMessages.ProvideCompletionItemsRequest:
                this.dispatchMessage(message, payload, this.handleCompletionItemsRequest);
                break;

            case HistoryMessages.EditCell:
                this.dispatchMessage(message, payload, this.editCell);
                break;

            case HistoryMessages.RemoteAddCode: // Might want to rethink this. Seems weird.
                this.dispatchMessage(message, payload, this.addCell);
                break;

            default:
                break;
        }
    }

    private dispatchMessage<M extends IHistoryMapping, T extends keyof M>(_message: T, payload: any, handler: (args : M[T]) => void) {
        const args = payload as M[T];
        handler.bind(this)(args);
    }

    private postResponse<M extends IHistoryMapping, T extends keyof M>(type: T, payload?: M[T]) : void {
        this.postEmitter.fire({message: type.toString(), payload});
    }

    private handleCompletionItemsCancel(request: ICancelCompletionItemsRequest) {
        const cancelSource = this.cancellationSources[request.id];
        if (cancelSource) {
            cancelSource.cancel();
            cancelSource.dispose();
        }
    }

    private handleCompletionItemsRequest(request: IProvideCompletionItemsRequest) {
        const cancelSource = new CancellationTokenSource();
        this.cancellationSources[request.id] = cancelSource;
        this.provideCompletionItems(request.position, request.context, cancelSource.token).then(list => {
             this.postResponse(HistoryMessages.ProvideCompletionItemsResponse, {list, id: request.id});
        }).catch(_e => {
            this.postResponse(HistoryMessages.ProvideCompletionItemsResponse, {list: { suggestions: [], incomplete: true }, id: request.id});
        });
    }

    private getLanguageClient(file?: Uri) : Promise<LanguageClient> {
        if (!this.languageClientPromise) {
            this.languageClientPromise = createDeferred<LanguageClient>();
            this.startup(file)
                .then(() => {
                    this.languageClientPromise!.resolve(this.languageServer.languageClient);
                })
                .catch((e: any) => {
                    this.languageClientPromise!.reject(e);
                });
        }
        return this.languageClientPromise.promise;
    }

    private async startup(resource?: Uri) : Promise<void> {
        // Save our language client. We'll use this to talk to the language server
        const options = await this.analysisOptions!.getAnalysisOptions();
        await this.languageServer.start(resource, options);

        // Create our dummy document. Compute a file path for it.
        let dummyFilePath = '';
        if (this.workspaceService.rootPath || resource) {
            const dir = resource ? path.dirname(resource.fsPath) : this.workspaceService.rootPath!;
            dummyFilePath = path.join(dir, `History_${uuid().replace(/-/g, '')}.py`);
        } else {
            this.temporaryFile = await this.fileSystem.createTemporaryFile('.py');
            dummyFilePath = this.temporaryFile.filePath;
        }
        this.document = new HistoryDocument(dummyFilePath);
    }

    private async provideCompletionItems(position: monacoEditor.Position, context: monacoEditor.languages.CompletionContext, token: CancellationToken) : Promise<monacoEditor.languages.CompletionList> {
        const languageClient = await this.getLanguageClient();
        if (languageClient && this.document) {
            const docPos = this.document.convertToDocumentPosition(position.lineNumber, position.column);
            const result = await languageClient.sendRequest(
                CompletionRequest.type,
                languageClient.code2ProtocolConverter.asCompletionParams(this.document, docPos, context),
                token);
            return this.convertToMonacoCompletionList(result);
        }

        return {
            suggestions: [],
            incomplete: true
        };
    }
    private async addCell(request: IRemoteAddCode): Promise<void> {
        traceInfo(`history completionProvider - addCell : ${JSON.stringify(request)}`);

        // Broadcast an update to the language server
        const languageClient = await this.getLanguageClient(request.file === Identifiers.EmptyFileName ? undefined : Uri.file(request.file));

        let changes: TextDocumentContentChangeEvent[] = [];
        if (this.document) {
            changes = this.document.addLines(request.code);
        }

        if (languageClient && this.document) {
            if (!this.sentOpenDocument) {
                this.sentOpenDocument = true;
                return languageClient.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: this.document.textDocumentItem });
            } else {
                return languageClient.sendNotification(DidChangeTextDocumentNotification.type, { textDocument: this.document.textDocumentId, contentChanges: changes });
            }
        }
    }
    private async editCell(request: IEditCell): Promise<void> {
        traceInfo(`history completionProvider - editCell : ${JSON.stringify(request)}`);

        // Need the language client first. It will create the document on startup
        const languageClient = await this.getLanguageClient();

        let changes: TextDocumentContentChangeEvent[] = [];
        if (this.document) {
            changes = this.document.editLines(request.changes);
        }

        // Broadcast an update to the language server
        if (languageClient && this.document) {
            if (!this.sentOpenDocument) {
                this.sentOpenDocument = true;
                return languageClient.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: this.document.textDocumentItem });
            } else {
                return languageClient.sendNotification(DidChangeTextDocumentNotification.type, { textDocument: this.document.textDocumentId, contentChanges: changes });
            }
        }
    }

    private convertToMonacoCompletionItem(item: CompletionItem) : monacoEditor.languages.CompletionItem {
        // They should be pretty much identical? Except for ranges.
        // tslint:disable-next-line: no-any
        return (item as any) as monacoEditor.languages.CompletionItem;
    }

    private convertToMonacoCompletionList(result: CompletionList | CompletionItem[] | null) : monacoEditor.languages.CompletionList {
        if (result) {
            if (result.hasOwnProperty('isIncomplete')) {
                const list = result as CompletionList;
                return {
                    suggestions: list.items.map(this.convertToMonacoCompletionItem),
                    incomplete: list.isIncomplete
                };
            } else {
                const array = result as CompletionItem[];
                return {
                    suggestions: array.map(this.convertToMonacoCompletionItem),
                    incomplete: false
                };
            }
        }

        return {
            suggestions: [],
            incomplete: true
        };
    }
}
