import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { loadConfig, saveConfig } from './config.js';

const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const OPENAI_CODEX_SCOPES = 'openid profile email offline_access';
const OPENAI_CODEX_ORIGINATOR = 'codex_cli_rs';
const OPENAI_CODEX_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const OPENAI_CODEX_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  email?: string;
}

interface JwtClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id?: string }>;
  email?: string;
  ['https://api.openai.com/auth']?: {
    chatgpt_account_id?: string;
  };
}

export interface OpenAICodexAuthRecord {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
}

interface LoginCallbacks {
  onUrl?: (url: string) => void;
  onStatus?: (status: string) => void;
  waitForManualRedirect?: () => Promise<string>;
}

interface CallbackListener {
  promise: Promise<string>;
  stop: () => void;
}

function decodeJwtClaims(token: string | undefined): JwtClaims | null {
  if (!token) {
    return null;
  }

  const [, payload] = token.split('.');
  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    return null;
  }
}

function extractAccountId(claims: JwtClaims | null): string | undefined {
  if (!claims) {
    return undefined;
  }

  return claims.chatgpt_account_id
    ?? claims['https://api.openai.com/auth']?.chatgpt_account_id
    ?? claims.organizations?.[0]?.id;
}

function extractEmail(tokenResponse: OAuthTokenResponse): string | undefined {
  return tokenResponse.email ?? decodeJwtClaims(tokenResponse.id_token)?.email;
}

function normalizeTokenResponse(tokenResponse: OAuthTokenResponse): OpenAICodexAuthRecord {
  const claims = decodeJwtClaims(tokenResponse.id_token) ?? decodeJwtClaims(tokenResponse.access_token);

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    idToken: tokenResponse.id_token,
    expiresAt: Date.now() + Math.max(60, tokenResponse.expires_in ?? 1800) * 1000,
    accountId: extractAccountId(claims),
    email: extractEmail(tokenResponse),
  };
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function generateState(): string {
  return randomBytes(16).toString('hex');
}

function buildAuthorizationUrl(codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: OPENAI_CODEX_CLIENT_ID,
    redirect_uri: OPENAI_CODEX_REDIRECT_URI,
    scope: OPENAI_CODEX_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    response_type: 'code',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: OPENAI_CODEX_ORIGINATOR,
  });

  return `${OPENAI_CODEX_AUTHORIZE_URL}?${params.toString()}`;
}

