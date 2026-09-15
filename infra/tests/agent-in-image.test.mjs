// Agenten innebygd i hub-, web- og site-imagene: uten GLIMT_TOKEN kjører appen alene, med token vises appen som
// containernode i et dashbord (en egen hub i e2e-modus) med ekte cgroup-tall, og appen er fortsatt PID 1.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Stack, buildImage, docker, exec, http, inspect, logs, startMongo, waitFor } from './docker.mjs';

const APPS = { hub: { port: 8080, pid1: 'dotnet' }, web: { port: 80, pid1: 'nginx' }, site: { port: 80, pid1: 'nginx' } };

describe('agenten i imagene', () => {
  let stack, dash, jwt;
  const images = {};

  before(async () => {
    for (const app of Object.keys(APPS)) images[app] = buildImage(app);
    stack = new Stack('agent-in-image');
    await startMongo(stack);
    dash = stack.run('dash', images.hub, {
      port: 8080,
      env: {
        GLIMT_ENV: 'e2e', GLIMT_MONGO_URI: 'mongodb://mongo:27017', GLIMT_MONGO_DB: 'Dashboard', GLIMT_JWT_SECRET: randomBytes(32).toString('hex'),
        GLIMT_DEV_USER_EMAIL: 'dev@glimtpanel.local', GLIMT_DEV_USER_PASSWORD: 'Container-test-2026!',
      },
    });
    await waitFor('dashbord-huben', async () => (await http(`${dash.url}/readyz`)).status === 200, 90_000);
    jwt = await waitFor('dev-token', async () => (await http(`${dash.url}/api/dev/token`, { method: 'POST', json: { email: 'dev@glimtpanel.local' } })).json().accessToken);
  });

  after(() => stack?.stop());

  /** Appens eget miljø: huben trenger en database, web en hub å sende /api til, site ingenting. */
  const appEnv = (app) => ({
    hub: { GLIMT_ENV: 'production', GLIMT_MONGO_URI: 'mongodb://mongo:27017', GLIMT_MONGO_DB: 'App', GLIMT_JWT_SECRET: randomBytes(32).toString('hex') },
    web: { GLIMT_HUB_INTERNAL_URL: 'http://dash:8080' },
    site: {},
  })[app];

  const processes = (c) => exec(c, 'for p in /proc/[0-9]*; do cat $p/comm 2>/dev/null; done').out.split('\n');

  it('uten GLIMT_TOKEN kjører appen alene som PID 1', async () => {
    for (const [app, { port, pid1 }] of Object.entries(APPS)) {
      const c = stack.run(`${app}-alone`, images[app], { port, env: appEnv(app) });
      try {
        await waitFor(`${app} svarer`, async () => (await http(`${c.url}/${app === 'hub' ? 'healthz' : ''}`)).status === 200);
        assert.equal(exec(c, 'cat /proc/1/comm').out, pid1);
        assert.ok(!processes(c).includes('glimt-agent'), `${app}: agenten startet uten token`);
      } finally {
        stack.remove(c);
      }
    }
  });

  it('med GLIMT_TOKEN vises hver app som containernode med ekte tall, og appen svarer som før', async () => {
    const nodes = {};
    for (const [app, { port }] of Object.entries(APPS)) {
      const name = `glimt-${app}-test`;
      const created = await http(`${dash.url}/api/servers`, { method: 'POST', headers: { authorization: `Bearer ${jwt}` }, json: { kind: 'container', name } });
      assert.equal(created.status, 200, created.text);
      const { id, token } = created.json();
      nodes[app] = {
        id,
        c: stack.run(`${app}-agent`, images[app], {
          port,
          env: { ...appEnv(app), GLIMT_HUB: 'ws://dash:8080/agent/ws', GLIMT_TOKEN: token, GLIMT_NODE_NAME: name, GLIMT_HEALTH_URL: `http://127.0.0.1:${port}/` },
        }),
      };
    }

    await waitFor('alle tre noder up i dashbordet', async () => {
      const servers = (await http(`${dash.url}/api/servers`, { headers: { authorization: `Bearer ${jwt}` } })).json();
      return Object.values(nodes).every(({ id }) => servers.some((s) => s.id === id && s.kind === 'container' && s.status === 'up'));
    }, 60_000);

    for (const [app, { pid1 }] of Object.entries(APPS)) {
      const { c } = nodes[app];
      assert.match(logs(c), /msg="container profile" cgroup=true/, `${app}: agenten fikk ikke containerens cgroup`);
      assert.equal(exec(c, 'cat /proc/1/comm').out, pid1, `${app}: appen er ikke lenger PID 1`);
      assert.ok(processes(c).includes('glimt-agent'));
      // Agenten melder seg ofte før nginx eller Kestrel lytter, så appen får tid til å starte.
      await waitFor(`${app} svarer med agenten ved siden av`, async () => (await http(`${c.url}/${app === 'hub' ? 'healthz' : ''}`)).status === 200);
    }

    for (const { c } of Object.values(nodes)) {
      docker(['stop', c.name]);
      assert.equal(inspect(c, '{{.State.ExitCode}}'), '0', `${c.alias} avsluttet ikke rent med agenten`);
    }
  });
});
