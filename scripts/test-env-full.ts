import { loadConfig, loadFingerprint } from '../src/config.js';
import { ProxyClient } from '../src/proxy/client.js';
import { AuthManager } from '../src/auth/manager.js';
import { buildHeaders, buildHeadersWithContentType } from '../src/fingerprint/manager.js';

async function main() {
  loadConfig(); loadFingerprint();
  const am = new AuthManager();
  const tk = await am.getToken();
  if (!tk) { console.log('Not authenticated'); return; }
  const aid = am.getAccountId();
  const c = new ProxyClient(tk, aid);
  const base = 'https://chatgpt.com/backend-api';

  // Try all possible environment-related endpoints
  const endpoints = [
    { method: 'GET', path: 'wham/environments' },
    { method: 'GET', path: 'wham/machines' },
    { method: 'GET', path: 'wham/accounts/check' },
    { method: 'GET', path: 'wham/usage' },
    { method: 'GET', path: 'wham/tasks' },
    // Codex CLI endpoints
    { method: 'GET', path: 'api/codex/environments' },
    // Try to see if there's a way to check features
    { method: 'GET', path: 'wham/features' },
    { method: 'GET', path: 'wham/config' },
    // Try without environment at all — use ephemeral
    { method: 'POST', path: 'wham/tasks', body: {
      new_task: { branch: 'main', environment_id: null, run_environment_in_qa_mode: false },
      input_items: [{ type: 'message', role: 'user', content: [{ content_type: 'text', text: 'Say hi' }] }],
      model: 'gpt-5.1-codex-mini',
      ephemeral: true,
    }},
    // Try with ephemeral flag and no environment
    { method: 'POST', path: 'wham/tasks', body: {
      new_task: { branch: 'main' },
      input_items: [{ type: 'message', role: 'user', content: [{ content_type: 'text', text: 'Say hi' }] }],
      model: 'gpt-5.1-codex-mini',
      ephemeral: true,
      approval_policy: 'never',
      sandbox: 'workspace-write',
    }},
  ];

  for (const ep of endpoints) {
    console.log(`\n=== ${ep.method} /${ep.path} ===`);
    try {
      let res: Response;
      if (ep.method === 'POST') {
        res = await fetch(`${base}/${ep.path}`, {
          method: 'POST',
          headers: buildHeadersWithContentType(tk, aid),
          body: JSON.stringify(ep.body),
        });
      } else {
        res = await fetch(`${base}/${ep.path}`, {
          headers: buildHeaders(tk, aid),
        });
      }
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) {
        const data = await res.json();
        console.log(res.status, JSON.stringify(data).slice(0, 600));
      } else {
        const text = await res.text();
        console.log(res.status, text.slice(0, 300));
      }
    } catch (e: unknown) {
      console.log('Error:', (e as Error).message);
    }
  }

  // Also try listing existing tasks to see if any have environment info
  console.log('\n=== GET /wham/tasks (list existing tasks) ===');
  try {
    const r = await fetch(`${base}/wham/tasks`, {
      headers: buildHeaders(tk, aid),
    });
    const data = await r.json() as { items?: Array<{ id?: string; task_status_display?: unknown }> };
    console.log(r.status);
    if (data.items) {
      console.log('Total tasks:', data.items.length);
      for (const t of data.items.slice(0, 3)) {
        console.log('  Task:', t.id, JSON.stringify(t.task_status_display).slice(0, 200));
      }
    } else {
      console.log(JSON.stringify(data).slice(0, 400));
    }
  } catch (e: unknown) {
    console.log('Error:', (e as Error).message);
  }

  // Check a specific task to see its environment info
  console.log('\n=== Check a recent task for environment details ===');
  try {
    const r = await fetch(`${base}/wham/tasks`, {
      headers: buildHeaders(tk, aid),
    });
    const data = await r.json() as { items?: Array<{ id?: string }> };
    if (data.items && data.items.length > 0) {
      const taskId = data.items[0].id!;
      const tr = await fetch(`${base}/wham/tasks/${encodeURIComponent(taskId)}`, {
        headers: buildHeaders(tk, aid),
      });
      const td = await tr.json();
      console.log('Task detail:', JSON.stringify(td).slice(0, 1000));
    }
  } catch (e: unknown) {
    console.log('Error:', (e as Error).message);
  }
}

main().catch(e => console.error(e));
