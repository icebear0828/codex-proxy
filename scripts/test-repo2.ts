import { loadConfig, loadFingerprint } from '../src/config.js';
import { ProxyClient } from '../src/proxy/client.js';
import { AuthManager } from '../src/auth/manager.js';
async function main() {
  loadConfig(); loadFingerprint();
  const am = new AuthManager();
  const tk = await am.getToken();
  if (!tk) { console.log('no auth'); return; }
  const c = new ProxyClient(tk, am.getAccountId());
  const mid = '6993d698c6a48190bcc7ed131c5f34b4';
  const tests = [
    'github/torvalds/linux',
    'github/facebook/react',
    'torvalds/linux',
  ];
  for (const repo of tests) {
    console.log('repos: [' + repo + ']');
    const r = await c.post('wham/environments', { machine_id: mid, repos: [repo], label: 'test' });
    console.log(r.status, JSON.stringify(r.body).slice(0, 400));
    console.log('');
  }
}
main();
