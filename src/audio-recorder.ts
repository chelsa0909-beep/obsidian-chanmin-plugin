/**
 * 음성 녹음 모듈
 * MediaRecorder API를 사용하여 마이크 녹음을 수행합니다.
 */

export class AudioRecorder {
	private mediaRecorder: MediaRecorder | null = null;
	private audioChunks: Blob[] = [];
	private stream: MediaStream | null = null;
	private startTime: number = 0;
	private timerInterval: number | null = null;
	private _isRecording: boolean = false;
	private _duration: number = 0; // 초 단위
	private onTickCallback: ((seconds: number) => void) | null = null;

	get isRecording(): boolean {
		return this._isRecording;
	}

	get duration(): number {
		return this._duration;
	}

	/**
	 * 녹음 중 매 초마다 호출될 콜백 등록
	 */
	onTick(callback: (seconds: number) => void): void {
		this.onTickCallback = callback;
	}

	/**
	 * 마이크 권한을 요청하고 녹음을 시작합니다.
	 */
	async startRecording(): Promise<void> {
		if (this._isRecording) {
			throw new Error('이미 녹음 중입니다.');
		}

		// 마이크 권한 요청
		this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

		// MediaRecorder 생성
		const mimeType = this.getSupportedMimeType();
		this.mediaRecorder = new MediaRecorder(this.stream, {
			mimeType: mimeType,
		});

		this.audioChunks = [];

		this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
			if (event.data.size > 0) {
				this.audioChunks.push(event.data);
			}
		};

		// 250ms 간격으로 데이터 수집
		this.mediaRecorder.start(250);
		this._isRecording = true;
		this.startTime = Date.now();
		this._duration = 0;

		// 1초마다 경과 시간 업데이트
		this.timerInterval = window.setInterval(() => {
			this._duration = Math.floor((Date.now() - this.startTime) / 1000);
			if (this.onTickCallback) {
				this.onTickCallback(this._duration);
			}
		}, 1000);
	}

	/**
	 * 녹음을 중지하고 결과 Blob을 반환합니다.
	 */
	async stopRecording(): Promise<Blob> {
		return new Promise((resolve, reject) => {
			if (!this.mediaRecorder || !this._isRecording) {
				reject(new Error('녹음 중이 아닙니다.'));
				return;
			}

			this.mediaRecorder.onstop = () => {
				const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
				const blob = new Blob(this.audioChunks, { type: mimeType });
				this.cleanup();
				resolve(blob);
			};

			this.mediaRecorder.onerror = (event) => {
				this.cleanup();
				reject(new Error(`녹음 오류: ${event}`));
			};

			this.mediaRecorder.stop();
		});
	}

	/**
	 * 녹음을 취소합니다 (데이터 버림).
	 */
	cancelRecording(): void {
		if (this.mediaRecorder && this._isRecording) {
			this.mediaRecorder.stop();
		}
		this.cleanup();
	}

	/**
	 * 경과 시간을 MM:SS 포맷으로 반환합니다.
	 */
	formatDuration(seconds?: number): string {
		const s = seconds ?? this._duration;
		const min = Math.floor(s / 60).toString().padStart(2, '0');
		const sec = (s % 60).toString().padStart(2, '0');
		return `${min}:${sec}`;
	}

	/**
	 * 지원되는 MIME 타입을 반환합니다.
	 */
	private getSupportedMimeType(): string {
		const types = [
			'audio/webm;codecs=opus',
			'audio/webm',
			'audio/ogg;codecs=opus',
			'audio/mp4',
		];

		for (const type of types) {
			if (MediaRecorder.isTypeSupported(type)) {
				return type;
			}
		}

		// fallback
		return 'audio/webm';
	}

	/**
	 * 리소스 정리
	 */
	private cleanup(): void {
		if (this.timerInterval !== null) {
			window.clearInterval(this.timerInterval);
			this.timerInterval = null;
		}

		if (this.stream) {
			this.stream.getTracks().forEach(track => track.stop());
			this.stream = null;
		}

		this._isRecording = false;
		this.mediaRecorder = null;
		this.audioChunks = [];
	}
}
