import { loadConfig, loadFingerprint } from '../src/config.js';
import { ProxyClient } from '../src/proxy/client.js';
import { AuthManager } from '../src/auth/manager.js';

async function main() {
  loadConfig(); loadFingerprint();
  const am = new AuthManager();
  const tk = await am.getToken();
  if (!tk) { console.log('Not authenticated'); return; }
  const c = new ProxyClient(tk, am.getAccountId());

  // Step 1: Get upload URL for a worktree snapshot
  console.log('=== Step 1: POST /wham/worktree_snapshots/upload_url ===');
  const r1 = await c.post('wham/worktree_snapshots/upload_url', {
    file_name: 'snapshot.tar.gz',
    file_size: 100,
    repo_name: 'workspace',
  });
  console.log('Status:', r1.status);
  console.log('Body:', JSON.stringify(r1.body).slice(0, 800));

  if (!r1.ok) {
    console.log('Failed to get upload URL');
    return;
  }

  const body1 = r1.body as { upload_url?: string; file_id?: string; status?: string };
  console.log('Upload URL:', body1.upload_url?.slice(0, 100));
  console.log('File ID:', body1.file_id);

  // Step 2: Upload a minimal tar.gz (empty)
  if (body1.upload_url) {
    console.log('\n=== Step 2: Upload minimal snapshot ===');
    // Create a minimal gzip file (empty gzip)
    const emptyGzip = Buffer.from([
      0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]);

    const uploadRes = await fetch(body1.upload_url, {
      method: 'PUT',
      body: emptyGzip,
      headers: { 'Content-Type': 'application/gzip' },
    });
    console.log('Upload status:', uploadRes.status);
    const uploadText = await uploadRes.text();
    console.log('Upload response:', uploadText.slice(0, 300));
  }

  // Step 3: Finish upload
  if (body1.file_id) {
    console.log('\n=== Step 3: POST /wham/worktree_snapshots/finish_upload ===');
    const r3 = await c.post('wham/worktree_snapshots/finish_upload', {
      file_id: body1.file_id,
    });
    console.log('Status:', r3.status);
    console.log('Body:', JSON.stringify(r3.body).slice(0, 800));

    // Step 4: Create a task with this file_id
    console.log('\n=== Step 4: Create task with valid file_id ===');
    const r4 = await c.post('wham/tasks', {
      new_task: {
        branch: 'main',
        environment_id: null,
        environment: {
          repos: [{
            kind: 'local_worktree',
            name: 'workspace',
            remotes: {},
            commit_sha: '0000000000000000000000000000000000000000',
            branch: 'main',
            file_id: body1.file_id,
          }],
        },
        run_environment_in_qa_mode: false,
      },
      input_items: [
        { type: 'message', role: 'user', content: [{ content_type: 'text', text: 'Say hello in one sentence.' }] }
      ],
      model: 'gpt-5.1-codex-mini',
      developer_instructions: null,
      base_instructions: null,
      personality: null,
      approval_policy: 'never',
      sandbox: 'workspace-write',
      ephemeral: null,
    });
    console.log('Task status:', r4.status);
    console.log('Task body:', JSON.stringify(r4.body).slice(0, 600));

    // Step 5: Poll for result
    const taskBody = r4.body as { task?: { id?: string; current_turn_id?: string } };
    if (r4.ok && taskBody?.task?.id) {
      const taskId = taskBody.task.id;
      const turnId = taskBody.task.current_turn_id!;
      console.log('\n=== Step 5: Poll for turn completion ===');
      console.log('Task:', taskId);
      console.log('Turn:', turnId);

      for (let i = 0; i < 30; i++) {
        await new Promise(res => setTimeout(res, 3000));
        const tr = await c.get(`wham/tasks/${encodeURIComponent(taskId)}/turns/${encodeURIComponent(turnId)}`);
        const td = tr.body as { turn?: { turn_status?: string; output_items?: unknown[]; error?: unknown } };
        const status = td?.turn?.turn_status;
        console.log(`  Poll ${i}: status=${status}`);
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          if (td?.turn?.error) console.log('  Error:', JSON.stringify(td.turn.error));
          if (td?.turn?.output_items) console.log('  Output:', JSON.stringify(td.turn.output_items).slice(0, 500));
          break;
        }
      }
    }
  }
}

main().catch(e => console.error(e));
