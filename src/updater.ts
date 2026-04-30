import { Notice, Plugin, requestUrl, normalizePath } from 'obsidian';

/**
 * GitLab/GitHub 기반 플러그인 자체 업데이트 모듈
 *
 * 동작 흐름 (GitHub):
 * 1. GitHub Releases API로 최신 릴리즈 조회 (캐시 없음, 에셋 URL 포함)
 * 2. API 실패 시 (rate limit/릴리즈 없음) raw.githubusercontent.com에서 manifest.json fallback
 * 3. 로컬 버전과 비교 → 릴리즈 에셋이 있을 때만 업데이트 제안
 * 4. 사용자 수락 시 릴리즈 에셋(main.js, manifest.json, styles.css) 다운로드
 * 5. 자동으로 옵시디언 새로고침
 */

interface UpdateConfig {
	gitlabUrl: string;
	projectId: string;
	accessToken: string;
	branch: string;
}



/**
 * SemVer 비교 함수
 * @returns 양수: a > b, 음수: a < b, 0: 같음
 */
function compareSemVer(a: string, b: string): number {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = pa[i] || 0;
		const nb = pb[i] || 0;
		if (na !== nb) return na - nb;
	}
	return 0;
}

/**
 * GitHub 저장소 URL에서 owner/repo 추출
 */
function parseGitHubRepo(url: string): string {
	const match = url.match(/github\.com\/([^\/]+\/[^\/]+)/);
	const repo = match?.[1]?.replace(/\/$/, '') ?? '';
	if (!repo) throw new Error('GitHub 저장소 경로를 파싱할 수 없습니다.');
	return repo;
}

// ─── GitHub 업데이트 체크 ──────────────────────────────────

/**
 * GitHub에서 최신 버전을 확인합니다.
 * 1차: Releases API (캐시 없음, 에셋 URL 포함)
 * 2차: raw.githubusercontent.com에서 manifest.json (fallback)
 */
async function checkGitHubUpdate(plugin: Plugin, config: UpdateConfig): Promise<void> {
	const repoFullName = parseGitHubRepo(config.gitlabUrl);

	const headers: Record<string, string> = {};
	if (config.accessToken) {
		headers['Authorization'] = `Bearer ${config.accessToken}`;
	}

	let remoteVersion: string;

	try {
		// 원본 저장소 브랜치의 manifest.json을 가져와 버전을 확인합니다.
		const manifestUrl = `https://raw.githubusercontent.com/${repoFullName}/${config.branch}/manifest.json`;
		const response = await requestUrl({ url: manifestUrl, headers });
		const manifest = JSON.parse(response.text);
		remoteVersion = manifest.version;
	} catch (e) {
		console.warn('[Updater] 저장소의 manifest.json을 가져올 수 없습니다. 브랜치명이나 접근 권한을 확인해주세요.', e);
		return;
	}

	const localVersion = plugin.manifest.version;
	console.log(`[Updater] 로컬 버전: v${localVersion}, 원격 버전: v${remoteVersion}`);

	if (compareSemVer(remoteVersion, localVersion) > 0) {
		// 즉시 다운로드 및 자동 업데이트 진행
		new Notice(`🚀 플러그인 새 버전(v${remoteVersion}) 다운로드 중...`);
		try {
			await performGitHubUpdate(plugin, repoFullName);
			new Notice('✅ 업데이트 완료! 옵시디언을 새로고침합니다...', 3000);
			window.setTimeout(() => {
				(plugin.app as any).commands.executeCommandById('app:reload');
			}, 1500);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes('404')) {
				new Notice(`🔄 새 버전(v${remoteVersion})이 감지되었지만, 아직 GitHub Release가 생성되지 않았습니다.\n(배포 액션 완료 후 다시 시도해주세요)`, 8000);
			} else {
				new Notice(`❌ 업데이트 실패: ${msg}`);
				console.error('[Updater] 업데이트 실패:', e);
			}
		}
	} else {
		console.log('[Updater] 최신 버전입니다.');
	}
}

/**
 * GitHub Release 에셋에서 파일을 다운로드하여 업데이트를 수행합니다.
 */
async function performGitHubUpdate(plugin: Plugin, repoFullName: string): Promise<void> {
	const pluginDir = plugin.manifest.dir;
	if (!pluginDir) {
		throw new Error('플러그인 디렉토리를 찾을 수 없습니다.');
	}

	const filesToUpdate = ['main.js', 'manifest.json', 'styles.css'];
	let updatedCount = 0;

	for (const fileName of filesToUpdate) {
		const downloadUrl = `https://github.com/${repoFullName}/releases/latest/download/${fileName}`;
		try {
			const response = await requestUrl({ url: downloadUrl });
			const filePath = normalizePath(`${pluginDir}/${fileName}`);
			await plugin.app.vault.adapter.write(filePath, response.text);
			updatedCount++;
			console.log(`[Updater] ${fileName} 업데이트 완료`);
		} catch (e) {
			if (fileName === 'styles.css') {
				console.log(`[Updater] ${fileName} 파일이 릴리즈에 없습니다 (정상).`);
			} else {
				throw new Error(`${fileName} 다운로드 실패: ${e}`);
			}
		}
	}

	console.log(`[Updater] 총 ${updatedCount}개 파일 업데이트 완료`);
}