async function openBrowser(url: string): Promise<boolean> {
  const platform = process.platform;
  const command = platform === 'darwin'
    ? ['open', url]
    : platform === 'win32'
      ? ['cmd', '/c', 'start', '', url]
      : ['xdg-open', url];

  try {
    const proc = Bun.spawn(command, {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

function extractAuthorizationCode(input: string, expectedState: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Paste the full redirected localhost URL from your browser.');
  }

  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    throw new Error('Paste the full redirected localhost URL, not just part of it.');
  }

  const url = new URL(trimmed);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (url.pathname !== '/auth/callback' || !code) {
    throw new Error('Redirect URL is missing the OAuth code.');
  }

  if (state !== expectedState) {
    throw new Error('Redirect URL state does not match the login session.');
  }

  return code;
}

function createCallbackListener(expectedState: string): CallbackListener {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const stop = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    if (server) {
      server.stop(true);
      server = null;
    }
  };

  const promise = new Promise<string>((resolve, reject) => {
    let settled = false;
    try {
      server = Bun.serve({
        port: 1455,
        hostname: '127.0.0.1',
        fetch(request) {
          const url = new URL(request.url);
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');

          if (url.pathname !== '/auth/callback') {
            return new Response('Not found', { status: 404 });
          }

          if (!code || state !== expectedState) {
            return new Response('<html><body><h1>Dexter login failed</h1><p>You can close this tab.</p></body></html>', {
              status: 400,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }

          settled = true;
          stop();
          resolve(code);

          return new Response('<html><body><h1>Dexter login complete</h1><p>You can return to the terminal.</p></body></html>', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        },
      });
    } catch (error) {
      reject(new Error(`Failed to start OpenAI callback server on localhost:1455: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      stop();
      reject(new Error('OpenAI Codex OAuth login timed out.'));
    }, OPENAI_CODEX_LOGIN_TIMEOUT_MS);
  });

  return { promise, stop };
}

async function exchangeCodeForTokens(code: string, verifier: string): Promise<OpenAICodexAuthRecord> {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_CLIENT_ID,
      code,
      redirect_uri: OPENAI_CODEX_REDIRECT_URI,
      code_verifier: verifier,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`OpenAI OAuth token exchange failed (${response.status} ${response.statusText})`);
  }

  return normalizeTokenResponse(await response.json() as OAuthTokenResponse);
}

async function refreshAccessToken(record: OpenAICodexAuthRecord): Promise<OpenAICodexAuthRecord> {
  if (!record.refreshToken) {
    throw new Error('OpenAI Codex OAuth refresh token is missing. Please sign in again.');
  }

  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: OPENAI_CODEX_CLIENT_ID,
      refresh_token: record.refreshToken,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`OpenAI OAuth token refresh failed (${response.status} ${response.statusText})`);
  }

  const refreshed = normalizeTokenResponse(await response.json() as OAuthTokenResponse);
  return {
    ...record,
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? record.refreshToken,
  };
}

export function getStoredOpenAICodexAuth(): OpenAICodexAuthRecord | undefined {
  const value = loadConfig().credentials?.oauth?.['openai-codex'];
  return value as OpenAICodexAuthRecord | undefined;
}

export function hasStoredOpenAICodexAuth(): boolean {
  const auth = getStoredOpenAICodexAuth();
  return Boolean(auth?.accessToken);
}

export function saveOpenAICodexAuth(record: OpenAICodexAuthRecord): boolean {
  const config = loadConfig();
  config.credentials ??= {};
  config.credentials.oauth ??= {};
  config.credentials.oauth['openai-codex'] = record;
  return saveConfig(config);
}

export async function getValidOpenAICodexAuth(): Promise<OpenAICodexAuthRecord> {
  const existing = getStoredOpenAICodexAuth();
  if (!existing) {
    throw new Error('OpenAI Codex OAuth credentials not found. Select the OpenAI Codex provider and sign in first.');
  }

  if (Date.now() < existing.expiresAt - OPENAI_CODEX_REFRESH_BUFFER_MS) {
    return existing;
  }

  const refreshed = await refreshAccessToken(existing);
  if (!saveOpenAICodexAuth(refreshed)) {
    throw new Error('Failed to persist refreshed OpenAI Codex credentials.');
  }

  return refreshed;
}

export async function loginOpenAICodex(callbacks: LoginCallbacks = {}): Promise<OpenAICodexAuthRecord> {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = generateState();
  const url = buildAuthorizationUrl(challenge, state);
  const callbackListener = createCallbackListener(state);
  const manualRedirectPromise = callbacks.waitForManualRedirect
    ? callbacks.waitForManualRedirect().then((input) => extractAuthorizationCode(input, state))
    : new Promise<string>(() => undefined);

  callbacks.onUrl?.(url);
  callbacks.onStatus?.('Waiting for OpenAI authentication callback on http://localhost:1455/auth/callback or a pasted redirect URL');
  const opened = await openBrowser(url);
  if (!opened) {
    callbacks.onStatus?.('Open the login URL manually in your browser to continue.');
  }

  const code = await Promise.race([callbackListener.promise, manualRedirectPromise]);
  callbackListener.stop();
  callbacks.onStatus?.('Exchanging authorization code for OpenAI credentials...');
  return exchangeCodeForTokens(code, verifier);
}

export function getOpenAICodexRequestHeaders(record: OpenAICodexAuthRecord): Record<string, string> {
  return {
    Authorization: `Bearer ${record.accessToken}`,
    originator: OPENAI_CODEX_ORIGINATOR,
    'OpenAI-Beta': 'responses=experimental',
    'User-Agent': `dexter-ts/${process.env.npm_package_version ?? 'dev'}`,
    ...(record.accountId ? { 'ChatGPT-Account-Id': record.accountId } : {}),
    session_id: randomUUID(),
  };
}
