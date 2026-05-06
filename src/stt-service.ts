import { requestUrl } from 'obsidian';

/**
 * Gemini API를 사용한 음성-텍스트 변환(STT) 모듈
 */

interface GeminiResponse {
	candidates?: Array<{
		content?: {
			parts?: Array<{
				text?: string;
			}>;
		};
	}>;
	error?: {
		message?: string;
		code?: number;
	};
}

/**
 * Gemini API를 사용하여 오디오를 텍스트로 변환합니다.
 * @param apiKey Gemini API 키
 * @param audioBlob 오디오 Blob
 * @param prompt 변환 프롬프트 (선택)
 * @returns 변환된 텍스트
 */
export async function transcribeAudio(
	apiKey: string,
	audioBlob: Blob,
	prompt?: string
): Promise<string> {
	if (!apiKey) {
		throw new Error('Gemini API 키가 설정되지 않았습니다. 플러그인 설정에서 API 키를 입력해주세요.');
	}

	// Blob → base64 변환
	const arrayBuffer = await audioBlob.arrayBuffer();
	const uint8Array = new Uint8Array(arrayBuffer);
	let binaryStr = '';
	for (let i = 0; i < uint8Array.length; i++) {
		binaryStr += String.fromCharCode(uint8Array[i] ?? 0);
	}
	const base64Audio = window.btoa(binaryStr);

	// MIME 타입 결정
	const mimeType = audioBlob.type || 'audio/webm';

	// Gemini API 호출
	const model = 'gemini-2.0-flash';
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

	const defaultPrompt = '이 오디오를 텍스트로 정확하게 변환해주세요. 원본 언어 그대로 받아쓰기를 해주세요. 텍스트만 출력하고 다른 설명은 추가하지 마세요.';

	const requestBody = {
		contents: [{
			parts: [
				{
					text: prompt || defaultPrompt
				},
				{
					inline_data: {
						mime_type: mimeType,
						data: base64Audio
					}
				}
			]
		}],
		generationConfig: {
			temperature: 0.1,
			maxOutputTokens: 8192
		}
	};

	// 재시도 로직 (429 Rate Limit 대응)
	const maxRetries = 3;
	let lastError: Error | null = null;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		if (attempt > 0) {
			// 지수 백오프: 2초, 4초, 8초
			const waitMs = Math.pow(2, attempt) * 1000;
			await new Promise(resolve => setTimeout(resolve, waitMs));
		}

		const response = await requestUrl({
			url: url,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(requestBody),
			throw: false,
		});

		if (response.status === 200) {
			const data = response.json as GeminiResponse;

			if (!data.candidates || data.candidates.length === 0) {
				throw new Error('Gemini API에서 응답을 받지 못했습니다.');
			}

			const text = data.candidates[0]?.content?.parts?.[0]?.text;
			if (!text) {
				throw new Error('Gemini API 응답에 텍스트가 없습니다.');
			}

			return text.trim();
		}

		if (response.status === 429) {
			lastError = new Error('API 사용량 한도 초과 (429). 잠시 후 다시 시도합니다...');
			console.warn(`[STT] Rate limited, retry ${attempt + 1}/${maxRetries}...`);
			continue;
		}

		// 429가 아닌 다른 에러는 즉시 실패
		const errorData = response.json as GeminiResponse;
		const errorMsg = errorData?.error?.message || `HTTP ${response.status}`;
		throw new Error(`Gemini API 오류: ${errorMsg}`);
	}

	// 모든 재시도 실패
	throw new Error('API 사용량 한도를 초과했습니다. 잠시 후 다시 시도해주세요. (무료 Gemini API 키의 분당 요청 제한)');
}
