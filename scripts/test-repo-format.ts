import { loadConfig, loadFingerprint } from '../src/config.js';
import { ProxyClient } from '../src/proxy/client.js';
import { AuthManager } from '../src/auth/manager.js';

async function main() {
  loadConfig(); loadFingerprint();
  const am = new AuthManager();
  const tk = await am.getToken();
  if (!tk) { console.log('Not auth'); return; }
  const c = new ProxyClient(tk, am.getAccountId());
  const mid = '6993d698c6a48190bcc7ed131c5f34b4';

  const formats = [
    'github:octocat/Hello-World',
    'octocat/Hello-World',
    'github/octocat/hello-world',
    'https://github.com/octocat/Hello-World',
  ];

  for (const repo of formats) {
    console.log('--- repos: ["' + repo + '"] ---');
    const r = await c.post('wham/environments', { machine_id: mid, repos: [repo], label: 'test' });
    console.log(r.status, JSON.stringify(r.body).slice(0, 300));
    console.log('');
  }
}
main().catch(e => console.error(e));
