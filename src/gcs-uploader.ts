import { App, TFile, Notice, TFolder, requestUrl } from 'obsidian';
import * as crypto from 'crypto';

interface ServiceAccountKey {
    type: string;
    project_id: string;
    private_key_id: string;
    private_key: string;
    client_email: string;
    client_id: string;
    auth_uri: string;
    token_uri: string;
}

interface TokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
}

function base64url(input: string | Buffer): string {
    const buf = typeof input === 'string' ? Buffer.from(input) : input;
    return buf.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function createJwt(serviceAccount: ServiceAccountKey): string {
    const now = Math.floor(Date.now() / 1000);
    const header = {
        alg: 'RS256',
        typ: 'JWT',
    };
    const payload = {
        iss: serviceAccount.client_email,
        scope: 'https://www.googleapis.com/auth/devstorage.read_write',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
    };

    const headerB64 = base64url(JSON.stringify(header));
    const payloadB64 = base64url(JSON.stringify(payload));
    const signInput = `${headerB64}.${payloadB64}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signInput);
    const signature = sign.sign(serviceAccount.private_key);

    return `${signInput}.${base64url(signature)}`;
}

async function getAccessToken(serviceAccount: ServiceAccountKey): Promise<string> {
    const jwt = createJwt(serviceAccount);

    const response = await requestUrl({
        url: 'https://oauth2.googleapis.com/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
        throw: false,
    });

    if (response.status !== 200) {
        throw new Error(`Failed to get access token: ${response.status} ${response.text}`);
    }

    const data = response.json as TokenResponse;
    return data.access_token;
}

function getMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const mimeMap: Record<string, string> = {
        'md': 'text/markdown',
        'txt': 'text/plain',
        'html': 'text/html',
        'css': 'text/css',
        'js': 'application/javascript',
        'json': 'application/json',
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'svg': 'image/svg+xml',
        'pdf': 'application/pdf',
        'mp3': 'audio/mpeg',
        'mp4': 'video/mp4',
        'webp': 'image/webp',
        'webm': 'video/webm',
        'zip': 'application/zip',
        'csv': 'text/csv',
        'xml': 'application/xml',
        'yaml': 'application/x-yaml',
        'yml': 'application/x-yaml',
    };
    return mimeMap[ext] ?? 'application/octet-stream';
}

async function uploadFileToGcs(
    accessToken: string,
    bucket: string,
    gcsPath: string,
    content: ArrayBuffer,
    mimeType: string
): Promise<void> {
    const encodedPath = encodeURIComponent(gcsPath);
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodedPath}`;

    const response = await requestUrl({
        url: url,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': mimeType,
        },
        body: content,
        throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Upload failed for ${gcsPath}: ${response.status} ${response.text}`);
    }
}

export async function uploadFilesToGcs(
    app: App,
    bucket: string,
    files: TFile[],
    serviceAccountKeyJson: string,
    gcsPrefix: string,
    basePathToRemove: string = ''
): Promise<{ success: number; failed: number; errors: string[] }> {
    // Parse service account key
    let serviceAccount: ServiceAccountKey;
    try {
        serviceAccount = JSON.parse(serviceAccountKeyJson) as ServiceAccountKey;
    } catch {
        throw new Error('서비스 계정 JSON 키가 올바르지 않습니다. 유효한 JSON인지 확인해주세요.');
    }

    if (!serviceAccount.private_key || !serviceAccount.client_email) {
        throw new Error('서비스 계정 키에 private_key 또는 client_email이 없습니다.');
    }

    // Get access token
    new Notice('🔑 GCS 인증 중...');
    const accessToken = await getAccessToken(serviceAccount);

    if (files.length === 0) {
        throw new Error(`업로드할 파일이 없습니다.`);
    }

    new Notice(`📁 ${files.length}개 파일 업로드 시작...`);

    const result = { success: 0, failed: 0, errors: [] as string[] };

    for (const file of files) {
        try {
            const content = await app.vault.readBinary(file);

            // Calculate relative path for GCS
            let relativePath = file.path;
            if (basePathToRemove && file.path.startsWith(basePathToRemove)) {
                relativePath = file.path.substring(basePathToRemove.length);
                if (relativePath.startsWith('/')) relativePath = relativePath.substring(1);
            }

            const gcsPath = gcsPrefix
                ? `${gcsPrefix}/${relativePath}`
                : relativePath;

            const mimeType = getMimeType(file.name);

            await uploadFileToGcs(accessToken, bucket, gcsPath, content, mimeType);
            result.success++;
            new Notice(`✅ (${result.success}/${files.length}) ${file.name}`);
        } catch (e) {
            result.failed++;
            const errorMsg = e instanceof Error ? e.message : String(e);
            result.errors.push(`${file.name}: ${errorMsg}`);
            new Notice(`❌ ${file.name} 업로드 실패`);
            console.error('GCS Upload Error:', errorMsg);
        }
    }

    return result;
}

export function getMdFilesInFolder(app: App, vaultFolderPath: string): TFile[] {
    // Get files from the specified vault folder
    const folder = app.vault.getAbstractFileByPath(vaultFolderPath);
    if (!folder || !(folder instanceof TFolder)) {
        throw new Error(`폴더를 찾을 수 없습니다: ${vaultFolderPath}`);
    }

    const files: TFile[] = [];
    function collectFiles(f: TFolder) {
        for (const child of f.children) {
            if (child instanceof TFile && child.extension === 'md') {
                files.push(child);
            } else if (child instanceof TFolder) {
                collectFiles(child);
            }
        }
    }
    collectFiles(folder);

    return files;
}
