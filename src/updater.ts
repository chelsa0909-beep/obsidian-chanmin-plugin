import { App, Modal, Notice, Plugin, requestUrl, normalizePath } from 'obsidian';

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

/** GitHub Release 에셋 정보 */
interface ReleaseAsset {
	name: string;
	browser_download_url: string;
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
	let assets: ReleaseAsset[] = [];

	// 1차: GitHub Releases API로 최신 릴리즈 확인
	try {
		const apiUrl = `https://api.github.com/repos/${repoFullName}/releases/latest`;
		const response = await requestUrl({
			url: apiUrl,
			headers: { ...headers, 'Accept': 'application/vnd.github+json' },
		});
		const release = JSON.parse(response.text);
		remoteVersion = release.tag_name.replace(/^v/, '');
		assets = release.assets ?? [];
		console.log(`[Updater] GitHub Release 발견: v${remoteVersion} (에셋 ${assets.length}개)`);
	} catch (releaseErr) {
		// Releases API 실패 → fallback으로 manifest.json 확인
		console.log('[Updater] GitHub Release 조회 실패 (릴리즈 없음 또는 API 제한). manifest.json에서 버전을 확인합니다.');
		try {
			const rawUrl = `https://raw.githubusercontent.com/${repoFullName}/${config.branch}/manifest.json`;
			const response = await requestUrl({ url: rawUrl, headers });
			const manifest = JSON.parse(response.text);
			remoteVersion = manifest.version;
		} catch (manifestErr) {
			console.warn('[Updater] manifest.json도 가져올 수 없습니다.');
			return;
		}
	}

	const localVersion = plugin.manifest.version;
	console.log(`[Updater] 로컬 버전: v${localVersion}, 원격 버전: v${remoteVersion}`);

	if (compareSemVer(remoteVersion, localVersion) > 0) {
		if (assets.length > 0) {
			// 릴리즈 에셋이 있으면 업데이트 모달 표시
			new UpdateConfirmModal(plugin.app, plugin, config, localVersion, remoteVersion, assets).open();
		} else {
			// 새 버전은 있지만 릴리즈가 없음 → 알림만 표시
			console.log(`[Updater] 새 버전 v${remoteVersion}이 있지만 GitHub Release가 아직 생성되지 않았습니다.`);
			new Notice(`🔄 새 플러그인 버전(v${remoteVersion})이 감지되었지만, GitHub Release가 아직 없습니다.\n태그를 push하면 자동으로 릴리즈가 생성됩니다.`, 8000);
		}
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
		// 네트워크 오류 등은 조용히 로그만 남김
		console.log('[Updater] 업데이트 체크를 건너뜁니다:', e instanceof Error ? e.message : String(e));
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
					throw new Error('GitHub 릴리즈에 다운로드할 파일이 없습니다.');
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
