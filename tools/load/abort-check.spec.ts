import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { abortCheckBody, judgeAbortCheck, runAbortCheck, type AbortVerdict } from './abort-check.ts';

function counts(before: number, atAbort: number, oneSecondAfter: number, threeSecondsAfter: number) {
  return {
    before,
    atAbort,
    oneSecondAfter,
    threeSecondsAfter,
  };
}

test('the verdict compares the running count after the abort with the count before sending', () => {
  expect(judgeAbortCheck(counts(0, 20, 0, 0))).toBe('reach');
  expect(judgeAbortCheck(counts(2, 22, 3, 1))).toBe('reach');
  expect(judgeAbortCheck(counts(0, 20, 20, 20))).toBe('do not reach');
  expect(judgeAbortCheck(counts(0, 20, 12, 8))).toBe('unclear');
  expect(judgeAbortCheck(counts(0, 0, 0, 0))).toBe('unclear');
  expect(judgeAbortCheck(counts(3, 8, 3, 3))).toBe('unclear');
});

test('each generation asks for a long answer of at most 600 tokens', () => {
  const body = JSON.parse(abortCheckBody('google/gemma-4-26B-A4B-it'));
  expect(body).toMatchObject({ model: 'google/gemma-4-26B-A4B-it', max_tokens: 600 });
  expect(body.messages).toHaveLength(1);
});

async function fakeVllm(doesStopOnClose: boolean): Promise<{ server: Server; baseUrl: string }> {
  let running = 0;
  const server = createServer((request, response) => {
    if (request.url === '/metrics') {
      response.end(`vllm:num_requests_running{engine="0",model_name="m"} ${running}\n`);
      return;
    }
    request.resume();
    running += 1;
    let isDone = false;
    const finish = () => {
      if (!isDone) {
        isDone = true;
        running -= 1;
      }
    };
    const generation = setTimeout(() => {
      finish();
      response.end('{}');
    }, 10000);
    response.on('close', () => {
      if (doesStopOnClose) {
        clearTimeout(generation);
        finish();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function checkAgainst(doesStopOnClose: boolean): Promise<{ verdict: AbortVerdict; lines: string[] }> {
  const { server, baseUrl } = await fakeVllm(doesStopOnClose);
  const lines: string[] = [];
  try {
    const verdict = await runAbortCheck({
      llm: {
        apiKey: 'k',
        model: 'm',
        url: `${baseUrl}/v1/chat/completions`,
      },
      metricsUrl: `${baseUrl}/metrics`,
      fetchText: async (url, signal) => (await fetch(url, { signal })).text(),
      log: (line) => lines.push(line),
      timing: {
        abortAfterMs: 300,
        firstReadAfterMs: 200,
        secondReadAfterMs: 400,
      },
    });
    return { verdict, lines };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('against an endpoint that stops on close, the check says aborts reach it', async () => {
  const { verdict, lines } = await checkAgainst(true);
  expect(verdict).toBe('reach');
  expect(lines[0]).toMatch(/^before sending .*: 0 running$/);
  expect(lines[1]).toMatch(/^just before the abort .*: 20 running$/);
  expect(lines[3]).toMatch(/: 0 running$/);
  expect(lines[4]).toBe('Aborts reach vLLM: the aborted generations stopped.');
});

test('against an endpoint that keeps generating, the check says aborts do not reach it', async () => {
  const { verdict, lines } = await checkAgainst(false);
  expect(verdict).toBe('do not reach');
  expect(lines[3]).toMatch(/: 20 running$/);
});

test('against an endpoint without vLLM metrics, the check stops before sending, naming --metrics-url', async () => {
  const server = createServer((_request, response) => response.writeHead(404).end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const checking = runAbortCheck({
      llm: {
        apiKey: 'k',
        model: 'm',
        url: `${baseUrl}/v1/chat/completions`,
      },
      metricsUrl: `${baseUrl}/metrics`,
      fetchText: async (url, signal) => {
        const response = await fetch(url, { signal });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.text();
      },
      log: () => undefined,
    });
    await expect(checking).rejects.toThrow(`No vLLM metrics at ${baseUrl}/metrics (HTTP 404). Point --metrics-url`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
