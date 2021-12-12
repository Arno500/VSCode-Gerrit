import { Uri, workspace } from 'vscode';
import { log } from '../util/log';

interface OptionalGitReviewProperties {
	port?: string;
	branch?: string;
	remote?: string;
	defaultbranch?: string;
	defaultremote?: string;
}

interface GitReviewFile extends OptionalGitReviewProperties {
	host: string;
	project: string;
}

export const DEFAULT_GIT_REVIEW_FILE: Required<OptionalGitReviewProperties> = {
	branch: 'master',
	defaultbranch: 'master',
	defaultremote: 'origin',
	remote: 'origin',
	port: '29418',
};

function parseGerritFile(fileContent: string): GitReviewFile | null {
	if (!fileContent.includes('[gerrit]')) {
		// This header should be in there
		return null;
	}

	const file: Partial<GitReviewFile> = {};
	for (const line of fileContent.split('\n')) {
		if (!line.includes('=')) {
			continue;
		}

		const [key, value] = line.split('=');
		const typedKey = key as keyof GitReviewFile;
		file[typedKey] = value.trim();
	}

	if (!file.host || !file.project) {
		log(
			'Found a `.gitreview` file but it did not contain a host and project which are required'
		);
		return null;
	}

	return file as GitReviewFile;
}

let gitReviewFile: GitReviewFile | null = null;
export async function getGitReviewFile(): Promise<GitReviewFile | null> {
	for (const folder of workspace.workspaceFolders || []) {
		const fileContent = await (async (): Promise<string | null> => {
			try {
				return Buffer.from(
					await workspace.fs.readFile(
						Uri.joinPath(folder.uri, '.gitreview')
					)
				).toString('utf8');
			} catch (e) {
				return null;
			}
		})();
		if (!fileContent) {
			continue;
		}

		const parsed = parseGerritFile(fileContent);
		if (parsed) {
			return parsed;
		}
	}
	return null;
}

export async function getGitReviewFileCached(): Promise<GitReviewFile | null> {
	if (gitReviewFile) {
		return gitReviewFile;
	}
	return (gitReviewFile = await getGitReviewFile());
}
