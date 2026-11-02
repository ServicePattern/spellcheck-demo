import express, { type RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LLMRequestKind } from '../src/assistant/types.ts';
import { createOpenAIChatClient } from './openai-chat-client.ts';

const isDev = process.argv.includes('--dev');

if (isDev) {
  process.loadEnvFile('.env');
}

const PORT = Number(process.env.PORT ?? 8787);
const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));
const LLM_TIMEOUT_MS = 20000;

const llmClient = createOpenAIChatClient(requireEnv('LLM_API_KEY'), requireEnv('MODEL'), requireEnv('LLM_URL'));
const credentials = Buffer.from(`${requireEnv('BASIC_AUTH_USER')}:${requireEnv('BASIC_AUTH_PASSWORD')}`);

const app = express();

app.use((request, response, next) => {
  const given = Buffer.from((request.headers.authorization ?? '').replace(/^Basic /, ''), 'base64');
  if (given.length === credentials.length && timingSafeEqual(given, credentials)) {
    next();
    return;
  }
  response.set('WWW-Authenticate', 'Basic realm="SpellCheckingPrototype"').sendStatus(401);
});

app.use(express.json({ limit: '1mb' }));
app.post('/api/autocorrection', forwardToLLM('spell-check'));
app.post('/api/autocompletion', forwardToLLM('auto-completion'));

const httpServer = app.listen(PORT, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${PORT}, serving ${isDev ? 'the source with hot reload' : DIST_DIR}`);
});

if (isDev) {
  await serveSourceWithHotReload(httpServer);
} else {
  serveBuiltPage();
}

async function serveSourceWithHotReload(server: Server): Promise<void> {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, ws: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
}

function serveBuiltPage(): void {
  app.use(express.static(DIST_DIR));
  app.get('/{*path}', (_request, response) => {
    response.sendFile(join(DIST_DIR, 'index.html'));
  });
}

function forwardToLLM(requestKind: LLMRequestKind): RequestHandler {
  return async (request, response) => {
    const userMessage = (request.body as { userMessage?: unknown } | undefined)?.userMessage;
    if (typeof userMessage !== 'string') {
      response.status(400).json({ error: 'body must be {"userMessage": "..."}' });
      return;
    }
    const startedAt = performance.now();
    const result = await llmClient.ask(userMessage, AbortSignal.timeout(LLM_TIMEOUT_MS), requestKind);
    console.log(`${requestKind}: ${'error' in result ? result.error : 'answered'} in ${Math.round(performance.now() - startedAt)} ms`);
    response.status('error' in result ? 502 : 200).json(result);
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. Put it in .env (see .env.example).`);
    process.exit(1);
  }
  return value;
}
