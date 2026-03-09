import { App, PluginSettingTab, Setting } from "obsidian";
import MyPlugin from "./main";

export interface MyPluginSettings {
	gcsBucket: string;
	gcsFolder: string;
	gcsServiceAccountKey: string;
	gcsTargetPrefix: string;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	gcsBucket: '',
	gcsFolder: '',
	gcsServiceAccountKey: '',
	gcsTargetPrefix: '',
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
	}
}
