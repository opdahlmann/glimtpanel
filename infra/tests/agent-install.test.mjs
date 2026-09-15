// Installasjon av agenten på en ren Ubuntu 24.04-server (systemd som PID 1) med kommandoen dashbordet gir, mot en hub
// fra hub-imaget. Binæren lastes ned fra den offentlige GitHub-utgivelsen og verifiseres av install.sh, slik hos kunden.
// Serveren har /.dockerenv, så testen viser også at installasjonen aldri blir en containernode.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Stack, buildImage, docker, exec, http, startMongo, waitFor } from './docker.mjs';

const UBUNTU = `FROM ubuntu:24.04
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus ca-certificates curl procps \\
 && apt-get clean && rm -rf /var/lib/apt/lists/* \\
 && systemctl mask getty.target console-getty.service systemd-udevd.service systemd-udev-trigger.service \\
      systemd-modules-load.service systemd-logind.service systemd-timesyncd.service >/dev/null 2>&1
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
`;
const KEY = 'gp_container_install_test';
const HOSTNAME = 'kunde-test';

describe('agentinstallasjon på en ren Ubuntu-server', () => {
  let stack, hub, server, jwt;

  before(async () => {
    const hubImage = buildImage('hub');
    docker(['build', '--load', '-q', '-t', 'glimt-test-ubuntu:24.04', '-'], { input: UBUNTU });
    stack = new Stack('agent-install');
    await startMongo(stack);
    hub = stack.run('hub', hubImage, {
      port: 8080,
      env: {
        GLIMT_ENV: 'e2e', GLIMT_MONGO_URI: 'mongodb://mongo:27017', GLIMT_MONGO_DB: 'Install', GLIMT_JWT_SECRET: randomBytes(32).toString('hex'),
        GLIMT_DEV_ENROL_KEY: KEY, GLIMT_DEV_USER_EMAIL: 'dev@glimtpanel.local', GLIMT_DEV_USER_PASSWORD: 'Container-test-2026!',
        // /install bytter hub-linjen til denne adressen, så kommandoen trenger ingen --hub.
        GLIMT_HUB_PUBLIC_URL: 'http://hub:8080', GLIMT_INSTALL_URL: 'http://hub:8080/install',
      },
    });
    server = stack.run('server', 'glimt-test-ubuntu:24.04', {
      args: ['--hostname', HOSTNAME, '--privileged', '--cgroupns=host', '-v', '/sys/fs/cgroup:/sys/fs/cgroup:rw', '--tmpfs', '/run', '--tmpfs', '/run/lock', '--tmpfs', '/tmp'],
    });
    await waitFor('huben', async () => (await http(`${hub.url}/readyz`)).status === 200, 90_000);
    await waitFor('systemd på serveren', () => /^(running|degraded)$/.test(exec(server, 'systemctl is-system-running').out), 60_000);
    jwt = await waitFor('dev-token', async () => (await http(`${hub.url}/api/dev/token`, { method: 'POST', json: { email: 'dev@glimtpanel.local' } })).json().accessToken);
  });

  after(() => stack?.stop());

  const journal = () => exec(server, 'journalctl -u glimt-agent --no-pager -o cat').out;
  const unit = (prop) => exec(server, `systemctl show glimt-agent -p ${prop} --value`).out;

  it('kommandoen fra dashbordet laster ned, verifiserer og starter agenten som server', async () => {
    const enrol = await http(`${hub.url}/api/servers/enrol-key`, { method: 'POST', headers: { authorization: `Bearer ${jwt}` }, json: { dockerMode: 'proxy' } });
    assert.equal(enrol.status, 200, enrol.text);
    assert.match(enrol.json().command, /^curl -fsSL http:\/\/hub:8080\/install \| sh -s -- --key \S+ --docker proxy$/, 'kommandoen dashbordet viser');
    assert.equal(exec(server, 'test -f /.dockerenv && echo yes').out, 'yes', 'serveren skal se ut som en container for auto-deteksjonen');

    const install = exec(server, `curl -fsSL http://hub:8080/install | sh -s -- --key ${KEY}`);
    assert.equal(install.status, 0, install.out);
    assert.match(install.out, /Installed \/usr\/local\/bin\/glimt-agent \(glimt-agent \d+\.\d+\.\d+ \(linux\/(amd64|arm64)/);
    assert.equal(exec(server, 'systemctl is-active glimt-agent').out, 'active');
    await waitFor('første snapshot', () => journal().includes('msg="snapshot sent"'), 30_000);
    assert.match(journal(), /kind=server why="set explicitly"/);
  });

  it('huben viser serveren som up', async () => {
    const node = await waitFor('serveren i /api/servers', async () =>
      (await http(`${hub.url}/api/servers`, { headers: { authorization: `Bearer ${jwt}` } })).json().find((s) => s.hostname === HOSTNAME && s.status === 'up'));
    assert.equal(node.kind, 'server');
    assert.equal(node.os.id, 'ubuntu');
  });

  it('miljøfilen er bare for root og enheten er herdet', () => {
    assert.equal(exec(server, 'stat -c "%a %U" /etc/glimt-agent/env').out, '600 root');
    assert.match(exec(server, 'cat /etc/glimt-agent/env').out, /^GLIMT_KIND=server$/m);
    const score = Number(exec(server, 'systemd-analyze security glimt-agent --no-pager | tail -1').out.match(/:\s*([\d.]+)/)?.[1]);
    assert.ok(score > 0 && score < 3, `systemd-analyze security ga ${score}, kravet er under 3`);
    assert.equal(unit('RestartPreventExitStatus'), '2');
  });

  it('en omstart kobler til med det lagrede tokenet', async () => {
    exec(server, 'systemctl restart glimt-agent');
    await waitFor('auth=token etter omstart', () => /msg=connected .*auth=token/.test(journal()), 30_000);
  });

  it('en konfigurasjonsfeil gir failed i stedet for en omstartsløkke', async () => {
    exec(server, 'cp /etc/glimt-agent/env /root/env.bak && sed -i "s|^GLIMT_HUB=.*|GLIMT_HUB=|" /etc/glimt-agent/env');
    exec(server, 'systemctl restart glimt-agent');
    await waitFor('failed', () => unit('ActiveState') === 'failed', 20_000);
    await sleep(7_000); // RestartSec=5: en omstart ville ha skjedd nå
    assert.equal(unit('ActiveState'), 'failed');
    assert.equal(unit('NRestarts'), '0');
    assert.equal(unit('ExecMainStatus'), '2');
    exec(server, 'cp /root/env.bak /etc/glimt-agent/env && systemctl restart glimt-agent');
    await waitFor('active igjen', () => unit('ActiveState') === 'active', 20_000);
  });

  it('en ny installasjon uten --key beholder tokenet', async () => {
    const connects = () => [...journal().matchAll(/msg=connected .*auth=(\w+)/g)].map((m) => m[1]);
    const earlier = connects().length;
    const again = exec(server, 'curl -fsSL http://hub:8080/install | sh -s --');
    assert.equal(again.status, 0, again.out);
    await waitFor('active', () => unit('ActiveState') === 'active', 20_000);
    await waitFor('ny tilkobling etter reinstallasjon', () => connects().length > earlier, 30_000);
    assert.equal(connects().at(-1), 'token');
  });

  it('glimt-agent uninstall fjerner alt og huben ser den forsvinne', async () => {
    const uninstall = exec(server, 'glimt-agent uninstall');
    assert.equal(uninstall.status, 0, uninstall.out);
    assert.equal(exec(server, 'ls -d /usr/local/bin/glimt-agent /etc/glimt-agent /etc/systemd/system/glimt-agent.service /var/lib/glimt-agent 2>/dev/null | wc -l').out, '0');
    assert.notEqual(exec(server, 'id glimt-agent').status, 0, 'systembrukeren finnes fortsatt');
    await waitFor('huben uten agenter', async () => (await http(`${hub.url}/healthz`)).json().agentsConnected === 0, 30_000);
  });
});