// ─── GitLab 업데이트 체크 ──────────────────────────────────

/**
 * GitLab API를 사용하여 manifest.json을 확인합니다.
 */
async function checkGitLabUpdate(plugin: Plugin, config: UpdateConfig): Promise<void> {
	const baseUrl = config.gitlabUrl.replace(/\/+$/, '');

	const headers: Record<string, string> = {};
	if (config.accessToken) {
		headers['PRIVATE-TOKEN'] = config.accessToken;
	}

	const encodedPath = encodeURIComponent('manifest.json');
	const url = `${baseUrl}/api/v4/projects/${config.projectId}/repository/files/${encodedPath}/raw?ref=${config.branch}`;

	const response = await requestUrl({ url, headers });
	const remoteManifest = JSON.parse(response.text);

	const localVersion = plugin.manifest.version;
	const remoteVersion = remoteManifest.version;

	console.log(`[Updater] 로컬 버전: v${localVersion}, 원격 버전: v${remoteVersion}`);

	if (compareSemVer(remoteVersion, localVersion) > 0) {
		// 즉시 다운로드 및 자동 업데이트 진행
		new Notice(`🚀 플러그인 새 버전(v${remoteVersion}) 다운로드 중...`);
		try {
			await performGitLabUpdate(plugin, config);
			new Notice('✅ 업데이트 완료! 옵시디언을 새로고침합니다...', 3000);
			window.setTimeout(() => {
				(plugin.app as any).commands.executeCommandById('app:reload');
			}, 1500);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`❌ 업데이트 실패: ${msg}`);
			console.error('[Updater] 업데이트 실패:', e);
		}
	} else {
		console.log('[Updater] 최신 버전입니다.');
	}
}

/**
 * GitLab에서 파일을 다운로드하여 업데이트를 수행합니다.
 */
async function performGitLabUpdate(plugin: Plugin, config: UpdateConfig): Promise<void> {
	const pluginDir = plugin.manifest.dir;
	if (!pluginDir) {
		throw new Error('플러그인 디렉토리를 찾을 수 없습니다.');
	}

	const baseUrl = config.gitlabUrl.replace(/\/+$/, '');
	const headers: Record<string, string> = {};
	if (config.accessToken) {
		headers['PRIVATE-TOKEN'] = config.accessToken;
	}

	const filesToUpdate = ['main.js', 'manifest.json', 'styles.css'];
	let updatedCount = 0;

	for (const fileName of filesToUpdate) {
		try {
			const encodedPath = encodeURIComponent(fileName);
			const url = `${baseUrl}/api/v4/projects/${config.projectId}/repository/files/${encodedPath}/raw?ref=${config.branch}`;
			const response = await requestUrl({ url, headers });
			const filePath = normalizePath(`${pluginDir}/${fileName}`);
			await plugin.app.vault.adapter.write(filePath, response.text);
			updatedCount++;
			console.log(`[Updater] ${fileName} 업데이트 완료`);
		} catch (e) {
			if (fileName === 'styles.css') {
				console.log(`[Updater] ${fileName} 파일이 원격에 없습니다 (정상).`);
			} else {
				throw new Error(`${fileName} 다운로드 실패: ${e}`);
			}
		}
	}

	console.log(`[Updater] 총 ${updatedCount}개 파일 업데이트 완료`);
}

// ─── 공통 진입점 ──────────────────────────────────────────

/**
 * 플러그인 업데이트 체크를 수행합니다.
 * 설정이 누락되어 있으면 조용히 스킵합니다.
 */
export async function checkForPluginUpdate(plugin: Plugin, config: UpdateConfig): Promise<void> {
	if (!config.gitlabUrl) {
		console.log('[Updater] 저장소 URL 설정이 비어 있어 업데이트 체크를 건너뜁니다.');
		return;
	}

	try {
		const baseUrl = config.gitlabUrl.replace(/\/+$/, '');

		if (baseUrl.includes('github.com')) {
			await checkGitHubUpdate(plugin, config);
		} else {
			await checkGitLabUpdate(plugin, config);
		}
	} catch (e) {
		// 네트워크 오류 등은 조용히 로그만 남김
		console.log('[Updater] 업데이트 체크를 건너뜁니다:', e instanceof Error ? e.message : String(e));
	}
}


