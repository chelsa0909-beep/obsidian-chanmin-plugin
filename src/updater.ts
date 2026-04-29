import { App, Modal, Notice, Plugin, requestUrl, normalizePath } from 'obsidian';

/**
 * GitLab 기반 플러그인 자체 업데이트 모듈
 *
 * 동작 흐름:
 * 1. 플러그인 로드 시 GitLab API를 통해 원격 manifest.json을 가져옴
 * 2. 로컬 manifest.version과 비교
 * 3. 원격 버전이 높으면 업데이트 알림 모달 표시
 * 4. 사용자 수락 시 main.js, manifest.json, styles.css를 다운로드하여 덮어쓰기
 * 5. 옵시디언 재시작(Ctrl+R) 안내
 */

interface UpdateConfig {
	gitlabUrl: string;
	projectId: string;
	accessToken: string;
	branch: string;
}

interface RemoteManifest {
	version: string;
	name?: string;
	description?: string;
	[key: string]: unknown;
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
 * GitLab API를 통해 원격 파일의 Raw 내용을 가져옵니다.
 */
async function fetchRawFile(config: UpdateConfig, filePath: string): Promise<string> {
	const encodedPath = encodeURIComponent(filePath);
	const url = `${config.gitlabUrl}/api/v4/projects/${config.projectId}/repository/files/${encodedPath}/raw?ref=${config.branch}`;

	const response = await requestUrl({
		url,
		headers: {
			'PRIVATE-TOKEN': config.accessToken,
		},
	});

	return response.text;
}

/**
 * 플러그인 업데이트 체크를 수행합니다.
 * 설정이 누락되어 있으면 조용히 스킵합니다.
 */
export async function checkForPluginUpdate(plugin: Plugin, config: UpdateConfig): Promise<void> {
	// 설정 미입력 시 조용히 종료
	if (!config.gitlabUrl || !config.projectId || !config.accessToken) {
		console.log('[Updater] GitLab 설정이 비어 있어 업데이트 체크를 건너뜁니다.');
		return;
	}

	try {
		// 1. 원격 manifest.json 가져오기
		const rawManifest = await fetchRawFile(config, 'manifest.json');
		const remoteManifest: RemoteManifest = JSON.parse(rawManifest);

		const localVersion = plugin.manifest.version;
		const remoteVersion = remoteManifest.version;

		console.log(`[Updater] 로컬 버전: v${localVersion}, 원격 버전: v${remoteVersion}`);

		// 2. 버전 비교
		if (compareSemVer(remoteVersion, localVersion) > 0) {
			// 3. 업데이트 모달 표시
			new UpdateConfirmModal(plugin.app, plugin, config, localVersion, remoteVersion).open();
		} else {
			console.log('[Updater] 최신 버전입니다.');
		}
	} catch (e) {
		// 네트워크 오류 등은 조용히 로그만 남김 (사용자를 방해하지 않음)
		console.warn('[Updater] 업데이트 체크 실패:', e);
	}
}

/**
 * 실제 업데이트를 수행합니다.
 * GitLab에서 main.js, manifest.json, styles.css를 다운로드하여 플러그인 폴더에 덮어씁니다.
 */
async function performUpdate(plugin: Plugin, config: UpdateConfig): Promise<void> {
	const pluginDir = plugin.manifest.dir;
	if (!pluginDir) {
		throw new Error('플러그인 디렉토리를 찾을 수 없습니다.');
	}

	const filesToUpdate = ['main.js', 'manifest.json', 'styles.css'];
	let updatedCount = 0;

	for (const fileName of filesToUpdate) {
		try {
			const content = await fetchRawFile(config, fileName);
			const filePath = normalizePath(`${pluginDir}/${fileName}`);
			await plugin.app.vault.adapter.write(filePath, content);
			updatedCount++;
			console.log(`[Updater] ${fileName} 업데이트 완료`);
		} catch (e) {
			// styles.css는 없을 수 있으므로 404는 무시
			if (fileName === 'styles.css') {
				console.log(`[Updater] ${fileName} 파일이 원격에 없습니다 (정상).`);
			} else {
				throw new Error(`${fileName} 다운로드 실패: ${e}`);
			}
		}
	}

	console.log(`[Updater] 총 ${updatedCount}개 파일 업데이트 완료`);
}

/**
 * 업데이트 확인 모달
 * 새 버전이 감지되었을 때 사용자에게 업데이트 여부를 묻는 모달입니다.
 */
class UpdateConfirmModal extends Modal {
	plugin: Plugin;
	config: UpdateConfig;
	localVersion: string;
	remoteVersion: string;

	constructor(app: App, plugin: Plugin, config: UpdateConfig, localVersion: string, remoteVersion: string) {
		super(app);
		this.plugin = plugin;
		this.config = config;
		this.localVersion = localVersion;
		this.remoteVersion = remoteVersion;
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
			text: `새로운 버전이 사내 GitLab에서 감지되었습니다.`,
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
			text: '⚠️ 업데이트 후 옵시디언을 새로고침(Ctrl+R)해야 적용됩니다.',
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
				await performUpdate(this.plugin, this.config);
				this.close();
				new Notice('✅ 업데이트가 완료되었습니다! Ctrl+R로 옵시디언을 새로고침해 주세요.', 10000);
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
