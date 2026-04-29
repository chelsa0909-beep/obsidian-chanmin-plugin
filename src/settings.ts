import { App, PluginSettingTab, Setting } from "obsidian";
import MyPlugin from "./main";

export interface MyPluginSettings {
	gcsBucket: string;
	gcsFolder: string;
	gcsServiceAccountKey: string;
	gcsTargetPrefix: string;
	// GitLab 자체 업데이트 설정
	gitlabUrl: string;
	gitlabProjectId: string;
	gitlabAccessToken: string;
	gitlabBranch: string;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	gcsBucket: '',
	gcsFolder: '',
	gcsServiceAccountKey: '',
	gcsTargetPrefix: '',
	gitlabUrl: '',
	gitlabProjectId: '',
	gitlabAccessToken: '',
	gitlabBranch: 'main',
}

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Google Cloud Storage 설정' });

		new Setting(containerEl)
			.setName('GCS 버킷 이름')
			.setDesc('파일을 업로드할 Google Cloud Storage 버킷 이름')
			.addText(text => text
				.setPlaceholder('my-bucket-name')
				.setValue(this.plugin.settings.gcsBucket)
				.onChange(async (value) => {
					this.plugin.settings.gcsBucket = value;
					await this.plugin.saveSettings();
				}));

		// new Setting(containerEl)
		// 	.setName('업로드할 폴더 경로')
		// 	.setDesc('옵시디언 Vault 내 업로드할 폴더 경로 (예: Notes/uploads)')
		// 	.addText(text => text
		// 		.setPlaceholder('Notes/uploads')
		// 		.setValue(this.plugin.settings.gcsFolder)
		// 		.onChange(async (value) => {
		// 			this.plugin.settings.gcsFolder = value;
		// 			await this.plugin.saveSettings();
		// 		}));

		// new Setting(containerEl)
		// 	.setName('GCS 대상 경로 프리픽스')
		// 	.setDesc('GCS 버킷 내 업로드 대상 경로 프리픽스 (선택, 비워두면 루트에 업로드)')
		// 	.addText(text => text
		// 		.setPlaceholder('obsidian-backup')
		// 		.setValue(this.plugin.settings.gcsTargetPrefix)
		// 		.onChange(async (value) => {
		// 			this.plugin.settings.gcsTargetPrefix = value;
		// 			await this.plugin.saveSettings();
		// 		}));

		new Setting(containerEl)
			.setName('서비스 계정 JSON 키')
			.setDesc('Google Cloud 서비스 계정 JSON 키 파일의 내용을 붙여넣으세요')
			.addTextArea(text => {
				text
					.setPlaceholder('{\n  "type": "service_account",\n  ...\n}')
					.setValue(this.plugin.settings.gcsServiceAccountKey)
					.onChange(async (value) => {
						this.plugin.settings.gcsServiceAccountKey = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 10;
				text.inputEl.cols = 50;
				text.inputEl.style.width = '100%';
				text.inputEl.style.fontFamily = 'monospace';
				text.inputEl.style.fontSize = '12px';
			});

		// ── GitLab 자체 업데이트 설정 ──────────────────────────
		containerEl.createEl('h2', { text: '플러그인 자동 업데이트 설정 (GitLab)' });

		new Setting(containerEl)
			.setName('GitLab URL')
			.setDesc('사내 GitLab 서버 주소 (예: https://gitlab.mycompany.com)')
			.addText(text => text
				.setPlaceholder('https://gitlab.mycompany.com')
				.setValue(this.plugin.settings.gitlabUrl)
				.onChange(async (value) => {
					this.plugin.settings.gitlabUrl = value.replace(/\/+$/, ''); // 후행 슬래시 제거
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('프로젝트 ID')
			.setDesc('GitLab 프로젝트 ID (프로젝트 설정 페이지에서 확인 가능)')
			.addText(text => text
				.setPlaceholder('1234')
				.setValue(this.plugin.settings.gitlabProjectId)
				.onChange(async (value) => {
					this.plugin.settings.gitlabProjectId = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Access Token')
			.setDesc('GitLab Personal Access Token (read_api 또는 read_repository 권한 필요)')
			.addText(text => {
				text
					.setPlaceholder('glpat-xxxxxxxxxxxxxxxxxxxx')
					.setValue(this.plugin.settings.gitlabAccessToken)
					.onChange(async (value) => {
						this.plugin.settings.gitlabAccessToken = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});

		new Setting(containerEl)
			.setName('브랜치')
			.setDesc('릴리즈 빌드 파일이 있는 브랜치 (기본: main)')
			.addText(text => text
				.setPlaceholder('main')
				.setValue(this.plugin.settings.gitlabBranch)
				.onChange(async (value) => {
					this.plugin.settings.gitlabBranch = value || 'main';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('지금 업데이트 확인')
			.setDesc('수동으로 새 버전이 있는지 확인합니다.')
			.addButton(button => button
				.setButtonText('확인')
				.setCta()
				.onClick(async () => {
					const { checkForPluginUpdate } = await import('./updater');
					await checkForPluginUpdate(this.plugin, {
						gitlabUrl: this.plugin.settings.gitlabUrl,
						projectId: this.plugin.settings.gitlabProjectId,
						accessToken: this.plugin.settings.gitlabAccessToken,
						branch: this.plugin.settings.gitlabBranch,
					});
				}));
	}
}
