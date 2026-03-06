import { App, Modal, Notice, Plugin, TFile, TFolder, Setting, moment } from 'obsidian';
import { DEFAULT_SETTINGS, MyPluginSettings, SampleSettingTab } from "./settings";
import { getMdFilesInFolder, uploadFilesToGcs } from "./gcs-uploader";
import { parseOffice } from 'officeparser';
import * as kuromoji from 'kuromoji-ko';
import nlp from 'compromise';
import { pptxToHtml } from '@jvmr/pptx-to-html';
import html2canvas from 'html2canvas';

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		// GCS 업로드 리본 아이콘
		this.addRibbonIcon('upload-cloud', 'RAG Agent 업로드', async () => {
			await this.runUpload();
		});

		// 상태바
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('RAG Agent Upload Ready');

		// 업로드 커맨드
		this.addCommand({
			id: 'upload-to-gcs',
			name: 'Upload folder to Google Cloud Storage',
			callback: async () => {
				await this.runUpload();
			}
		});

		// 설정 탭
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// 파일 컨텍스트 메뉴 (우클릭)
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFile) {
					// 1. GCS 개별 업로드 메뉴 및 태그 달기 메뉴 (MD 파일만)
					if (file.extension.toLowerCase() === 'md') {
						menu.addItem((item) => {
							item
								.setTitle('RAG Agent 업로드')
								.setIcon('upload-cloud')
								.onClick(async () => {
									await this.uploadSingleFile(file);
								});
						});

						menu.addItem((item) => {
							item
								.setTitle('태그 달기')
								.setIcon('tag')
								.onClick(() => {
									new TagInputModal(this.app, file).open();
								});
						});
					}

					// 2. PPT, 엑셀, 워드, PDF 확장자 검사 및 MD 변환 메뉴
					const targetExtensions = ['ppt', 'pptx', 'xls', 'xlsx', 'doc', 'docx', 'pdf'];
					if (targetExtensions.includes(file.extension.toLowerCase())) {
						menu.addItem((item) => {
							item
								.setTitle('MD 파일로 변환')
								.setIcon('file-text')
								.onClick(() => {
									new ConfirmConvertModal(this.app, file).open();
								});
						});
					}
				} else if (file instanceof TFolder) {
					// 3. 폴더 하위 파일 일괄 MD 변환 메뉴
					menu.addItem((item) => {
						item
							.setTitle('하위 파일 일괄 MD 변환')
							.setIcon('file-text')
							.onClick(async () => {
								await this.bulkConvertFolder(file);
							});
					});
				}
			})
		);
	}

	async bulkConvertFolder(folder: TFolder) {
		const targetExtensions = ['ppt', 'pptx', 'xls', 'xlsx', 'doc', 'docx', 'pdf'];
		const filesToConvert: TFile[] = [];

		const findFilesRecursively = (f: TFolder) => {
			for (const child of f.children) {
				if (child instanceof TFile) {
					if (targetExtensions.includes(child.extension.toLowerCase())) {
						filesToConvert.push(child);
					}
				} else if (child instanceof TFolder) {
					findFilesRecursively(child);
				}
			}
		};

		findFilesRecursively(folder);

		if (filesToConvert.length === 0) {
			new Notice('ℹ️ 변환할 지원 파일이 폴더 내에 없습니다.');
			return;
		}

		if (!confirm(`"${folder.name}" 폴더 내 ${filesToConvert.length}개의 파일을 MD 파일로 일괄 변환하시겠습니까?`)) {
			return;
		}

		let successCount = 0;
		let failCount = 0;

		new Notice(`⏳ 일괄 변환 시작 (${filesToConvert.length}개)...`);

		for (const file of filesToConvert) {
			try {
				await convertOfficeFileToMarkdown(this.app, file);
				successCount++;
			} catch (e) {
				console.error(`Failed to convert ${file.path}:`, e);
				failCount++;
			}
		}

		new Notice(`✅ 일괄 변환 완료: ${successCount}개 성공, ${failCount}개 실패`);
	}

	async doActualUpload(files: TFile[], basePathToRemove: string) {
		const { gcsBucket, gcsServiceAccountKey, gcsTargetPrefix } = this.settings;
		try {
			const result = await uploadFilesToGcs(
				this.app,
				gcsBucket,
				files,
				gcsServiceAccountKey,
				gcsTargetPrefix,
				basePathToRemove
			);

			if (result.failed === 0) {
				new Notice(`🎉 업로드 완료! ${result.success}개 파일 성공`);
			} else {
				new Notice(`⚠️ 업로드 완료: ${result.success}개 성공, ${result.failed}개 실패`);
				console.error('GCS Upload Errors:', result.errors);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`❌ 업로드 실패: ${msg}`);
			console.error('GCS Upload Error:', e);
		}
	}

	async uploadSingleFile(file: TFile) {
		const { gcsBucket, gcsServiceAccountKey } = this.settings;

		if (!gcsBucket) {
			new Notice('⚠️ RAG Agent GCS 버킷 이름을 설정해주세요.');
			return;
		}
		if (!gcsServiceAccountKey) {
			new Notice('⚠️ RAG Agent 서비스 계정 JSON 키를 설정해주세요.');
			return;
		}

		const basePathToRemove = file.parent ? file.parent.path : '';

		// 태그 누락 검사 (YAML Frontmatter만)
		const cache = this.app.metadataCache.getFileCache(file);
		const tags = cache?.frontmatter?.tags;
		let hasTag = false;
		if (tags) {
			if (Array.isArray(tags) && tags.length > 0) hasTag = true;
			if (typeof tags === 'string' && tags.trim() !== '') hasTag = true;
		}

		if (!hasTag) {
			// 태그가 없으면 바로 경고 모달 표시
			new ConfirmUploadModal(this.app, [file], () => {
				this.doActualUpload([file], basePathToRemove);
			}).open();
		} else {
			// 태그가 있으면 일반 확인 모달 표시
			new ConfirmSingleUploadModal(this.app, file, () => {
				this.doActualUpload([file], basePathToRemove);
			}).open();
		}
	}

	async runUpload() {
		const { gcsBucket, gcsFolder, gcsServiceAccountKey } = this.settings;

		if (!gcsBucket) {
			new Notice('⚠️ RAG Agent GCS 버킷 이름을 설정해주세요.');
			return;
		}
		if (!gcsFolder) {
			new Notice('⚠️ 업로드할 폴더 경로를 설정해주세요.');
			return;
		}
		if (!gcsServiceAccountKey) {
			new Notice('⚠️ RAG Agent 서비스 계정 JSON 키를 설정해주세요.');
			return;
		}

		try {
			const files = getMdFilesInFolder(this.app, gcsFolder);
			if (files.length === 0) {
				new Notice(`⚠️ 지정된 폴더에 마크다운 파일이 없습니다.`);
				return;
			}
			new SelectFilesModal(this.app, files, (selectedFiles) => {
				if (selectedFiles.length > 0) {
					this.doActualUpload(selectedFiles, gcsFolder);
				}
			}).open();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`❌ 폴더를 읽는 중 오류가 발생했습니다: ${msg}`);
		}
	}

	onunload() {
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MyPluginSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class ConfirmConvertModal extends Modal {
	file: TFile;

	constructor(app: App, file: TFile) {
		super(app);
		this.file = file;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: '파일 변환 확인' });
		contentEl.createEl('p', { text: `"${this.file.name}" 파일을 MD 파일로 변환하시겠습니까?` });
		contentEl.createEl('p', {
			text: 'ℹ️ 파일의 텍스트가 추출되어 같은 이름의 새로운 마크다운 파일로 생성됩니다. 원본 파일은 그대로 유지됩니다.',
			cls: 'setting-item-description'
		});

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

		const confirmButton = buttonContainer.createEl('button', {
			text: '변환',
			cls: 'mod-cta'
		});

		const cancelButton = buttonContainer.createEl('button', {
			text: '취소'
		});

		confirmButton.addEventListener('click', async () => {
			this.close();
			await this.convertFile();
		});

		cancelButton.addEventListener('click', () => {
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	async convertFile() {
		new Notice('⏳ 텍스트 및 미디어 추출 중...');
		try {
			await convertOfficeFileToMarkdown(this.app, this.file);
			new Notice(`✅ 변환 완료!`);
		} catch (error) {
			console.error('Office Parsing Error:', error);
			const msg = error instanceof Error ? error.message : String(error);
			new Notice(`❌ 변환 실패: ${msg}`);
		}
	}
}

class SelectFilesModal extends Modal {
	files: TFile[];
	selectedFiles: Set<TFile>;
	onConfirm: (selectedFiles: TFile[]) => void;

	// Sorting state
	currentSortBy: 'name' | 'ctime' | 'size' = 'name';
	sortAsc: boolean = true;

	// Store toggle components to update their UI later
	toggles: { file: TFile, toggle: any }[] = [];

	constructor(app: App, files: TFile[], onConfirm: (selectedFiles: TFile[]) => void) {
		super(app);
		this.files = files;
		this.selectedFiles = new Set(files); // 기본적으로 모두 선택됨
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'RAG Agent 업로드 파일 선택' });

		const descEl = contentEl.createEl('p', { text: '업로드할 마크다운 파일을 선택해주세요.' });
		descEl.style.marginBottom = '10px';

		// 상단 컨트롤 컨테이너 (정렬 + 선택 버튼들)
		const controlsContainer = contentEl.createDiv({ cls: 'modal-controls-container' });
		controlsContainer.style.display = 'flex';
		controlsContainer.style.justifyContent = 'space-between';
		controlsContainer.style.alignItems = 'center';
		controlsContainer.style.marginBottom = '10px';
		controlsContainer.style.gap = '10px';
		controlsContainer.style.flexWrap = 'wrap';

		// 1. 정렬 컨트롤 파트
		const sortContainer = controlsContainer.createDiv();
		sortContainer.style.display = 'flex';
		sortContainer.style.alignItems = 'center';
		sortContainer.style.gap = '5px';

		sortContainer.createEl('span', { text: '정렬: ' });

		const sortDropdown = sortContainer.createEl('select');
		sortDropdown.createEl('option', { value: 'name', text: '파일명' });
		sortDropdown.createEl('option', { value: 'ctime', text: '생성일' });
		sortDropdown.createEl('option', { value: 'size', text: '크기' });
		sortDropdown.value = this.currentSortBy;

		const sortOrderBtn = sortContainer.createEl('button', { text: this.sortAsc ? '▲ 오름차순' : '▼ 내림차순' });

		// 2. 선택 컨트롤 파트
		const selectionContainer = controlsContainer.createDiv();
		selectionContainer.style.display = 'flex';
		selectionContainer.style.gap = '5px';
		selectionContainer.style.alignItems = 'center';

		let isAllSelected = this.selectedFiles.size === this.files.length;

		const selectAllSetting = new Setting(selectionContainer)
			.setName('전체 선택')
			.addToggle(toggle => {
				toggle.setValue(isAllSelected)
					.onChange(value => {
						isAllSelected = value;
						if (value) {
							this.files.forEach(file => this.selectedFiles.add(file));
							this.toggles.forEach(t => t.toggle.setValue(true));
						} else {
							this.selectedFiles.clear();
							this.toggles.forEach(t => t.toggle.setValue(false));
						}
					});
			});
		selectAllSetting.settingEl.style.padding = '0';
		selectAllSetting.settingEl.style.borderTop = 'none';

		const listContainer = contentEl.createDiv({ cls: 'modal-file-list-container' });
		listContainer.style.maxHeight = '300px';
		listContainer.style.overflowY = 'auto';
		listContainer.style.border = '1px solid var(--background-modifier-border)';
		listContainer.style.padding = '10px';
		listContainer.style.borderRadius = '5px';
		listContainer.style.marginBottom = '20px';

		const renderFileList = () => {
			// 기존 리스트 초기화
			listContainer.empty();
			this.toggles = [];

			// 파일 정렬
			const sortedFiles = [...this.files].sort((a, b) => {
				let cmp = 0;
				if (this.currentSortBy === 'name') {
					cmp = a.name.localeCompare(b.name);
				} else if (this.currentSortBy === 'ctime') {
					cmp = a.stat.ctime - b.stat.ctime;
				} else if (this.currentSortBy === 'size') {
					cmp = a.stat.size - b.stat.size;
				}
				return this.sortAsc ? cmp : -cmp;
			});

			sortedFiles.forEach(file => {
				// 파일 디스플레이 정보
				const sizeKb = (file.stat.size / 1024).toFixed(1) + ' KB';
				const dateStr = moment(file.stat.ctime).format('YYYY-MM-DD HH:mm');

				const setting = new Setting(listContainer)
					.setName(file.name)
					.setDesc(`${sizeKb} | ${dateStr} | ${file.path}`)
					.addToggle(toggle => {
						this.toggles.push({ file, toggle });
						toggle
							.setValue(this.selectedFiles.has(file))
							.onChange(value => {
								if (value) {
									this.selectedFiles.add(file);
								} else {
									this.selectedFiles.delete(file);
								}
							});
					});

				// 기본 Setting 컴포넌트의 패딩/마진 조절 (간격 축소)
				setting.settingEl.style.padding = '5px 0';
				setting.settingEl.style.borderTop = 'none';
			});
		};

		// 초기 렌더링
		renderFileList();

		// 이벤트 리스너 등록
		sortDropdown.addEventListener('change', (e) => {
			this.currentSortBy = (e.target as HTMLSelectElement).value as 'name' | 'ctime' | 'size';
			renderFileList();
		});

		sortOrderBtn.addEventListener('click', () => {
			this.sortAsc = !this.sortAsc;
			sortOrderBtn.textContent = this.sortAsc ? '▲ 오름차순' : '▼ 내림차순';
			renderFileList();
		});

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '10px';

		const confirmButton = buttonContainer.createEl('button', {
			text: '선택한 파일 전송',
			cls: 'mod-cta'
		});

		const cancelButton = buttonContainer.createEl('button', {
			text: '취소'
		});

		confirmButton.addEventListener('click', () => {
			const selectedList = Array.from(this.selectedFiles);
			if (selectedList.length === 0) {
				new Notice('⚠️ 선택된 파일이 없습니다.');
				return;
			}

			// 태그 없는 파일 검사 (YAML Frontmatter 태그만 확인)
			const filesWithoutTags = selectedList.filter(file => {
				const cache = this.app.metadataCache.getFileCache(file);
				const tags = cache?.frontmatter?.tags;

				if (tags) {
					if (Array.isArray(tags) && tags.length > 0) return false;
					if (typeof tags === 'string' && tags.trim() !== '') return false;
				}

				return true; // YAML에 tags가 없거나 비어있으면 누락으로 간주
			});

			if (filesWithoutTags.length > 0) {
				// 태그 없는 파일이 있으면 경고 모달 표시
				new ConfirmUploadModal(this.app, filesWithoutTags, () => {
					this.close();
					this.onConfirm(selectedList);
				}).open();
			} else {
				// 모두 태그가 있으면 바로 진행
				this.close();
				this.onConfirm(selectedList);
			}
		});

		cancelButton.addEventListener('click', () => {
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class ConfirmUploadModal extends Modal {
	missingTagFiles: TFile[];
	onConfirm: () => void;

	constructor(app: App, missingTagFiles: TFile[], onConfirm: () => void) {
		super(app);
		this.missingTagFiles = missingTagFiles;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: '⚠️ 태그 누락 확인!' });

		const descEl = contentEl.createEl('p', {
			text: '다음 파일들에 태그(tags)가 설정되어 있지 않습니다. 그래도 업로드하시겠습니까?'
		});
		descEl.style.color = 'var(--text-warning)';

		const fileListDiv = contentEl.createDiv();
		fileListDiv.style.maxHeight = '200px';
		fileListDiv.style.overflowY = 'auto';
		fileListDiv.style.padding = '10px';
		fileListDiv.style.marginBottom = '20px';
		fileListDiv.style.backgroundColor = 'var(--background-secondary)';
		fileListDiv.style.borderRadius = '5px';
		fileListDiv.style.fontSize = '0.9em';

		this.missingTagFiles.forEach(file => {
			fileListDiv.createEl('div', { text: `• ${file.name}` });
		});

		const buttonContainer = contentEl.createDiv();
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '10px';

		const confirmBtn = buttonContainer.createEl('button', {
			text: '그래도 전송',
			cls: 'mod-cta'
		});

		const cancelBtn = buttonContainer.createEl('button', {
			text: '취소'
		});

		confirmBtn.addEventListener('click', () => {
			this.close();
			this.onConfirm();
		});

		cancelBtn.addEventListener('click', () => {
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

class TagInputModal extends Modal {
	file: TFile;
	inputEl: HTMLInputElement;
	static tokenizer: any = null; // 분석기 캐싱
	static isInitializing: boolean = false;
	static DIC_URL = "https://cdn.jsdelivr.net/npm/kuromoji-ko@1.0.8/dict/";

	constructor(app: App, file: TFile) {
		super(app);
		this.file = file;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: '태그 달기' });

		const descEl = contentEl.createEl('p', { text: `"${this.file.name}" 파일에 추가할 태그를 입력하세요.` });
		descEl.style.marginBottom = '15px';

		const noticeEl = contentEl.createEl('p', {
			text: '여러 개의 태그를 추가하려면 쉼표(,)나 띄어쓰기로 구분해주세요.',
			cls: 'setting-item-description'
		});
		noticeEl.style.marginBottom = '15px';

		// 추천 태그 영역 컨테이너
		const suggestionsContainer = contentEl.createDiv({ cls: 'tag-suggestions-container' });
		suggestionsContainer.style.marginBottom = '15px';
		const suggestionsLabel = suggestionsContainer.createEl('span', { text: '추천 태그 분석 중...', cls: 'setting-item-description' });
		const suggestionsList = suggestionsContainer.createDiv();
		suggestionsList.style.display = 'flex';
		suggestionsList.style.flexWrap = 'wrap';
		suggestionsList.style.gap = '8px';
		suggestionsList.style.marginTop = '8px';
		// 스크롤이 가능하도록 높이 및 스타일 지정
		suggestionsList.style.maxHeight = '200px';
		suggestionsList.style.overflowY = 'auto';
		suggestionsList.style.padding = '10px';
		suggestionsList.style.border = '1px solid var(--background-modifier-border)';
		suggestionsList.style.borderRadius = '5px';

		const inputContainer = contentEl.createDiv({ cls: 'modal-input-container' });
		this.inputEl = inputContainer.createEl('input', {
			type: 'text',
			placeholder: '예: 백터, 데이터베이스, AI'
		});
		this.inputEl.style.width = '100%';
		this.inputEl.style.marginBottom = '20px';

		// 비동기로 파일 내용 읽어서 키워드 추출
		this.app.vault.read(this.file).then(async (content) => {
			// 1. 영어 명사 우선 추출 (분석기가 없어도 즉시 실행 가능)
			let suggestedTags = this.extractNouns(null, content);
			this.renderSuggestedTags(suggestedTags, suggestionsList, suggestionsLabel);

			// 2. 한국어 분석기 로드 후 전체 다시 분석
			try {
				// 이미 로드되어 있으면 즉시 반환됨, 아니면 로딩 대기
				if (!TagInputModal.tokenizer) {
					suggestionsLabel.setText('추천 태그 분석 중 (한국어 엔진 로드 중...)');
				}
				const tokenizer = await this.getTokenizer();
				suggestedTags = this.extractNouns(tokenizer, content);
				this.renderSuggestedTags(suggestedTags, suggestionsList, suggestionsLabel);
			} catch (err) {
				console.error('Korean NLP engine load failed', err);
				// 로드 실패해도 영어 태그는 유지됨
			}
		}).catch(e => {
			console.error('Failed to read file for tag suggestion', e);
			suggestionsLabel.setText('추천 태그 분석 실패');
		});

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '10px';

		const confirmButton = buttonContainer.createEl('button', {
			text: '추가',
			cls: 'mod-cta'
		});

		const cancelButton = buttonContainer.createEl('button', {
			text: '취소'
		});

		// 엔터키 지원
		this.inputEl.addEventListener('keydown', async (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.close();
				await this.addTags();
			}
		});

		confirmButton.addEventListener('click', async () => {
			this.close();
			await this.addTags();
		});

		cancelButton.addEventListener('click', () => {
			this.close();
		});

		// 모달 열릴 때 인풋 포커스
		setTimeout(() => this.inputEl.focus(), 50);
	}

	// 토큰라이저 가져오기/초기화 (싱글톤)
	async getTokenizer(): Promise<any> {
		if (TagInputModal.tokenizer) return TagInputModal.tokenizer;

		// Promise 기반 빌드 호출
		const tokenizer = await kuromoji.builder({ dicPath: TagInputModal.DIC_URL }).build();
		TagInputModal.tokenizer = tokenizer;
		return tokenizer;
	}

	// 추천 태그 알약 버튼들을 렌더링하는 헬퍼 메서드
	renderSuggestedTags(tags: string[], listEl: HTMLElement, labelEl: HTMLElement) {
		listEl.empty();
		labelEl.setText(tags.length > 0 ? '추천 태그 (클릭하여 추가):' : '추천할 태그가 없습니다.');

		tags.forEach(tag => {
			const pillBtn = listEl.createEl('button', { text: tag });
			// 알약 모양 스타일링
			pillBtn.style.padding = '4px 10px';
			pillBtn.style.borderRadius = '12px';
			pillBtn.style.fontSize = '12px';
			pillBtn.style.backgroundColor = 'var(--interactive-normal)';
			pillBtn.style.border = '1px solid var(--background-modifier-border)';
			pillBtn.style.cursor = 'pointer';

			pillBtn.addEventListener('click', () => {
				const currentVal = this.inputEl.value.trim();
				if (currentVal) {
					// 중복 방지
					const existing = currentVal.split(/[, ]+/);
					if (!existing.includes(tag)) {
						this.inputEl.value = currentVal + (currentVal.endsWith(',') ? ' ' : ', ') + tag;
					}
				} else {
					this.inputEl.value = tag;
				}
				this.inputEl.focus();
			});
		});
	}

	// 형태소 분석기를 사용하여 한글/영어 명사 추출
	extractNouns(tokenizer: any, text: string): string[] {
		if (!text) return [];

		// 1. 마크다운 기호 등 불필요한 부분 1차 정제
		const cleanText = text
			.replace(/```[\s\S]*?```/g, '') // 코드블록 제거
			.replace(/!\[.*?\]\(.*?\)/g, '') // 이미지 링크 제거
			.replace(/\[.*?\]\(.*?\)/g, '') // 일반 링크 제거
			.replace(/[#*`~>|\-+=]/g, ' '); // 특수기호 공백 치환

		const frequencyMap = new Map<string, number>();

		// --- 2. 한국어 명사 추출 (kuromoji-ko) ---
		if (tokenizer) {
			try {
				const tokens = tokenizer.tokenize(cleanText);
				for (const token of tokens) {
					const pos = token.pos;
					const word = token.surface_form;
					// NNG: 일반 명사, NNP: 고유 명사 (2글자 이상)
					if ((pos === 'NNG' || pos === 'NNP') && word.length >= 2) {
						frequencyMap.set(word, (frequencyMap.get(word) || 0) + 1);
					}
				}
			} catch (e) {
				console.error("Korean NLP failed", e);
			}
		}

		// --- 3. 영어 명사 추출 (compromise) ---
		try {
			console.log("English NLP cleaning text length:", cleanText.length);
			// ESM/CJS 호환성을 위한 처리
			const nlpFunc = (nlp as any).default || nlp;
			if (typeof nlpFunc !== 'function') {
				console.log("English NLP: nlpFunc is not a function, type is:", typeof nlpFunc);
			}
			const doc = nlpFunc(cleanText);
			// 명사(#Noun) 태그가 붙은 단어들을 빈도수 순으로 추출
			const enNouns = (doc.match('#Noun') as any).out('topk') as Array<{ normal: string, count: number }>;

			console.log("Extracted enNouns (topk) count:", enNouns.length);
			if (enNouns.length > 0) {
				console.log("Top 5 English Nouns (raw):", enNouns.slice(0, 5));
			}

			for (const item of enNouns) {
				const word = (item.normal || "").trim();
				// 2글자 이상이며 너무 길지 않은 단어 필터링
				if (word && word.length >= 2 && word.length < 30) {
					// 이미 소문자로 처리된 normal을 사용하므로 그대로 빈도수 합산
					frequencyMap.set(word, (frequencyMap.get(word) || 0) + item.count);
				}
			}
		} catch (e) {
			console.error("English NLP failed", e);
		}

		// 4. 전체 빈도수 순 정렬 (한글 + 영어 통합)
		const sortedNouns = Array.from(frequencyMap.entries())
			.sort((a, b) => b[1] - a[1]) // 빈도 높은 순
			.map(entry => entry[0]);

		// 최대 100개 리턴
		return sortedNouns.slice(0, 100);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	async addTags() {
		const rawInput = this.inputEl.value.trim();
		if (!rawInput) {
			return;
		}

		// 쉼표나 공백으로 분리 후 빈 문자열 제거
		const newTags = rawInput
			.split(/[, ]+/)
			.map(t => t.trim())
			.filter(t => t.length > 0)
			.map(t => t.startsWith('#') ? t.substring(1) : t); // 태그 앞의 # 기호가 있으면 제거

		if (newTags.length === 0) {
			return;
		}

		try {
			await this.app.fileManager.processFrontMatter(this.file, (frontmatter) => {
				// 이미 tags가 있는지 체크하고, 없으면 빈 배열 생성
				if (frontmatter.tags === undefined) {
					frontmatter.tags = [];
				} else if (typeof frontmatter.tags === 'string') {
					// 기존 태그가 단일 문자열인 경우 배열로 변환
					frontmatter.tags = [frontmatter.tags];
				} else if (!Array.isArray(frontmatter.tags)) {
					// 다른 타입인 경우 강제로 배열로 변경
					frontmatter.tags = [String(frontmatter.tags)];
				}

				// 중복 태그 방지하면서 새 태그 추가
				for (const tag of newTags) {
					if (!frontmatter.tags.includes(tag)) {
						frontmatter.tags.push(tag);
					}
				}
			});

			new Notice(`✅ 태그 추가 완료: ${newTags.join(', ')}`);
		} catch (error) {
			console.error('Add tag error:', error);
			const msg = error instanceof Error ? error.message : String(error);
			new Notice(`❌ 태그 추가 실패: ${msg}`);
		}
	}
}

class ConfirmSingleUploadModal extends Modal {
	file: TFile;
	onConfirm: () => void;

	constructor(app: App, file: TFile, onConfirm: () => void) {
		super(app);
		this.file = file;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: '개별 파일 업로드 확인' });
		contentEl.createEl('p', { text: `"${this.file.name}" 파일을 RAG Agent로 전송하시겠습니까?` });

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

		const confirmButton = buttonContainer.createEl('button', {
			text: '전송',
			cls: 'mod-cta'
		});

		const cancelButton = buttonContainer.createEl('button', {
			text: '취소'
		});

		confirmButton.addEventListener('click', () => {
			this.close();
			this.onConfirm();
		});

		cancelButton.addEventListener('click', () => {
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * 전역 유틸리티: Office 파일을 마크다운으로 변환
 */
async function convertOfficeFileToMarkdown(app: App, file: TFile) {
	// 1. 파일 데이터 가져오기 (ArrayBuffer)
	const arrayBuffer = await app.vault.readBinary(file);

	// 2. officeparser를 사용해 AST 파싱 (이미지 추출 옵션 켜기)
	const ast = await parseOffice(arrayBuffer, { extractAttachments: true });

	// 4. 새 파일/폴더 이름 생성 베이스
	const basePath = file.path.replace(new RegExp(`\\.${file.extension}$`), '');
	let newPath = `${basePath}.md`;
	let mediaPath = `${basePath}_media`;
	let counter = 1;

	// 이미 같은 이름의 파일이 있으면 숫자를 붙임
	while (app.vault.getAbstractFileByPath(newPath)) {
		newPath = `${basePath} (${counter}).md`;
		mediaPath = `${basePath} (${counter})_media`;
		counter++;
	}

	let finalMarkdown = '';

	// PPT 계열이면 슬라이드 캡처 및 텍스트 추출 수행
	if (file.extension.toLowerCase().startsWith('ppt')) {
		// 미디어 폴더 생성
		try {
			await app.vault.createFolder(mediaPath);
		} catch (e) { /* 폴더 기존재 시 무시 */ }

		// 1. 슬라이드 이미지 캡처 (Phantom DOM 사용)
		const phantom = document.body.createDiv();
		phantom.style.position = 'fixed';
		phantom.style.left = '-9999px';
		phantom.style.width = '1280px';

		try {
			const htmlSlides = await pptxToHtml(arrayBuffer, { width: 1280 });
			for (let i = 0; i < htmlSlides.length; i++) {
				phantom.empty();
				const slideHtml = htmlSlides[i];
				if (slideHtml) phantom.innerHTML = slideHtml;

				const canvas = await html2canvas(phantom, {
					width: 1280,
					scale: 1,
					useCORS: true,
					backgroundColor: '#ffffff'
				});

				const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
				if (blob) {
					const slideBuf = await blob.arrayBuffer();
					const slideName = `slide_${i + 1}.png`; // 1-indexed
					const slidePath = `${mediaPath}/${slideName}`;
					await app.vault.createBinary(slidePath, slideBuf);
				}
			}
		} catch (e) {
			console.error('Slide Capture Error:', e);
		} finally {
			phantom.remove();
		}

		// 2. 기존 이미지 추출
		if (ast.attachments && ast.attachments.length > 0) {
			for (const attachment of ast.attachments) {
				if (attachment.type === 'image') {
					const binaryString = window.atob(attachment.data);
					const len = binaryString.length;
					const bytes = new Uint8Array(len);
					for (let j = 0; j < len; j++) bytes[j] = binaryString.charCodeAt(j);

					const imageFilePath = `${mediaPath}/${attachment.name}`;
					try {
						await app.vault.createBinary(imageFilePath, bytes.buffer);
					} catch (e) { /* 기존재 무시 */ }
				}
			}
		}

		// 3. 마크다운 생성
		let currentSlideIndex = 0;
		const buildMarkdown = (node: any): string => {
			let md = '';
			if (node.type === 'slide') {
				currentSlideIndex++;
				md += `\n\n![[${mediaPath}/slide_${currentSlideIndex}.png]]\n\n`;
			}
			if (node.type === 'image') {
				const attachmentName = node.metadata?.attachmentName;
				if (attachmentName) md += `\n\n![[${mediaPath}/${attachmentName}]]\n\n`;
			} else if (node.text) {
				md += node.text;
			}
			if (node.children && Array.isArray(node.children)) {
				for (const child of node.children) buildMarkdown(child);
			}
			if (node.type === 'slide') {
				md += '\n\n---\n\n';
			} else if (node.type === 'paragraph' || node.type === 'heading') {
				md += '\n';
			}
			return md;
		};

		if (ast.content && Array.isArray(ast.content)) {
			for (const rootNode of ast.content) {
				finalMarkdown += buildMarkdown(rootNode);
			}
		} else {
			finalMarkdown = ast.toText();
		}
	} else {
		finalMarkdown = ast.toText();
	}

	// 5. 마크다운 파일 생성
	await app.vault.create(newPath, finalMarkdown.trim());
}
