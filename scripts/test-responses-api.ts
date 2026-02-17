import { loadConfig, loadFingerprint } from '../src/config.js';
import { AuthManager } from '../src/auth/manager.js';
import { buildHeadersWithContentType } from '../src/fingerprint/manager.js';

async function main() {
  loadConfig(); loadFingerprint();
  const am = new AuthManager();
  const tk = await am.getToken();
  if (!tk) { console.log('no auth token'); return; }
  const aid = am.getAccountId();

  const base = 'https://chatgpt.com/backend-api/codex';
  const hdrs = buildHeadersWithContentType(tk, aid);

  // Test 1: non-streaming
  console.log('=== Test 1: POST /codex/responses (non-streaming) ===');
  try {
    const r = await fetch(base + '/responses', {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({
        model: 'gpt-5.1-codex-mini',
        instructions: 'You are a helpful assistant.',
        input: [{ role: 'user', content: 'Say hello in one sentence.' }],
        stream: false,
        store: false,
      }),
    });
    console.log('Status:', r.status, r.statusText);
    const ct = r.headers.get('content-type') || '';
    console.log('Content-Type:', ct);
    if (ct.includes('json')) {
      const j = await r.json();
      console.log('Body:', JSON.stringify(j, null, 2).slice(0, 3000));
    } else {
      const t = await r.text();
      console.log('Body:', t.slice(0, 2000));
    }
  } catch (e: any) {
    console.log('Error:', e.message);
  }

  // Test 2: streaming
  console.log('\n=== Test 2: POST /codex/responses (streaming) ===');
  try {
    const streamHdrs = { ...hdrs, 'Accept': 'text/event-stream' };
    const r = await fetch(base + '/responses', {
      method: 'POST',
      headers: streamHdrs,
      body: JSON.stringify({
        model: 'gpt-5.1-codex-mini',
        instructions: 'You are a helpful assistant.',
        input: [{ role: 'user', content: 'Say hello in one sentence.' }],
        stream: true,
        store: false,
      }),
    });
    console.log('Status:', r.status, r.statusText);
    const ct = r.headers.get('content-type') || '';
    console.log('Content-Type:', ct);

    if (r.status !== 200) {
      const t = await r.text();
      console.log('Error body:', t.slice(0, 1000));
    } else {
      const reader = r.body!.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let chunks = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;
        chunks++;
        if (chunks <= 10) {
          console.log(`--- Chunk ${chunks} ---`);
          console.log(chunk.slice(0, 300));
        }
      }
      console.log('\nTotal chunks:', chunks);
      console.log('Full response length:', fullText.length);
      // Show some events
      const events = fullText.split('\n\n').filter(e => e.trim());
      console.log('Total SSE events:', events.length);
      // Show last few events
      const last5 = events.slice(-5);
      console.log('\nLast 5 events:');
      for (const ev of last5) {
        console.log(ev.slice(0, 300));
        console.log('---');
      }
    }
  } catch (e: any) {
    console.log('Error:', e.message);
  }
}

main();
