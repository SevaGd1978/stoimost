import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createEisFetch, describeFetchError, extraCaLabels, loadExtraCas, trustedCas } from '../src/eis-tls.js';

test('доверенные CA включают корень и промежуточный сертификат Минцифры', () => {
  const extra = loadExtraCas();
  assert.equal(extra.length, 2);
  const subjects = extra.map((pem) => new X509Certificate(pem).subject);
  assert.ok(subjects.some((s) => s.includes('Russian Trusted Root CA')));
  assert.ok(subjects.some((s) => s.includes('Russian Trusted Sub CA')));
  const labels = extraCaLabels();
  assert.deepEqual(labels, ['Russian Trusted Root CA', 'Russian Trusted Sub CA']);
  const trustedSubjects = trustedCas().map((pem) => new X509Certificate(pem).subject).join('\n');
  assert.match(trustedSubjects, /Russian Trusted Root CA/);
  assert.ok(trustedCas().length > extra.length);
});

test('describeFetchError показывает код причины, а не общее fetch failed', () => {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error('unable to get local issuer certificate'), {
    code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  });
  const text = describeFetchError(err);
  assert.match(text, /UNABLE_TO_GET_ISSUER_CERT_LOCALLY/);
  assert.match(text, /нет доверия к сертификату ЕИС/);
  assert.equal(describeFetchError(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'таймаут');
});

test('клиент ЕИС не отключает проверку TLS', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eis-tls-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '1', '-nodes', '-subj', '/CN=localhost'],
    { stdio: 'ignore' },
  );
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => {
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const fetchImpl = createEisFetch({ timeoutMs: 4000 });
  try {
    await assert.rejects(fetchImpl(`https://127.0.0.1:${port}/`), (err) => {
      const text = describeFetchError(err);
      assert.match(text, /CERT|certificate|сертификат|ALTNAME|SELF_SIGNED|UNABLE_TO/i);
      return true;
    });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
