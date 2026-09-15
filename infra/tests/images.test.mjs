// Imagene i infra/ slik Dokploy kjører dem: hub, web og site for prod og dev med env-filene (de ekte lokalt, en
// testversjon i CI), mot en egen mongo. Sjekker hele kjeden fra DOCKPLOY.md § 6 og det som bare syns bak en proxy.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  FAST_HEALTH, Stack, agentWsUrl, buildImage, docker, envFileFor, http, inspect, logs, repoRoot, startMongo, tryDocker, waitFor,
} from './docker.mjs';

const images = {};
before(() => {
  for (const app of ['hub', 'web', 'site']) images[app] = buildImage(app);
});

it('env-filer i infra/ havner aldri i byggekonteksten', () => {
  // En lokkefil på dypeste nivå; .dockerignore må holde den ute, ellers feiler RUN-linjen.
  const decoy = path.join(repoRoot, 'infra', 'glimt-site', '.env.testdecoy');
  fs.writeFileSync(decoy, 'SECRET=should-never-reach-an-image\n');
  try {
    const dockerfile = 'FROM public.ecr.aws/docker/library/busybox:latest\nCOPY infra /i\nRUN test -z "$(find /i -name \'.env*\')"\n';
    const r = tryDocker(['build', '--no-cache', '-q', '-f', '-', '.'], { input: dockerfile });
    assert.equal(r.status, 0, `en env-fil kom med i byggekonteksten:\n${r.stderr}`);
  } finally {
    fs.rmSync(decoy, { force: true });
  }
});

/** Testverdiene når infra/<app>/.env.<env> ikke finnes (CI). Samme nøkler som filene DOCKPLOY.md beskriver. */
function fallbackEnv(env) {
  const host = env === 'prod' ? 'example.test' : 'dev.example.test';
  const shared = { GLIMT_ENV: 'production', GLIMT_HUB_PUBLIC_URL: `https://api.${host}`, GLIMT_INSTALL_URL: `https://get.${host}/install` };
  return {
    hub: {
      ...shared, GLIMT_MONGO_URI: 'mongodb://unused', GLIMT_MONGO_DB: `GlimtpanelTest${env}`, GLIMT_JWT_SECRET: randomBytes(48).toString('base64'),
      GLIMT_WEB_PUBLIC_URL: `https://app.${host}`, GLIMT_DEMO_MODE: 'true', GLIMT_AGENT_VERSION: '0.1.0', GLIMT_UNLIMITED_EMAILS: `owner@${host}`,
    },
    web: { ...shared, GLIMT_HUB_INTERNAL_URL: 'http://unused:8080', GLIMT_DEFAULT_LANG: 'en' },
    site: {},
  };
}

// Aldri ekte e-post, aldri en agent mot en ekte hub, aldri den ekte databasen – uansett hva env-filene inneholder.
const SAFE = { GLIMT_TOKEN: '', GLIMT_HUB: '' };

