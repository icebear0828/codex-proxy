import { loadConfig, loadFingerprint } from '../src/config.js';
import { ProxyClient } from '../src/proxy/client.js';
import { AuthManager } from '../src/auth/manager.js';

async function main() {
  loadConfig(); loadFingerprint();
  const am = new AuthManager();
  const tk = await am.getToken();
  if (!tk) { console.log('Not auth'); return; }
  const c = new ProxyClient(tk, am.getAccountId());

  // Create environment: github/octocat/Hello-World
  console.log('=== Create env ===');
  const r = await c.post('wham/environments', {
    machine_id: '6993d698c6a48190bcc7ed131c5f34b4',
    repos: ['github/octocat/Hello-World'],
    label: 'proxy-env',
  });
  console.log(r.status, JSON.stringify(r.body).slice(0, 800));

  if (r.ok) {
    const env = r.body as { environment_id?: string; id?: string };
    const envId = env.environment_id || env.id;
    console.log('Environment ID:', envId);

    if (envId) {
      // Create task with this environment
      console.log('\n=== Create task with env ===');
      const tr = await c.post('wham/tasks', {
        new_task: {
          branch: 'main',
          environment_id: envId,
          run_environment_in_qa_mode: false,
        },
        input_items: [{ type: 'message', role: 'user', content: [{ content_type: 'text', text: 'Say hello in one sentence.' }] }],
        model: 'gpt-5.1-codex-mini',
        developer_instructions: null,
        base_instructions: null,
        personality: null,
        approval_policy: 'never',
        sandbox: 'workspace-write',
        ephemeral: null,
      });
      console.log(tr.status, JSON.stringify(tr.body).slice(0, 800));

      const taskBody = tr.body as { task?: { id?: string; current_turn_id?: string } };
      if (tr.ok && taskBody?.task?.id) {
        const taskId = taskBody.task.id;
        const turnId = taskBody.task.current_turn_id;
        console.log('\nPolling...');
        for (let i = 0; i < 60; i++) {
          await new Promise(res => setTimeout(res, 3000));
          const poll = await c.get(
            'wham/tasks/' + encodeURIComponent(taskId) + '/turns/' + encodeURIComponent(turnId!)
          );
          const pd = poll.body as { turn?: { turn_status?: string; output_items?: unknown[]; error?: unknown } };
          const st = pd?.turn?.turn_status;
          console.log('  ' + i + ': ' + st);
          if (st === 'completed' || st === 'failed' || st === 'cancelled') {
            if (pd?.turn?.error) console.log('  Error:', JSON.stringify(pd.turn.error));
            if (pd?.turn?.output_items) console.log('  Output:', JSON.stringify(pd.turn.output_items).slice(0, 1000));
            break;
          }
        }
      }
    }
  }

  // Also try listing environments now
  console.log('\n=== List environments ===');
  const le = await c.get('wham/environments');
  console.log(le.status, JSON.stringify(le.body).slice(0, 400));
}
main().catch(e => console.error(e));
