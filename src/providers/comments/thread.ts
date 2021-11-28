import {
	GerritCommentBase,
	GerritDraftComment,
} from '../../lib/gerritAPI/gerritComment';
import {
	CommentThread,
	CommentThreadCollapsibleState,
	Disposable,
} from 'vscode';
import { CommentManager, DocumentCommentManager } from '../commentProvider';
import { FileProvider } from '../fileProvider';

interface CommentThreadWithGerritComments
	extends Omit<CommentThread, 'comments'> {
	comments: readonly GerritCommentBase[];
}

/**
 * We use a bit of a fancy technique for keeping track of threads. We are not
 * allowed to store any extra properties on the VSCode CommentThread. This means
 * we need to use a custom class to keep track of the thread. To link the thread
 * to the custom class, we use the `threadId` property. Because we can't store
 * it directly on the thread, we store it in editable the `contextValue` property.
 */
export class GerritCommentThread implements Disposable {
	private static _lastThreadId: number = 0;
	private static _threadMap: Map<string, GerritCommentThread> = new Map();

	private _threadID: string;
	private _thread: CommentThreadWithGerritComments;
	private _filePath: string | undefined;

	public get lastComment(): Readonly<GerritCommentBase> | undefined {
		return this._thread.comments[this._thread.comments.length - 1];
	}

	public get comments(): ReadonlyArray<GerritCommentBase> {
		return this._thread.comments;
	}

	public get thread(): Readonly<CommentThreadWithGerritComments> {
		return this._thread;
	}

	public get resolved(): boolean {
		return !(this.lastComment?.unresolved ?? false);
	}

	public async setResolved(newValue: boolean): Promise<void> {
		if (!this.lastComment?.isDraft) {
			return;
		}

		await (this.lastComment as GerritDraftComment).setResolved(newValue);
		this.update(false);
	}

	private constructor(thread: CommentThread) {
		this._threadID = GerritCommentThread._setThreadID(thread, this);
		this._thread = thread as CommentThreadWithGerritComments;
		const meta = FileProvider.tryGetFileMeta(thread.uri);
		if (meta) {
			this._filePath = meta.filePath;
		}
	}

	private static _generateID(): number {
		return this._lastThreadId++;
	}

	private static _getThreadID(thread: CommentThread): string | null {
		const contextValue = thread.contextValue;
		if (!contextValue) {
			return null;
		}
		const [id] = contextValue.split('|');
		return id;
	}

	private static _setThreadID(
		thread: CommentThread,
		instance: GerritCommentThread
	): string {
		const id = GerritCommentThread._generateID();
		thread.contextValue = `${id}|`;
		GerritCommentThread._threadMap.set(String(id), instance);
		return String(id);
	}

	public static from(thread: CommentThread): GerritCommentThread | null {
		const id = GerritCommentThread._getThreadID(thread);
		if (id && GerritCommentThread._threadMap.has(id)) {
			return GerritCommentThread._threadMap.get(id)!;
		}
		const gthread = new GerritCommentThread(thread);
		const managers = CommentManager.getFileManagersForUri(thread.uri);
		if (managers.length === 0) {
			return null;
		}

		managers[0].registerNewThread(gthread);
		return gthread;
	}

	private _setContextValue(contextValue: string): void {
		this._thread.contextValue = `${this._threadID}|${contextValue}`;
	}

	private get _manager(): DocumentCommentManager | null {
		const meta = FileProvider.tryGetFileMeta(this._thread.uri);
		if (!meta) {
			return null;
		}
		return (
			CommentManager.getFileManagersForUri(this._thread.uri)[0] ?? null
		);
	}

	private _updateContextValues(): void {
		const contextValues: string[] = [];
		// Use yes/no here because the string "resolved" is in "unresolved"
		contextValues.push(this.resolved ? 'yesResolved' : 'noResolved');
		contextValues.push(
			!this.lastComment || this.lastComment.isDraft
				? 'yesLastCommentDraft'
				: 'nodLastCommentDaft'
		);
		this._setContextValue(contextValues.join(','));
	}

	public update(isInitial: boolean): void {
		this._updateContextValues();

		this._thread.label = 'Comment';
		if (!this.resolved) {
			this._thread.label = 'Comment (unresolved)';
		}

		this._thread.canReply = !this.lastComment || !this.lastComment?.isDraft;

		if (isInitial) {
			// If there are multiple threads on this line, expand them all.
			// VSCode is really bad at showing multiple comments on a line.
			const overrideExpand = ((): boolean => {
				if (!this._filePath || !this.lastComment) {
					return false;
				}
				const range = DocumentCommentManager.getCommentRange(
					this.lastComment
				);
				if (!range) {
					return false;
				}
				const managers = CommentManager.getFileManagersForUri(
					this.thread.uri
				);
				let threadCount: number = 0;
				managers.forEach((manager) => {
					threadCount += manager.getLineThreadCount(range.start.line);
				});
				if (threadCount > 1) {
					return true;
				}
				return false;
			})();
			this._thread.collapsibleState =
				!overrideExpand && this.resolved
					? CommentThreadCollapsibleState.Collapsed
					: CommentThreadCollapsibleState.Expanded;
		}
	}

	public setComments(
		comments: readonly GerritCommentBase[],
		isInitial: boolean = false
	): void {
		this._manager?.registerComments(this, ...comments);
		this._thread.comments = comments;
		this.update(isInitial);

		if (this._thread.comments.length === 0) {
			this._thread.dispose();
		}
	}

	public pushComment(
		comment: GerritCommentBase,
		collapseState?: CommentThreadCollapsibleState
	): void {
		this._manager?.registerComments(this, comment);
		const isInitial: boolean = this._thread.comments.length === 0;
		this._thread.comments = [...this._thread.comments, comment];
		this.update(isInitial);
		if (collapseState) {
			this._thread.collapsibleState = collapseState;
		}
	}

	public async updateComment(
		comment: GerritCommentBase,
		updater: (comment: GerritCommentBase) => void | Promise<void>
	): Promise<void> {
		this.setComments(
			await Promise.all(
				this._thread.comments.map(async (c) => {
					if (c.id === comment.id) {
						await updater(c);
					}
					return c;
				})
			)
		);
	}

	public removeComment(comment: GerritCommentBase): void {
		this.setComments(
			this._thread.comments.filter((c) => {
				if (c.id === comment.id) {
					return false;
				}
				return true;
			})
		);
	}

	public collapse(): void {
		this._thread.collapsibleState = CommentThreadCollapsibleState.Collapsed;
	}

	public expand(): void {
		this._thread.collapsibleState = CommentThreadCollapsibleState.Expanded;
	}

	/**
	 * Sets comments with themselves. This triggers the VSCode set
	 * listener, which will update the thread.
	 */
	public refreshComments(): void {
		this.setComments(this.comments);
	}

	public dispose(): void {
		GerritCommentThread._threadMap.delete(this._threadID);
		this._thread.dispose();
	}
}
