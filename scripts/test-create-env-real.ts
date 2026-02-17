import { loadConfig, loadFingerprint } from '../src/config.js';
import { ProxyClient } from '../src/proxy/client.js';
import { AuthManager } from '../src/auth/manager.js';
import { buildHeadersWithContentType } from '../src/fingerprint/manager.js';

async function main() {
  loadConfig(); loadFingerprint();
  const am = new AuthManager();
  const tk = await am.getToken();
  if (!tk) { console.log('Not authenticated'); return; }
  const aid = am.getAccountId();
  const c = new ProxyClient(tk, aid);
  const base = 'https://chatgpt.com/backend-api';

  const machineId = '6993d698c6a48190bcc7ed131c5f34b4';

  // Test 1: Create environment with a real public GitHub repo
  console.log('=== Test 1: POST /wham/environments with real repo ===');
  try {
    const r = await c.post('wham/environments', {
      machine_id: machineId,
      repos: [{ provider: 'github', owner: 'octocat', name: 'Hello-World' }],
      label: 'test-env',
    });
    console.log(r.status, JSON.stringify(r.body).slice(0, 600));
  } catch (e: unknown) { console.log('Error:', (e as Error).message); }

  // Test 2: Different repos format
  console.log('\n=== Test 2: repos as string array ===');
  try {
    const r = await c.post('wham/environments', {
      machine_id: machineId,
      repos: ['octocat/Hello-World'],
      label: 'test-env-2',
    });
    console.log(r.status, JSON.stringify(r.body).slice(0, 600));
  } catch (e: unknown) { console.log('Error:', (e as Error).message); }

  // Test 3: Minimal environment creation
  console.log('\n=== Test 3: minimal env ===');
  try {
    const r = await c.post('wham/environments', {
      machine_id: machineId,
    });
    console.log(r.status, JSON.stringify(r.body).slice(0, 600));
  } catch (e: unknown) { console.log('Error:', (e as Error).message); }

  // Test 4: Create environment via different endpoint
  console.log('\n=== Test 4: POST /wham/environments/create ===');
  try {
    const r = await c.post('wham/environments/create', {
      machine_id: machineId,
      repos: ['octocat/Hello-World'],
    });
    console.log(r.status, JSON.stringify(r.body).slice(0, 600));
  } catch (e: unknown) { console.log('Error:', (e as Error).message); }

  // Test 5: Try the webview approach - look at how the webview creates environments
  // The webview uses POST /wham/tasks with environment embedded
  // Let me try creating a task without environment_id but with DELETE of the key
  console.log('\n=== Test 5: POST /wham/tasks with environment_id deleted (raw fetch) ===');
  try {
    const body: Record<string, unknown> = {
      new_task: {
        branch: 'main',
        run_environment_in_qa_mode: false,
      },
      input_items: [{ type: 'message', role: 'user', content: [{ content_type: 'text', text: 'Say hello' }] }],
      model: 'gpt-5.1-codex-mini',
      developer_instructions: null,
      base_instructions: null,
      personality: null,
      approval_policy: 'never',
      sandbox: 'workspace-write',
      ephemeral: null,
    };
    // Verify environment_id is truly not in the JSON
    console.log('Body keys:', Object.keys(body.new_task as object));
    const res = await fetch(`${base}/wham/tasks`, {
      method: 'POST',
      headers: buildHeadersWithContentType(tk, aid),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    console.log(res.status, JSON.stringify(data).slice(0, 600));
  } catch (e: unknown) { console.log('Error:', (e as Error).message); }

  // Test 6: What about follow_up without new_task?
  console.log('\n=== Test 6: POST /wham/tasks without new_task (just input_items) ===');
  try {
    const body = {
      input_items: [{ type: 'message', role: 'user', content: [{ content_type: 'text', text: 'Say hello' }] }],
      model: 'gpt-5.1-codex-mini',
    };
    const res = await fetch(`${base}/wham/tasks`, {
      method: 'POST',
      headers: buildHeadersWithContentType(tk, aid),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    console.log(res.status, JSON.stringify(data).slice(0, 600));
  } catch (e: unknown) { console.log('Error:', (e as Error).message); }

  // Test 7: Maybe the issue is that we need to send a requestBody wrapper?
  // The webview uses: CodexRequest.safePost("/wham/tasks", { requestBody: {...} })
  console.log('\n=== Test 7: POST /wham/tasks with requestBody wrapper ===');
  try {
    const body = {
      requestBody: {
        new_task: {
          branch: 'main',
          run_environment_in_qa_mode: false,
        },
        input_items: [{ type: 'message', role: 'user', content: [{ content_type: 'text', text: 'Say hello' }] }],
        model: 'gpt-5.1-codex-mini',
      },
    };
    const res = await fetch(`${base}/wham/tasks`, {
      method: 'POST',
      headers: buildHeadersWithContentType(tk, aid),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    console.log(res.status, JSON.stringify(data).slice(0, 600));
  } catch (e: unknown) { console.log('Error:', (e as Error).message); }
}

main().catch(e => console.error(e));
