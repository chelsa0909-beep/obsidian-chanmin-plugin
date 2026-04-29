import { App, Modal, Notice, Plugin, requestUrl, normalizePath } from 'obsidian';

/**
 * GitLab/GitHub 기반 플러그인 자체 업데이트 모듈
 *
 * 동작 흐름:
 * 1. GitHub: Releases API로 최신 릴리즈를 조회 (캐시 문제 없음)
 *    GitLab: API로 manifest.json 조회
 * 2. 로컬 manifest.version과 비교
 * 3. 원격 버전이 높으면 업데이트 알림 모달 표시
 * 4. 사용자 수락 시 릴리즈 에셋(main.js, manifest.json, styles.css)을 다운로드하여 덮어쓰기
 * 5. 자동으로 옵시디언 새로고침
 */

interface UpdateConfig {
	gitlabUrl: string;
	projectId: string;
	accessToken: string;
	branch: string;
}

/** GitHub Release 에셋 정보 */
interface ReleaseAsset {
	name: string;
	browser_download_url: string;
}

/** 업데이트 정보 (GitHub/GitLab 공통) */
interface UpdateInfo {
	remoteVersion: string;
	assets?: ReleaseAsset[];  // GitHub Release 에셋 (GitHub 전용)
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
 * GitHub Releases API를 사용하여 최신 릴리즈를 확인합니다.
 * CDN 캐시 문제가 없고, 릴리즈 에셋 URL도 함께 가져옵니다.
 */
async function checkGitHubUpdate(plugin: Plugin, config: UpdateConfig): Promise<void> {
	const repoFullName = parseGitHubRepo(config.gitlabUrl);

	const headers: Record<string, string> = {
		'Accept': 'application/vnd.github+json',
	};
	if (config.accessToken) {
		headers['Authorization'] = `Bearer ${config.accessToken}`;
	}

	// GitHub Releases API - 최신 릴리즈 조회
	const apiUrl = `https://api.github.com/repos/${repoFullName}/releases/latest`;
	const response = await requestUrl({ url: apiUrl, headers });
	const release = JSON.parse(response.text);

	// 릴리즈 태그명이 버전 (예: "1.5.0")
	const remoteVersion = release.tag_name.replace(/^v/, ''); // "v1.5.0" → "1.5.0"
	const localVersion = plugin.manifest.version;
	const assets: ReleaseAsset[] = release.assets ?? [];

	console.log(`[Updater] 로컬 버전: v${localVersion}, 원격 릴리즈 버전: v${remoteVersion}`);

	if (compareSemVer(remoteVersion, localVersion) > 0) {
		new UpdateConfirmModal(plugin.app, plugin, config, localVersion, remoteVersion, assets).open();
	} else {
		console.log('[Updater] 최신 버전입니다.');
	}
}

/**
 * GitHub Release 에셋에서 파일을 다운로드하여 업데이트를 수행합니다.
 */
async function performGitHubUpdate(plugin: Plugin, assets: ReleaseAsset[]): Promise<void> {
	const pluginDir = plugin.manifest.dir;
	if (!pluginDir) {
		throw new Error('플러그인 디렉토리를 찾을 수 없습니다.');
	}

	const filesToUpdate = ['main.js', 'manifest.json', 'styles.css'];
	let updatedCount = 0;

	for (const fileName of filesToUpdate) {
		const asset = assets.find(a => a.name === fileName);
		if (!asset) {
			if (fileName === 'styles.css') {
				console.log(`[Updater] ${fileName}: 릴리즈에 포함되지 않음 (정상)`);
				continue;
			}
			throw new Error(`${fileName} 파일이 릴리즈에 포함되어 있지 않습니다.`);
		}

		try {
			const response = await requestUrl({ url: asset.browser_download_url });
			const filePath = normalizePath(`${pluginDir}/${fileName}`);
			await plugin.app.vault.adapter.write(filePath, response.text);
			updatedCount++;
			console.log(`[Updater] ${fileName} 업데이트 완료`);
		} catch (e) {
			if (fileName === 'styles.css') {
				console.log(`[Updater] ${fileName} 다운로드 실패 (무시)`);
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
		new UpdateConfirmModal(plugin.app, plugin, config, localVersion, remoteVersion).open();
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
		// 네트워크 오류, 릴리즈 없음 등은 조용히 로그만 남김
		console.warn('[Updater] 업데이트 체크 실패:', e);
	}
}

// ─── 업데이트 확인 모달 ──────────────────────────────────

/**
 * 새 버전이 감지되었을 때 사용자에게 업데이트 여부를 묻는 모달입니다.
 */
class UpdateConfirmModal extends Modal {
	plugin: Plugin;
	config: UpdateConfig;
	localVersion: string;
	remoteVersion: string;
	assets?: ReleaseAsset[];

	constructor(app: App, plugin: Plugin, config: UpdateConfig, localVersion: string, remoteVersion: string, assets?: ReleaseAsset[]) {
		super(app);
		this.plugin = plugin;
		this.config = config;
		this.localVersion = localVersion;
		this.remoteVersion = remoteVersion;
		this.assets = assets;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: '🔄 플러그인 업데이트 알림' });

		const infoContainer = contentEl.createDiv();
		infoContainer.style.padding = '15px';
		infoContainer.style.marginBottom = '15px';
		infoContainer.style.border = '1px solid var(--background-modifier-border)';
		infoContainer.style.borderRadius = '8px';
		infoContainer.style.backgroundColor = 'var(--background-secondary)';

		infoContainer.createEl('p', {
			text: `새로운 버전이 원격 저장소에서 감지되었습니다.`,
		});

		const versionTable = infoContainer.createDiv();
		versionTable.style.display = 'grid';
		versionTable.style.gridTemplateColumns = 'auto 1fr';
		versionTable.style.gap = '8px 15px';
		versionTable.style.marginTop = '10px';

		versionTable.createEl('strong', { text: '현재 버전:' });
		versionTable.createEl('span', { text: `v${this.localVersion}` });

		versionTable.createEl('strong', { text: '최신 버전:' });
		const newVersionEl = versionTable.createEl('span', { text: `v${this.remoteVersion}` });
		newVersionEl.style.color = 'var(--interactive-accent)';
		newVersionEl.style.fontWeight = 'bold';

		contentEl.createEl('p', {
			text: 'ℹ️ 업데이트 후 옵시디언이 자동으로 새로고침됩니다.',
			cls: 'setting-item-description',
		});

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '10px';

		const cancelBtn = buttonContainer.createEl('button', { text: '나중에' });
		cancelBtn.addEventListener('click', () => this.close());

		const updateBtn = buttonContainer.createEl('button', {
			text: '업데이트',
			cls: 'mod-cta',
		});

		updateBtn.addEventListener('click', async () => {
			updateBtn.disabled = true;
			cancelBtn.disabled = true;
			updateBtn.textContent = '⏳ 다운로드 중...';

			try {
				const baseUrl = this.config.gitlabUrl.replace(/\/+$/, '');
				const isGitHub = baseUrl.includes('github.com');

				if (isGitHub && this.assets && this.assets.length > 0) {
					await performGitHubUpdate(this.plugin, this.assets);
				} else if (!isGitHub) {
					await performGitLabUpdate(this.plugin, this.config);
				} else {
					throw new Error('GitHub 릴리즈에 다운로드할 파일이 없습니다. 태그를 push하여 릴리즈를 생성해 주세요.');
				}

				this.close();
				new Notice('✅ 업데이트가 완료되었습니다! 옵시디언을 새로고침합니다...', 3000);
				// 파일 쓰기 완료 후 잠시 대기 후 자동 리로드
				window.setTimeout(() => {
					(this.app as any).commands.executeCommandById('app:reload');
				}, 1500);
			} catch (e) {
				updateBtn.disabled = false;
				cancelBtn.disabled = false;
				updateBtn.textContent = '업데이트';
				const msg = e instanceof Error ? e.message : String(e);
				new Notice(`❌ 업데이트 실패: ${msg}`);
				console.error('[Updater] 업데이트 실패:', e);
			}
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