for (const env of ['prod', 'dev']) {
  describe(`stack ${env}`, () => {
    let stack, hub, web, site, hubEnv, webEnv;

    before(async () => {
      const fallback = fallbackEnv(env);
      hubEnv = envFileFor('hub', env, fallback.hub);
      webEnv = envFileFor('web', env, fallback.web);
      const siteEnv = envFileFor('site', env, fallback.site);
      stack = new Stack(`images-${env}`);
      await startMongo(stack);
      hub = stack.run('hub', images.hub, {
        envFile: hubEnv.path, port: 8080, args: FAST_HEALTH,
        env: { ...SAFE, GLIMT_MONGO_URI: 'mongodb://mongo:27017', GLIMT_APPMAIL_URL: '', GLIMT_APPMAIL_API_KEY: '' },
      });
      web = stack.run('web', images.web, { envFile: webEnv.path, port: 80, args: FAST_HEALTH, env: { ...SAFE, GLIMT_HUB_INTERNAL_URL: 'http://hub:8080' } });
      site = stack.run('site', images.site, { envFile: siteEnv.path, port: 80, args: FAST_HEALTH, env: SAFE });
      await waitFor('hub /readyz', async () => (await http(`${hub.url}/readyz`)).status === 200, 90_000);
      await waitFor('web', async () => (await http(`${web.url}/config.json`)).status === 200);
    });

    after(() => stack?.stop());

    it('env-filene har det huben krever og henger sammen med web', () => {
      for (const key of ['GLIMT_MONGO_URI', 'GLIMT_MONGO_DB', 'GLIMT_JWT_SECRET', 'GLIMT_HUB_PUBLIC_URL', 'GLIMT_WEB_PUBLIC_URL', 'GLIMT_INSTALL_URL', 'GLIMT_UNLIMITED_EMAILS']) {
        assert.ok(hubEnv.values[key], `${key} mangler i hub-filen for ${env}`);
      }
      assert.equal(hubEnv.values.GLIMT_ENV, 'production', 'også dev skal kjøre production (development åpner /api/dev/token)');
      assert.equal(webEnv.values.GLIMT_HUB_PUBLIC_URL, hubEnv.values.GLIMT_HUB_PUBLIC_URL);
      assert.equal(webEnv.values.GLIMT_INSTALL_URL, hubEnv.values.GLIMT_INSTALL_URL);
      assert.equal(webEnv.values.GLIMT_VAPID_PUBLIC ?? '', hubEnv.values.GLIMT_VAPID_PUBLIC ?? '', 'VAPID-nøkkelen må være lik i hub og web');
      assert.doesNotMatch(hubEnv.values.GLIMT_MONGO_URI, /\/\/root:|authMechanism=DEFAULT/, 'hub-filen skal ha en egen databasebruker, ikke root');
    });

    it('huben starter i produksjon med database og uten dev-endepunkter', async () => {
      assert.doesNotMatch(logs(hub), /Invalid hub configuration/);
      const health = (await http(`${hub.url}/healthz`)).json();
      assert.equal(health.env, 'production');
      assert.equal(health.mongo, 'ok');
      assert.equal((await http(`${hub.url}/api/dev/token`, { method: 'POST', json: { email: 'x@example.test' } })).status, 404);
    });

    it('/install gir agentene hubens offentlige adresse og versjonen fra miljøet', async () => {
      const script = (await http(`${hub.url}/install`)).text;
      assert.ok(script.includes(`hub="${agentWsUrl(hubEnv.values.GLIMT_HUB_PUBLIC_URL)}"`), 'hub-linjen i install.sh');
      assert.ok(script.includes(`version="\${GLIMT_AGENT_VERSION:-${hubEnv.values.GLIMT_AGENT_VERSION ?? 'latest'}}"`), 'versjonslinjen i install.sh');
      assert.match(script, /echo "GLIMT_KIND=server"/);
    });

    it('web skriver config.json fra miljøet og sender /api og /hub til huben', async () => {
      const config = (await http(`${web.url}/config.json`)).json();
      assert.equal(config.env, 'production');
      assert.equal(config.hubPublicUrl, webEnv.values.GLIMT_HUB_PUBLIC_URL);
      assert.equal(config.installUrl, webEnv.values.GLIMT_INSTALL_URL);
      assert.equal(config.vapidPublic, webEnv.values.GLIMT_VAPID_PUBLIC ?? '');
      assert.equal((await http(`${web.url}/api/auth/refresh`, { method: 'POST' })).status, 401, '/api når huben');
      assert.equal((await http(`${web.url}/hub/live/negotiate?negotiateVersion=1`, { method: 'POST' })).status, 401, '/hub når huben');
    });

    it('web har sikkerhetshodene og SPA-fallback, site svarer', async () => {
      const page = await http(`${web.url}/servers/some-id`);
      assert.equal(page.status, 200);
      assert.match(page.text, /<gp-root/);
      for (const h of ['content-security-policy', 'strict-transport-security', 'x-content-type-options']) assert.ok(page.headers.get(h), `${h} mangler`);
      assert.equal((await http(`${site.url}/`)).status, 200);
    });

    it('bak TLS-proxyen får kaken Secure, klient-IP-en når huben, og ubegrensede adresser betaler aldri', async () => {
      const unlimited = hubEnv.values.GLIMT_UNLIMITED_EMAILS.split(',')[0].trim();
      const register = async (email, headers = {}) => {
        const r = await http(`${web.url}/api/auth/register`, { method: 'POST', headers, json: { email, password: 'Container-test-2026!', name: 'Test' } });
        assert.equal(r.status, 201, `registrering av ${email}: ${r.text}`);
        // Uten appmail logges e-posten: «e-mail to <adresse>: <emne> … /confirm?token=…» på samme logglinje.
        const mail = new RegExp(`e-mail to ${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*?confirm\\?token=([A-Za-z0-9_-]+)`, 'i');
        const token = await waitFor(`bekreftelse til ${email}`, () => logs(hub).match(mail)?.[1]);
        const confirm = await http(`${web.url}/api/auth/confirm`, { method: 'POST', headers, json: { token } });
        assert.equal(confirm.status, 200, confirm.text);
        const cookie = confirm.headers.getSetCookie().find((c) => c.startsWith('glimt_refresh=')) ?? '';
        const subscription = (await http(`${web.url}/api/subscription`, { headers: { authorization: `Bearer ${confirm.json().accessToken}` } })).json();
        return { cookie, subscription };
      };

      const viaTls = await register(unlimited, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' });
      assert.match(viaTls.cookie, /;\s*secure/i, 'X-Forwarded-Proto: https skal gi Secure');
      assert.equal(viaTls.subscription.plan, 'unlimited');
      assert.equal(viaTls.subscription.slotsBeta, 0);
      assert.equal(viaTls.subscription.wouldCostUsd, 0);

      const plain = await register(`user-${randomBytes(3).toString('hex')}@example.test`);
      assert.doesNotMatch(plain.cookie, /;\s*secure/i);
      assert.equal(plain.subscription.plan, 'beta');

      await http(`${web.url}/api/client-errors`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.23' }, json: { message: 'container test' } });
      await waitFor('klient-IP i hubens logg', () => logs(hub).includes('198.51.100.23'));
    });

    it('Docker-helsesjekken blir frisk for hub, web og site', async () => {
      for (const c of [hub, web, site]) {
        await waitFor(`${c.alias} healthy`, () => inspect(c, '{{.State.Health.Status}}') === 'healthy', 60_000);
      }
    });

    it('stopp gir kode 0, og huben lagrer bufferen først', () => {
      for (const c of [hub, web, site]) {
        docker(['stop', c.name]);
        assert.equal(inspect(c, '{{.State.ExitCode}}'), '0', `${c.alias} avsluttet ikke rent`);
      }
      assert.match(logs(hub), /buffer saved/);
    });
  });
}
